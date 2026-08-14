import PurchaseOrder from '../models/purchaseOrder.model.js';
import { uploadImageToLocalStorage } from '../utils/localStorageUtils.js';
import { scheduleStockInwardAlert } from '../services/stockWhatsappAlert.service.js';
import { canPurchaseOrderAutoAccept } from '../utils/purchaseOrderAccess.js';

function parseBodyJson(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

async function uploadSupplierInvoiceFile(file) {
  if (!file?.buffer) return null;
  const uploaded = await uploadImageToLocalStorage(
    file.buffer,
    `purchase-orders/invoices/${Date.now()}`,
    { mimetype: file.mimetype }
  );
  if (!uploaded?.success || !uploaded.url) {
    throw new Error(uploaded?.error || 'Failed to upload supplier invoice file');
  }
  return {
    url: uploaded.url,
    originalName: file.originalname || '',
    mimeType: file.mimetype || '',
    uploadedAt: new Date(),
  };
}

function isAutoGRNEnabled(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function hasValidExpiryDate(value) {
  if (value == null || value === '') return false;
  const d = value instanceof Date ? value : new Date(value);
  return !Number.isNaN(d.getTime());
}

/** Every PO line must have a usable expiry date. */
function validateItemsExpiry(items) {
  if (!Array.isArray(items) || !items.length) return null;
  for (let i = 0; i < items.length; i++) {
    if (!hasValidExpiryDate(items[i]?.expiryDate)) {
      return `Expiry date is required on every line (missing on line ${i + 1})`;
    }
  }
  return null;
}

// Create Purchase Order
export const createPurchaseOrder = async (req, res) => {
  try {
    const {
      supplier,
      poDate,
      expectedDeliveryDate,
      otherCharges,
      terms,
      notes,
      supplierInvoiceNumber,
      autoGRN, // Auto GRN flag
    } = req.body;

    const items = parseBodyJson(req.body.items, req.body.items);
    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({
        success: false,
        message: 'At least one purchase order item is required',
      });
    }

    const expiryError = validateItemsExpiry(items);
    if (expiryError) {
      return res.status(400).json({
        success: false,
        message: expiryError,
      });
    }

    const wantsAutoGRN = isAutoGRNEnabled(autoGRN);
    const canAutoAccept = canPurchaseOrderAutoAccept(req.user);
    if (wantsAutoGRN && !canAutoAccept) {
      return res.status(403).json({
        success: false,
        message:
          'Auto GRN / auto-approve is only available for Super Admin, Ram Agri Master, or Ram Agri Sales Manager',
      });
    }
    const isAutoGRN = wantsAutoGRN && canAutoAccept;

    const invoiceNo = String(supplierInvoiceNumber || '').trim();
    if (isAutoGRN && !invoiceNo) {
      return res.status(400).json({
        success: false,
        message: 'Supplier invoice number is required when Auto GRN is enabled',
      });
    }

    let supplierInvoiceFile = null;
    if (req.file) {
      try {
        supplierInvoiceFile = await uploadSupplierInvoiceFile(req.file);
      } catch (uploadErr) {
        return res.status(400).json({
          success: false,
          message: uploadErr.message || 'Supplier invoice upload failed',
        });
      }
    }
    if (isAutoGRN && !supplierInvoiceFile?.url) {
      return res.status(400).json({
        success: false,
        message: 'Supplier invoice file is required when Auto GRN is enabled (JPG/PNG/WEBP/PDF)',
      });
    }

    // Generate PO number
    const poNumber = await PurchaseOrder.generatePONumber();

    // Calculate totals
    let subtotal = 0;
    let gstAmount = 0;
    let discountAmount = 0;

    items.forEach((item) => {
      const itemSubtotal = item.quantity * item.rate;
      const itemDiscount = (itemSubtotal * (item.discount || 0)) / 100;
      const itemGst = ((itemSubtotal - itemDiscount) * (item.gst || 0)) / 100;
      
      item.amount = itemSubtotal - itemDiscount + itemGst;
      subtotal += itemSubtotal;
      gstAmount += itemGst;
      discountAmount += itemDiscount;
    });

    const totalAmount = subtotal - discountAmount + gstAmount + (otherCharges || 0);

    const purchaseOrder = new PurchaseOrder({
      poNumber,
      supplier,
      poDate: poDate || new Date(),
      expectedDeliveryDate,
      items,
      subtotal,
      gstAmount,
      discountAmount,
      otherCharges: otherCharges || 0,
      totalAmount,
      terms,
      notes,
      supplierInvoiceNumber: invoiceNo || undefined,
      supplierInvoiceFile: supplierInvoiceFile || undefined,
      autoGRN: isAutoGRN,
      createdBy: req.user._id,
    });

    await purchaseOrder.save();
    console.log('💾 Purchase Order saved with autoGRN:', purchaseOrder.autoGRN);
    
    // IMPORTANT: Process ready plants BEFORE populate, as populate converts product to object
    // Create new product and PlantProductMapping for ready plants products
    try {
      const PlantProductMapping = (await import('../models/plantProductMapping.model.js')).default;
      const { default: Product } = await import('../models/product.model.js');
      const { default: MeasurementUnit } = await import('../models/measurementUnit.model.js');
      
      // Process items from the purchaseOrder object (before populate)
      for (const poItem of purchaseOrder.items) {
        // Debug log
        console.log(`🔍 Processing PO item for ready plants:`, {
          isReadyPlantsProduct: poItem.isReadyPlantsProduct,
          hasPlantId: !!poItem.plantId,
          hasSubtypeId: !!poItem.subtypeId,
          hasDateRange: !!poItem.dateRange,
          hasDisplayTitle: !!poItem.displayTitle,
          productId: poItem.product,
          dateRange: poItem.dateRange
        });
        
        // Check if all required fields are present
        const hasAllFields = poItem.isReadyPlantsProduct && 
                            poItem.plantId && 
                            poItem.subtypeId && 
                            poItem.dateRange && 
                            poItem.dateRange.startDate && 
                            poItem.dateRange.endDate && 
                            poItem.displayTitle;
        
        if (!hasAllFields) {
          console.log(`⏭️ Skipping PO item - missing required fields`);
          continue;
        }
        
        if (poItem.isReadyPlantsProduct && poItem.plantId && poItem.subtypeId && poItem.dateRange && poItem.dateRange.startDate && poItem.dateRange.endDate && poItem.displayTitle) {
          try {
            // Helper function to check if category is ready plants
            const isReadyPlantsCategory = (category) => {
              if (!category) return false;
              const normalized = category.toLowerCase().trim().replace(/_/g, ' ');
              return normalized === 'ready plants';
            };
            
            // Step 1: Check if product already exists and is ready_plants category
            let readyPlantsProduct = null;
            if (poItem.product) {
              // Product ID is provided - check if it's already a ready_plants product
              const existingProduct = await Product.findById(poItem.product);
              if (existingProduct) {
                if (isReadyPlantsCategory(existingProduct.category)) {
                  // Use existing ready_plants product
                  readyPlantsProduct = existingProduct;
                  console.log(`✅ Using existing ready plants product: ${existingProduct.code} - ${existingProduct.name}`);
                } else {
                  // Product exists but is not ready_plants category - this shouldn't happen if frontend is correct
                  console.warn(`⚠️ Product ${existingProduct.code} is not ready_plants category, but isReadyPlantsProduct is true`);
                }
              }
            }
            
            // Step 2: If no existing ready_plants product, create a new one
            if (!readyPlantsProduct) {
              // Generate product code
              const productCount = await Product.countDocuments();
              const productCode = `RPL${String(productCount + 1).padStart(6, '0')}`; // Ready Plants Product code
              
              // Check if product with this code already exists (unlikely but safe)
              readyPlantsProduct = await Product.findOne({ code: productCode });
              
              if (!readyPlantsProduct) {
                // Get default unit (Piece) for ready plants products
                let defaultUnit = await MeasurementUnit.findOne({ 
                  $or: [
                    { name: 'Piece', type: 'quantity' },
                    { abbreviation: 'pcs', type: 'quantity' },
                    { abbreviation: 'Pc', type: 'quantity' }
                  ],
                  isActive: true
                });
                
                // If Piece unit not found, get first available quantity unit
                if (!defaultUnit) {
                  defaultUnit = await MeasurementUnit.findOne({ 
                    type: 'quantity',
                    isActive: true
                  });
                }
                
                if (!defaultUnit) {
                  throw new Error('No measurement unit found. Please create a "Piece" unit first.');
                }
                
                // Create new product with category "ready plants"
                readyPlantsProduct = await Product.create({
                  code: productCode,
                  name: poItem.displayTitle, // Use display title as product name
                  description: `Ready plants product for ${poItem.displayTitle}`,
                  category: 'ready plants', // New category for ready plants
                  primaryUnit: defaultUnit._id,
                  plantId: poItem.plantId,
                  subtypeId: poItem.subtypeId,
                  purpose: 'sales',
                  createdBy: req.user._id,
                });
                
                console.log(`✅ Created new ready plants product: ${productCode} - ${poItem.displayTitle}`);
              }
              
              // Update PO item to use the new/created product
              poItem.product = readyPlantsProduct._id;
              await purchaseOrder.save();
            }
            
            // Step 3: Check if mapping already exists
            console.log(`🔍 Checking for existing mapping:`, {
              productId: readyPlantsProduct._id,
              plantId: poItem.plantId,
              subtypeId: poItem.subtypeId,
              dateRange: poItem.dateRange
            });
            
            // Check for existing mapping with EXACT date range match
            const existingMapping = await PlantProductMapping.findOne({
              productId: readyPlantsProduct._id,
              plantId: poItem.plantId,
              subtypeId: poItem.subtypeId,
              isActive: true,
              // Check for exact date range match
              'dateRange.startDate': poItem.dateRange.startDate,
              'dateRange.endDate': poItem.dateRange.endDate,
            });

            let mapping;
            if (existingMapping) {
              // Update existing mapping - add to totalQuantity
              existingMapping.displayTitle = poItem.displayTitle;
              existingMapping.dateRange = poItem.dateRange;
              existingMapping.totalQuantity = (existingMapping.totalQuantity || 0) + poItem.quantity; // Add new quantity to existing
              existingMapping.updatedBy = req.user._id;
              await existingMapping.save();
              mapping = existingMapping;
              console.log(`✅ Updated existing PlantProductMapping for product ${readyPlantsProduct._id} - totalQuantity: ${existingMapping.totalQuantity} (added ${poItem.quantity})`);
            } else {
              // Create new mapping
              console.log(`📝 Creating new PlantProductMapping with data:`, {
                productId: readyPlantsProduct._id,
                plantId: poItem.plantId,
                subtypeId: poItem.subtypeId,
                dateRange: poItem.dateRange,
                displayTitle: poItem.displayTitle,
                totalQuantity: poItem.quantity,
                createdBy: req.user._id
              });
              
              mapping = await PlantProductMapping.create({
                productId: readyPlantsProduct._id,
                plantId: poItem.plantId,
                subtypeId: poItem.subtypeId,
                dateRange: poItem.dateRange,
                displayTitle: poItem.displayTitle,
                totalQuantity: poItem.quantity, // Initial stock from PO
                allocatedQuantity: 0, // Will be updated when orders are placed
                createdBy: req.user._id,
              });
              console.log(`✅ Created PlantProductMapping ${mapping._id} for product ${readyPlantsProduct._id} with totalQuantity: ${poItem.quantity}`);
            }

            // Store mapping ID in PO item for reference
            // Update the item directly in purchaseOrder.items array
            const itemIndex = purchaseOrder.items.findIndex(item => {
              // Compare by _id if available, or by position
              if (item._id && poItem._id) {
                return item._id.toString() === poItem._id.toString();
              }
              return purchaseOrder.items.indexOf(item) === purchaseOrder.items.indexOf(poItem);
            });
            
            if (itemIndex !== -1) {
              purchaseOrder.items[itemIndex].plantProductMappingId = mapping._id;
              // Mark the array as modified
              purchaseOrder.markModified('items');
              await purchaseOrder.save();
              console.log(`✅ Stored plantProductMappingId ${mapping._id} in PO item`);
            } else {
              console.warn(`⚠️ Could not find PO item to update with mapping ID`);
            }
          } catch (mappingError) {
            console.error(`❌ Error creating/updating ready plants product and mapping:`, mappingError);
            console.error(`   Error stack:`, mappingError.stack);
            console.error(`   PO Item data:`, {
              isReadyPlantsProduct: poItem.isReadyPlantsProduct,
              plantId: poItem.plantId,
              subtypeId: poItem.subtypeId,
              dateRange: poItem.dateRange,
              displayTitle: poItem.displayTitle,
              product: poItem.product
            });
            // Don't fail PO creation if product/mapping creation fails
          }
        }
      }
    } catch (error) {
      console.error('❌ Error processing ready plants products:', error);
      console.error('   Error stack:', error.stack);
      // Don't fail PO creation if mapping processing fails
    }

    // Now populate for response
    await purchaseOrder.populate(['items.product', 'items.unit', 'createdBy']);

    // Initialize productStock in slots for plant products
    try {
      const { default: PlantSlot } = await import('../models/slots.model.js');
      const { default: Product } = await import('../models/product.model.js');
      const mongoose = await import('mongoose');
      
      for (const poItem of purchaseOrder.items) {
        // Check if this is a plant product with slotId and productName
        // After populate, product is already an object
        const product = poItem.product;
        
        console.log(`🔍 PO Item Debug:`, {
          hasProduct: !!product,
          productType: typeof product,
          productIsObject: typeof product === 'object',
          productCategory: product?.category,
          slotId: poItem.slotId,
          productName: poItem.productName,
          quantity: poItem.quantity
        });
        
        // Check if product is populated (has category) or if we need to fetch it
        let productCategory = null;
        if (product) {
          if (typeof product === 'object' && product.category) {
            // Product is populated - use it directly
            productCategory = product.category;
            console.log(`✅ Product is populated, category: ${productCategory}`);
          } else {
            // Product is just an ID - fetch it
            console.log(`⚠️ Product is not populated, fetching...`);
            const fetchedProduct = await Product.findById(product);
            productCategory = fetchedProduct?.category;
            console.log(`✅ Fetched product, category: ${productCategory}`);
          }
        } else {
          console.log(`❌ No product found in PO item`);
        }
        
        console.log(`🔍 Final check: productCategory=${productCategory}, slotId=${poItem.slotId}, productName=${poItem.productName}, isReadyPlants=${poItem.isReadyPlantsProduct}`);
        
        // Handle both regular plants and ready plants products
        // For ready plants, productName comes from displayTitle if not provided
        // Note: slotId is optional for ready plants products - productStock can be initialized later during GRN
        const productNameForStock = poItem.productName || poItem.displayTitle;
        
        // Helper function to check if category is ready plants (handles both 'ready plants' and 'ready_plants')
        const isReadyPlantsCategory = (category) => {
          if (!category) return false;
          const normalized = category.toLowerCase().trim().replace(/_/g, ' ');
          return normalized === 'ready plants';
        };
        
        // Initialize productStock only in the specific slot when slotId is provided
        // For ready plants products, slotId should be provided or stock will be initialized when booking happens
        const shouldInitializeProductStock = 
          (productCategory === 'plants' || isReadyPlantsCategory(productCategory) || poItem.isReadyPlantsProduct) &&
          poItem.slotId && // slotId is required to initialize productStock
          productNameForStock;
        
        if (shouldInitializeProductStock) {
            // For regular plants: Initialize in specific slot
            console.log(`🌱 Initializing productStock for "${productNameForStock}" in slot ${poItem.slotId}`);
            
            let slotObjectId;
            try {
              slotObjectId = typeof poItem.slotId === 'string' 
                ? new mongoose.default.Types.ObjectId(poItem.slotId)
                : poItem.slotId;
            } catch (e) {
              console.error(`❌ Invalid slotId format: ${poItem.slotId}`, e);
              continue;
            }
            
            const slotDoc = await PlantSlot.findOne({
              "subtypeSlots.slots._id": slotObjectId
            });
            
            if (!slotDoc) {
              console.warn(`⚠️ Slot ${poItem.slotId} not found for productStock initialization`);
              continue;
            }
            
            // Find the slot in the document and update productStock
            let slotFound = false;
            for (const subtypeSlot of slotDoc.subtypeSlots || []) {
              const slot = subtypeSlot.slots.find(s => s._id && s._id.toString() === slotObjectId.toString());
              if (slot) {
                slotFound = true;
                // Initialize productStock array if it doesn't exist
                if (!slot.productStock) {
                  slot.productStock = [];
                }
                
                // Find existing productStock entry - match by productName or productMappingId for ready plants
                let productStock = null;
                if (poItem.isReadyPlantsProduct && poItem.plantProductMappingId) {
                  productStock = slot.productStock.find(ps => 
                    ps.productMappingId && ps.productMappingId.toString() === poItem.plantProductMappingId.toString()
                  );
                }
                if (!productStock) {
                  productStock = slot.productStock.find(ps => ps.productName === productNameForStock);
                }
                
                if (!productStock) {
                  // Create new entry
                  const newProductStock = {
                    productName: productNameForStock,
                    available: 0,
                    booked: 0,
                    poQuantity: poItem.quantity,
                    received: false
                  };

                  // Add ready plants fields if applicable
                  if (poItem.isReadyPlantsProduct && poItem.dateRange) {
                    newProductStock.startDate = poItem.dateRange.startDate;
                    newProductStock.endDate = poItem.dateRange.endDate;
                    newProductStock.displayTitle = poItem.displayTitle;
                    if (poItem.plantProductMappingId) {
                      newProductStock.productMappingId = poItem.plantProductMappingId;
                    }
                  }

                  slot.productStock.push(newProductStock);
                  console.log(`✅ Created productStock entry for "${newProductStock.productName}" with poQuantity: ${poItem.quantity}`);
                } else {
                  // Update existing entry - accumulate poQuantity
                  productStock.poQuantity = (productStock.poQuantity || 0) + poItem.quantity;
                  
                  // Update ready plants fields if applicable
                  if (poItem.isReadyPlantsProduct && poItem.dateRange) {
                    productStock.startDate = poItem.dateRange.startDate;
                    productStock.endDate = poItem.dateRange.endDate;
                    productStock.displayTitle = poItem.displayTitle;
                    if (poItem.plantProductMappingId) {
                      productStock.productMappingId = poItem.plantProductMappingId;
                    }
                  }
                  
                  console.log(`✅ Updated productStock entry for "${productNameForStock}" - poQuantity: ${productStock.poQuantity}`);
                }
                
                // Mark the nested path as modified
                slotDoc.markModified(`subtypeSlots.${slotDoc.subtypeSlots.indexOf(subtypeSlot)}.slots`);
                
                // Save with validation disabled to avoid errors from other slots
                await slotDoc.save({ validateBeforeSave: false });
                const productNameForLog = poItem.productName || poItem.displayTitle || 'Unknown Product';
                console.log(`✅ ProductStock updated for "${productNameForLog}" in slot ${poItem.slotId || 'N/A'}`);
                break;
              }
            }
            
            if (!slotFound) {
              console.warn(`⚠️ Slot ${poItem.slotId} not found in document structure`);
            }
        } else if (poItem.isReadyPlantsProduct && !poItem.slotId) {
          // For ready plants products without slotId, productStock will be initialized when booking happens
          console.log(`ℹ️ Ready plants product "${productNameForStock}" - productStock will be initialized when order is booked in a specific slot`);
        }
      }
    } catch (error) {
      console.error('❌ Error initializing productStock:', error);
      // Don't fail PO creation if productStock update fails
    }

    // Handle supplier/merchant population - try Supplier first, then Merchant
    // Note: supplier field contains ObjectId (or string representation), not populated yet
    let supplierId = purchaseOrder.supplier;
    
    // Convert to string if it's an ObjectId
    if (supplierId) {
      if (typeof supplierId !== 'string' && supplierId.toString) {
        supplierId = supplierId.toString();
      } else if (typeof supplierId === 'object' && supplierId._id) {
        supplierId = supplierId._id.toString();
      }
      
      // Import both models
      const { default: Merchant } = await import('../models/merchant.model.js');
      const { default: Supplier } = await import('../models/supplier.model.js');
      
      // Try Supplier first
      const supplierDoc = await Supplier.findById(supplierId);
      if (supplierDoc) {
        purchaseOrder.supplier = supplierDoc.toObject ? supplierDoc.toObject() : supplierDoc;
      } else {
        // Try Merchant (since supplier field can contain merchant ID)
        const merchant = await Merchant.findById(supplierId);
        if (merchant) {
          purchaseOrder.supplier = {
            _id: merchant._id,
            name: merchant.name,
            phone: merchant.phone,
            email: merchant.email,
            address: merchant.address,
            gstin: merchant.gstin,
            contactPerson: merchant.contactPerson,
            type: 'merchant',
            category: merchant.category,
          };
        } else {
          // If neither found, keep as ObjectId string
          console.log(`Warning: Supplier/Merchant not found for ID: ${supplierId}`);
          purchaseOrder.supplier = supplierId;
        }
      }
    }

    // Auto-approve and create GRN if autoGRN is enabled
    // (do not name this binding isAutoGRNEnabled — shadows helper + TDZ on create)
    const shouldRunAutoGRN =
      isAutoGRNEnabled(purchaseOrder.autoGRN) || isAutoGRNEnabled(autoGRN);
    console.log('🔍 Checking autoGRN flag:', {
      autoGRN,
      purchaseOrderAutoGRN: purchaseOrder.autoGRN,
      shouldRunAutoGRN,
    });

    if (shouldRunAutoGRN) {
      console.log('✅ Auto-GRN enabled, proceeding with auto-approval and GRN creation...');
      try {
        // First, approve the purchase order
        purchaseOrder.status = 'approved';
        purchaseOrder.approvedBy = req.user._id;
        purchaseOrder.approvedDate = new Date();
        purchaseOrder.updatedBy = req.user._id;
        await purchaseOrder.save();
        console.log(`✅ Purchase Order ${purchaseOrder.poNumber} auto-approved`);

        // Create GRN directly using the same logic as GRN controller
        const { default: GRN } = await import('../models/grn.model.js');
        const { default: Product } = await import('../models/product.model.js');
        
        // Helper function to generate batch number (same as in grn.controller.js)
        const generateBatchNumber = async (productId) => {
          const product = await Product.findById(productId);
          const productName = product?.name || 'PROD';
          const date = new Date();
          const year = date.getFullYear().toString().slice(-2);
          const month = (date.getMonth() + 1).toString().padStart(2, '0');
          const day = date.getDate().toString().padStart(2, '0');
          const productCode = productName.substring(0, 3).toUpperCase().replace(/\s/g, '');
          const random = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
          return `BATCH${productCode}${year}${month}${day}${random}`;
        };

        // Generate GRN number
        const grnNumber = await GRN.generateGRNNumber();
        console.log(`📦 Generating GRN ${grnNumber} for PO ${purchaseOrder.poNumber}`);

        // Transform PO items to GRN items (matching the exact API format from curl)
        const grnItems = await Promise.all(
          purchaseOrder.items.map(async (poItem) => {
            // Auto-generate batch number if not provided (only for non-Ram Agri products)
            let batchNumber = poItem.batchNumber || poItem.lotNumber;
            if (!poItem.isRamAgriProduct && (!batchNumber || !batchNumber.trim())) {
              batchNumber = await generateBatchNumber(poItem.product._id || poItem.product);
            }
            batchNumber = batchNumber ? batchNumber.trim() : '';

            // Convert expiryDate from string to Date if needed
            let expiryDate = poItem.expiryDate;
            if (expiryDate && typeof expiryDate === 'string') {
              expiryDate = new Date(expiryDate);
              if (isNaN(expiryDate.getTime())) {
                expiryDate = undefined;
              }
            }

            // Log slotId for debugging
            if (poItem.slotId) {
              console.log(`📦 PO Item has slotId: ${poItem.slotId} (type: ${typeof poItem.slotId})`);
            }

            // Format exactly matching the GRN API payload from curl command
            const grnItem = {
              quantity: poItem.quantity,
              unit: poItem.unit._id || poItem.unit,
              rate: poItem.rate,
              acceptedQuantity: poItem.quantity, // Accept full quantity by default
              rejectedQuantity: 0,
              damageQuantity: 0,
              amount: poItem.amount,
              expiryDate: expiryDate || undefined,
              manufactureDate: undefined,
            };
            
            // Add product and batchNumber only for non-Ram Agri products
            if (!poItem.isRamAgriProduct) {
              grnItem.product = poItem.product._id || poItem.product;
              grnItem.batchNumber = batchNumber;
            }
            
            // Add Ram Agri fields if applicable
            if (poItem.isRamAgriProduct) {
              grnItem.isRamAgriProduct = true;
              grnItem.ramAgriCropId = poItem.ramAgriCropId;
              grnItem.ramAgriVarietyId = poItem.ramAgriVarietyId;
              grnItem.ramAgriCropName = poItem.ramAgriCropName;
              grnItem.ramAgriVarietyName = poItem.ramAgriVarietyName;
              if (batchNumber) grnItem.batchNumber = batchNumber;
              // Add unit conversion fields for stock updates
              if (poItem.selectedUnitType) {
                grnItem.selectedUnitType = poItem.selectedUnitType;
              }
              if (poItem.conversionFactor) {
                grnItem.conversionFactor = poItem.conversionFactor;
              }
              console.log(`🌾 Ram Agri GRN Item: ${poItem.ramAgriCropName} - ${poItem.ramAgriVarietyName}, quantity: ${poItem.quantity}, selectedUnitType: ${poItem.selectedUnitType}, conversionFactor: ${poItem.conversionFactor}`);
            }
            
            // Add slot-related fields if applicable
            if (poItem.slotId) {
              grnItem.slotId = poItem.slotId;
            }
            if (poItem.productName) {
              grnItem.productName = poItem.productName;
            }
            // Durable link for receivedQty / ledger matching (classic + Ram Agri)
            if (poItem._id) {
              grnItem.poItem = poItem._id;
            }

            return grnItem;
          })
        );

        // Calculate totals
        let subtotal = 0;
        grnItems.forEach((item) => {
          subtotal += item.amount;
        });

        const totalAmount = subtotal + (purchaseOrder.gstAmount || 0) + (purchaseOrder.otherCharges || 0);

        // Create GRN (matching the API format from curl - no images required for auto-generated GRN)
        const grn = new GRN({
          grnNumber,
          supplier: purchaseOrder.supplier._id || purchaseOrder.supplier,
          purchaseOrder: purchaseOrder._id,
          items: grnItems,
          subtotal,
          gstAmount: purchaseOrder.gstAmount || 0,
          freightCharges: 0,
          otherCharges: purchaseOrder.otherCharges || 0,
          totalAmount,
          status: 'draft', // Start as draft, can be approved later
          notes: `Auto-generated from Purchase Order ${purchaseOrder.poNumber}`,
          createdBy: req.user._id,
        });

        await grn.save();
        console.log(`✅ GRN ${grnNumber} saved to database`);
        
        // Reload GRN to ensure items are properly structured
        const savedGRN = await GRN.findById(grn._id);
        if (!savedGRN) {
          throw new Error('Failed to retrieve saved GRN');
        }
        
        // Auto-approve GRN to update inventory immediately
        console.log(`🔄 Auto-approving GRN ${grnNumber} to update inventory...`);
        
        const { default: Batch } = await import('../models/batch.model.js');
        const { default: InventoryTransaction } = await import('../models/inventoryTransaction.model.js');
        
        // Helper function to create inventory transaction (same as in grn.controller.js)
        const createInventoryTransaction = async (item, grnDoc, user, balanceBefore, balanceAfter) => {
          try {
            const transactionNumber = await InventoryTransaction.generateTransactionNumber();
            
            const transaction = new InventoryTransaction({
              transactionNumber,
              transactionType: 'inward',
              product: item.product,
              batch: item.batch,
              quantity: item.acceptedQuantity,
              unit: item.unit,
              balanceBeforeTransaction: balanceBefore,
              balanceAfterTransaction: balanceAfter,
              rate: item.rate,
              value: item.amount,
              referenceType: 'GRN',
              referenceId: grnDoc._id,
              referenceNumber: grnDoc.grnNumber,
              toLocation: 'Main Warehouse',
              reason: 'Auto-approved GRN Entry',
              performedBy: user._id,
            });
            
            await transaction.save();
            return transaction;
          } catch (error) {
            console.error('Error creating inventory transaction:', error);
            // Don't throw - transaction creation failure shouldn't block GRN approval
            return null;
          }
        };
        
        // Process each item: create batches and update inventory
        console.log(`📦 Processing ${savedGRN.items.length} items for GRN approval...`);
        for (const item of savedGRN.items) {
          if (item.acceptedQuantity > 0) {
            // Ram Agri: create batch + sync variety stock via service
            if (item.isRamAgriProduct && item.ramAgriCropId && item.ramAgriVarietyId) {
              const { processRamAgriGrnItem } = await import('../services/ramAgriBatchInventory.service.js');
              const ramBatch = await processRamAgriGrnItem(item, savedGRN, req.user._id);
              if (ramBatch) {
                item.ramAgriBatch = ramBatch._id;
                item.batchNumber = ramBatch.batchNumber;
                console.log(`✅ Ram Agri batch ${ramBatch.batchNumber} created for ${item.ramAgriCropName} - ${item.ramAgriVarietyName}`);
                scheduleStockInwardAlert({
                  productName:
                    [item.ramAgriCropName, item.ramAgriVarietyName].filter(Boolean).join(" - ") ||
                    "Ram Agri Product",
                  quantity: item.acceptedQuantity,
                  unit: item.unit?.name || item.unit || "",
                  referenceNumber: `${purchaseOrder.poNumber} / ${savedGRN.grnNumber}`,
                  supplierName:
                    purchaseOrder.supplier?.name ||
                    purchaseOrder.supplier?.companyName ||
                    "",
                  newStock: ramBatch.remainingQuantity ?? item.acceptedQuantity,
                  performedByName: req.user?.name || "System",
                  source: "Purchase Order GRN (Ram Agri)",
                });
              }
            } else if (!item.isRamAgriProduct) {
              // Ensure batch number exists
              let batchNumber = item.batchNumber || item.lotNumber;
              if (!batchNumber || !batchNumber.trim()) {
                batchNumber = await generateBatchNumber(item.product);
              }
              batchNumber = batchNumber.trim();
              
              // Check if batch number already exists
              const existingBatch = await Batch.findOne({ batchNumber: batchNumber });
              if (existingBatch) {
                const timestamp = Date.now().toString().slice(-6);
                batchNumber = `${batchNumber}_${timestamp}`;
              }
              
              // Convert expiryDate from string to Date if needed
              let expiryDate = item.expiryDate;
              if (expiryDate && typeof expiryDate === 'string') {
                expiryDate = new Date(expiryDate);
                if (isNaN(expiryDate.getTime())) {
                  expiryDate = undefined;
                }
              }
              
              let manufactureDate = item.manufactureDate;
              if (manufactureDate && typeof manufactureDate === 'string') {
                manufactureDate = new Date(manufactureDate);
                if (isNaN(manufactureDate.getTime())) {
                  manufactureDate = undefined;
                }
              }
              
              // Create batch
              const batch = new Batch({
                batchNumber: batchNumber,
                product: item.product,
                manufactureDate: manufactureDate || undefined,
                expiryDate: expiryDate || undefined,
                receivedDate: savedGRN.grnDate,
                supplier: savedGRN.supplier,
                purchasePrice: item.rate,
                quantity: item.acceptedQuantity,
                remainingQuantity: item.acceptedQuantity,
                unit: item.unit,
                grn: savedGRN._id,
                createdBy: req.user._id,
              });
              
              await batch.save();
              
              // Update item with batch reference
              item.batch = batch._id;
              item.batchNumber = batchNumber;
            }
            
            // Regular product stock update (Ram Agri synced via batch service above)
            if (!item.isRamAgriProduct) {
              // Update regular product stock
              const product = await Product.findById(item.product);
              if (product) {
                const oldStock = product.currentStock || 0;
                
                product.currentStock = (product.currentStock || 0) + item.acceptedQuantity;
                product.stockValue = (product.stockValue || 0) + item.amount;
                
                if (product.currentStock > 0) {
                  product.averagePrice = product.stockValue / product.currentStock;
                } else {
                  product.averagePrice = 0;
                }
                
                product.updatedBy = req.user._id;
                await product.save();
                
                // Create inventory transaction
                await createInventoryTransaction(item, savedGRN, req.user, oldStock, product.currentStock);

                scheduleStockInwardAlert({
                  productName: item.productName || product.name || "Product",
                  quantity: item.acceptedQuantity,
                  unit: item.unit?.name || item.unit || "",
                  referenceNumber: `${purchaseOrder.poNumber} / ${savedGRN.grnNumber}`,
                  supplierName:
                    purchaseOrder.supplier?.name ||
                    purchaseOrder.supplier?.companyName ||
                    "",
                  newStock: product.currentStock,
                  performedByName: req.user?.name || "System",
                  source: "Purchase Order GRN",
                });
              }
              
              // Update slot availablePlants and productStock if slotId is provided (for regular products only)
              if (item.slotId) {
                try {
                  console.log(`🔄 Attempting to update slot ${item.slotId} with quantity ${item.acceptedQuantity}`);
                  if (item.productName) {
                    console.log(`📦 Product name: "${item.productName}"`);
                  }
                  const { default: PlantSlot } = await import('../models/slots.model.js');
                  const mongoose = await import('mongoose');
                  
                  // Convert slotId to ObjectId if it's a string
                  let slotObjectId;
                  try {
                    slotObjectId = typeof item.slotId === 'string' 
                      ? new mongoose.default.Types.ObjectId(item.slotId)
                      : item.slotId;
                  } catch (e) {
                    console.error(`❌ Invalid slotId format: ${item.slotId}`, e);
                    throw new Error(`Invalid slotId format: ${item.slotId}`);
                  }
                  
                  // Find the slot document - try both ObjectId and string formats
                  let plantSlotDoc = await PlantSlot.findOne({
                    "subtypeSlots.slots._id": slotObjectId
                  });
                  
                  // If not found with ObjectId, try with string
                  if (!plantSlotDoc) {
                    plantSlotDoc = await PlantSlot.findOne({
                      "subtypeSlots.slots._id": item.slotId
                    });
                  }
                  
                  if (!plantSlotDoc) {
                    console.warn(`⚠️ Slot ${item.slotId} not found in database - searching all years...`);
                    // Try searching without year filter (slot might be in different year)
                    const allSlots = await PlantSlot.find({
                      "subtypeSlots.slots._id": slotObjectId
                    }).limit(5);
                    
                    if (allSlots.length > 0) {
                      plantSlotDoc = allSlots[0];
                      console.log(`✅ Found slot in year ${plantSlotDoc.year}`);
                    } else {
                      console.warn(`⚠️ Slot ${item.slotId} not found in any year`);
                    }
                  }
                  
                  if (plantSlotDoc) {
                    // Find the slot in the document
                    let slotFound = false;
                    let currentAvailablePlants = 0;
                    let targetSlot = null;
                    let targetSubtypeIndex = -1;
                    let targetSlotIndex = -1;
                    
                    for (let i = 0; i < (plantSlotDoc.subtypeSlots || []).length; i++) {
                      const subtypeSlot = plantSlotDoc.subtypeSlots[i];
                      for (let j = 0; j < (subtypeSlot.slots || []).length; j++) {
                        const slot = subtypeSlot.slots[j];
                        if (slot._id && slot._id.toString() === slotObjectId.toString()) {
                          slotFound = true;
                          targetSlot = slot;
                          targetSubtypeIndex = i;
                          targetSlotIndex = j;
                          currentAvailablePlants = slot.availablePlants || 0;
                          console.log(`✅ Found slot: availablePlants before = ${currentAvailablePlants}, year = ${plantSlotDoc.year}`);
                          break;
                        }
                      }
                      if (slotFound) break;
                    }
                    
                    if (slotFound && targetSlot) {
                      // Method 1: Try updateOne with arrayFilters
                      const updateResult = await PlantSlot.updateOne(
                        { 
                          _id: plantSlotDoc._id,
                          "subtypeSlots.slots._id": slotObjectId 
                        },
                        {
                          $inc: {
                            "subtypeSlots.$[subtypeSlot].slots.$[slot].availablePlants": item.acceptedQuantity
                          }
                        },
                        {
                          arrayFilters: [
                            { "subtypeSlot.slots._id": slotObjectId },
                            { "slot._id": slotObjectId }
                          ]
                        }
                      );

                      console.log(`📊 Slot update result: matched=${updateResult.matchedCount}, modified=${updateResult.modifiedCount}`);
                      
                      if (updateResult.matchedCount > 0 && updateResult.modifiedCount > 0) {
                        console.log(`✅ Updated slot ${item.slotId} availablePlants by +${item.acceptedQuantity}`);
                        
                        // Verify the update
                        await plantSlotDoc.populate();
                        const updatedSlot = plantSlotDoc.subtypeSlots[targetSubtypeIndex]?.slots[targetSlotIndex];
                        if (updatedSlot) {
                          console.log(`✅ Verified: availablePlants after = ${updatedSlot.availablePlants || 0}`);
                        }
                      } else {
                        // Method 2: Direct update using array indices
                        console.log(`⚠️ ArrayFilters method failed, trying direct update...`);
                        const newAvailablePlants = currentAvailablePlants + item.acceptedQuantity;
                        plantSlotDoc.subtypeSlots[targetSubtypeIndex].slots[targetSlotIndex].availablePlants = newAvailablePlants;
                        await plantSlotDoc.save();
                        console.log(`✅ Updated slot using direct method: availablePlants = ${newAvailablePlants}`);
                      }
                      
                      // Update productStock if productName is provided
                      if (item.productName && targetSlot) {
                        try {
                          // Initialize productStock array if it doesn't exist
                          if (!targetSlot.productStock) {
                            targetSlot.productStock = [];
                          }
                          
                          // Find existing productStock entry
                          let productStock = targetSlot.productStock.find(ps => ps.productName === item.productName);
                          
                          if (!productStock) {
                            // Create new entry (shouldn't happen if PO was created first, but handle it)
                            targetSlot.productStock.push({
                              productName: item.productName,
                              available: item.acceptedQuantity,
                              booked: 0,
                              poQuantity: 0,
                              received: true
                            });
                            console.log(`✅ Created productStock entry for "${item.productName}" with available: ${item.acceptedQuantity}`);
                          } else {
                            // Update existing entry
                            productStock.available = (productStock.available || 0) + item.acceptedQuantity;
                            productStock.poQuantity = Math.max(0, (productStock.poQuantity || 0) - item.acceptedQuantity);
                            productStock.received = true;
                            console.log(`✅ Updated productStock for "${item.productName}": available=${productStock.available}, poQuantity=${productStock.poQuantity}`);
                          }
                          
                          // Save the document
                          await plantSlotDoc.save();
                          console.log(`✅ ProductStock updated for "${item.productName}" in slot ${item.slotId}`);
                        } catch (productStockError) {
                          console.error(`❌ Error updating productStock for "${item.productName}":`, productStockError);
                          // Don't fail GRN approval if productStock update fails
                        }
                      }
                    } else {
                      console.warn(`⚠️ Slot ${item.slotId} not found in document structure`);
                    }
                  } else {
                    console.warn(`⚠️ Could not find slot document for slotId: ${item.slotId}`);
                  }
                } catch (slotError) {
                  console.error(`❌ Error updating slot ${item.slotId}:`, slotError);
                  console.error(`   Error details:`, slotError.message);
                  console.error(`   Stack:`, slotError.stack);
                  // Don't fail the GRN approval if slot update fails, just log it
                }
              } else {
                console.log(`ℹ️ No slotId provided for item, skipping slot update`);
              }
            }
          }
        }
        
        // Update GRN status to approved
        savedGRN.status = 'approved';
        savedGRN.qualityCheckBy = req.user._id;
        savedGRN.qualityCheckDate = new Date();
        savedGRN.qualityCheckRemarks = 'Auto-approved from Purchase Order';
        savedGRN.updatedBy = req.user._id;
        await savedGRN.save();

        // Money ledger: PURCHASE AP (same as approveGRN) — must run after approved
        try {
          const { postPurchaseFromGrn } = await import("../services/moneyLedger/index.js");
          await postPurchaseFromGrn(savedGRN, req.user._id);
        } catch (ledgerErr) {
          console.error(
            "[createPO autoGRN] money ledger post failed:",
            ledgerErr?.message || ledgerErr
          );
        }
        
        console.log(`✅ GRN ${grnNumber} approved successfully`);
        
        // Update PO received quantities (classic product OR Ram Agri crop/variety)
        if (savedGRN.purchaseOrder) {
          const po = await PurchaseOrder.findById(savedGRN.purchaseOrder);
          if (po) {
            const { applyGrnAcceptedQtyToPurchaseOrder } = await import(
              "../services/grnPoLink.helpers.js"
            );
            const applied = applyGrnAcceptedQtyToPurchaseOrder(po, savedGRN.items);
            po.markModified("items");
            await po.save();
            console.log(
              `✅ Purchase Order ${po.poNumber} received qty updated (${applied.updated} lines → ${applied.status})`
            );
            // Keep response PO in sync (avoid stale ordered/received=0)
            purchaseOrder.items = po.items;
            purchaseOrder.status = po.status;
            purchaseOrder.markModified?.("items");
          }
        }
        
        // Reload GRN with all populated fields for response
        await savedGRN.populate(['items.product', 'items.unit', 'items.batch', 'purchaseOrder', 'qualityCheckBy']);
        
        console.log(`✅ GRN ${grnNumber} auto-approved and inventory updated`);
        
        // Handle supplier/merchant population
        if (savedGRN.supplier) {
          const { default: Merchant } = await import('../models/merchant.model.js');
          const { default: Supplier } = await import('../models/supplier.model.js');
          
          const supplierId = savedGRN.supplier._id || savedGRN.supplier;
          const supplierDoc = await Supplier.findById(supplierId);
          if (supplierDoc) {
            savedGRN.supplier = supplierDoc;
          } else {
            const merchant = await Merchant.findById(supplierId);
            if (merchant) {
              savedGRN.supplier = {
                _id: merchant._id,
                name: merchant.name,
                phone: merchant.phone,
                email: merchant.email,
                address: merchant.address,
                gstin: merchant.gstin,
                contactPerson: merchant.contactPerson,
                type: 'merchant',
                category: merchant.category,
              };
            }
          }
        }

        const grnData = savedGRN;

        // Re-populate purchase order with updated status
        await purchaseOrder.populate(['items.product', 'items.unit', 'approvedBy']);

        res.status(201).json({
          success: true,
          message: 'Purchase Order created, approved, GRN auto-generated and approved. Inventory updated.',
          data: {
            purchaseOrder,
            grn: grnData,
          },
        });
        return;
      } catch (grnError) {
        console.error('❌ Error auto-creating/approving GRN:', grnError);
        console.error('Error stack:', grnError.stack);
        // If GRN creation fails, still return the PO but with a warning
        res.status(201).json({
          success: true,
          message: 'Purchase Order created and approved, but GRN auto-generation/approval failed. Please create GRN manually.',
          data: purchaseOrder,
          warning: grnError.message,
        });
        return;
      }
    }

    res.status(201).json({
      success: true,
      message: 'Purchase Order created successfully',
      data: purchaseOrder,
    });
  } catch (error) {
    console.error('Error creating purchase order:', error);
    res.status(500).json({
      success: false,
      message: 'Error creating purchase order',
      error: error.message,
    });
  }
};

// Get all Purchase Orders
export const getAllPurchaseOrders = async (req, res) => {
  try {
    const {
      supplier,
      status,
      search,
      startDate,
      endDate,
      page = 1,
      limit = 20,
    } = req.query;

    const query = {};

    if (supplier) {
      query.supplier = supplier;
    }

    if (status) {
      query.status = status;
    }

    if (search) {
      query.poNumber = { $regex: search, $options: 'i' };
    }

    if (startDate || endDate) {
      query.poDate = {};
      if (startDate) query.poDate.$gte = new Date(startDate);
      if (endDate) query.poDate.$lte = new Date(endDate);
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    // Use lean() to get plain objects, then manually populate
    const purchaseOrders = await PurchaseOrder.find(query)
      .populate(['items.product', 'items.unit', 'createdBy'])
      .sort({ poDate: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .lean(); // Convert to plain objects

    // Handle supplier/merchant population for each PO
    const { default: Merchant } = await import('../models/merchant.model.js');
    const { default: Supplier } = await import('../models/supplier.model.js');
    
    for (const po of purchaseOrders) {
      if (!po.supplier) continue;
      
      let supplierId = po.supplier;
      
      // Convert to string if it's an ObjectId or object
      if (typeof supplierId === 'object') {
        if (supplierId._id) {
          supplierId = supplierId._id.toString();
        } else if (supplierId.toString) {
          supplierId = supplierId.toString();
        } else {
          continue; // Skip if can't convert
        }
      } else if (typeof supplierId !== 'string') {
        supplierId = supplierId.toString();
      }
      
      // Try Supplier first
      const supplierDoc = await Supplier.findById(supplierId).lean();
      if (supplierDoc) {
        po.supplier = supplierDoc;
      } else {
        // Try Merchant (since supplier field can contain merchant ID)
        const merchant = await Merchant.findById(supplierId).lean();
        if (merchant) {
          po.supplier = {
            _id: merchant._id,
            name: merchant.name,
            phone: merchant.phone,
            email: merchant.email,
            address: merchant.address,
            gstin: merchant.gstin,
            contactPerson: merchant.contactPerson,
            type: 'merchant',
            category: merchant.category,
          };
        } else {
          // If neither found, keep as ID but log warning
          console.log(`Warning: Supplier/Merchant not found for ID: ${supplierId} in PO ${po.poNumber}`);
          po.supplier = { _id: supplierId, name: 'N/A' };
        }
      }
    }

    const total = await PurchaseOrder.countDocuments(query);

    res.json({
      success: true,
      data: purchaseOrders,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (error) {
    console.error('Error fetching purchase orders:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching purchase orders',
      error: error.message,
    });
  }
};

// Get Purchase Order by ID
export const getPurchaseOrderById = async (req, res) => {
  try {
    const purchaseOrder = await PurchaseOrder.findById(req.params.id)
      .populate([
        'items.product',
        'items.unit',
        'createdBy',
        'updatedBy',
        'approvedBy',
      ]);

    if (!purchaseOrder) {
      return res.status(404).json({
        success: false,
        message: 'Purchase Order not found',
      });
    }

    // Handle supplier/merchant population - try Supplier first, then Merchant
    if (purchaseOrder.supplier) {
      const supplierId = purchaseOrder.supplier._id || purchaseOrder.supplier;
      
      // Import both models
      const { default: Merchant } = await import('../models/merchant.model.js');
      const { default: Supplier } = await import('../models/supplier.model.js');
      
      // Try Supplier first
      const supplierDoc = await Supplier.findById(supplierId);
      if (supplierDoc) {
        purchaseOrder.supplier = supplierDoc;
      } else {
        // Try Merchant (since supplier field can contain merchant ID)
        const merchant = await Merchant.findById(supplierId);
        if (merchant) {
          purchaseOrder.supplier = {
            _id: merchant._id,
            name: merchant.name,
            phone: merchant.phone,
            email: merchant.email,
            address: merchant.address,
            gstin: merchant.gstin,
            contactPerson: merchant.contactPerson,
            type: 'merchant',
            category: merchant.category,
          };
        } else {
          // If neither found, keep as is (might be ObjectId)
          purchaseOrder.supplier = supplierId;
        }
      }
    }

    // Get related GRNs
    const { default: GRN } = await import('../models/grn.model.js');
    const grns = await GRN.find({ purchaseOrder: purchaseOrder._id })
      .populate(['supplier', 'items.product'])
      .sort({ grnDate: -1 });

    res.json({
      success: true,
      data: {
        purchaseOrder,
        grns,
      },
    });
  } catch (error) {
    console.error('Error fetching purchase order:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching purchase order',
      error: error.message,
    });
  }
};

// Update Purchase Order
export const updatePurchaseOrder = async (req, res) => {
  try {
    const purchaseOrder = await PurchaseOrder.findById(req.params.id);

    if (!purchaseOrder) {
      return res.status(404).json({
        success: false,
        message: 'Purchase Order not found',
      });
    }

    if (['received', 'cancelled'].includes(purchaseOrder.status)) {
      return res.status(400).json({
        success: false,
        message: 'Cannot update received or cancelled purchase order',
      });
    }

    if (req.body.autoGRN !== undefined) {
      const wantsAutoGRN = isAutoGRNEnabled(req.body.autoGRN);
      if (wantsAutoGRN && !canPurchaseOrderAutoAccept(req.user)) {
        return res.status(403).json({
          success: false,
          message:
            'Auto GRN / auto-approve is only available for Super Admin, Ram Agri Master, or Ram Agri Sales Manager',
        });
      }
      purchaseOrder.autoGRN = wantsAutoGRN;
    }

    const invoiceRequired = isAutoGRNEnabled(purchaseOrder.autoGRN);

    if (req.body.supplierInvoiceNumber !== undefined) {
      const invoiceNo = String(req.body.supplierInvoiceNumber || '').trim();
      if (invoiceRequired && !invoiceNo) {
        return res.status(400).json({
          success: false,
          message: 'Supplier invoice number is required when Auto GRN is enabled',
        });
      }
      purchaseOrder.supplierInvoiceNumber = invoiceNo || undefined;
    }

    if (req.file) {
      try {
        purchaseOrder.supplierInvoiceFile = await uploadSupplierInvoiceFile(req.file);
      } catch (uploadErr) {
        return res.status(400).json({
          success: false,
          message: uploadErr.message || 'Supplier invoice upload failed',
        });
      }
    }

    if (invoiceRequired) {
      if (!String(purchaseOrder.supplierInvoiceNumber || '').trim()) {
        return res.status(400).json({
          success: false,
          message: 'Supplier invoice number is required when Auto GRN is enabled',
        });
      }
      if (!purchaseOrder.supplierInvoiceFile?.url) {
        return res.status(400).json({
          success: false,
          message: 'Supplier invoice file is required when Auto GRN is enabled',
        });
      }
    }

    const updateFields = [
      'expectedDeliveryDate',
      'items',
      'otherCharges',
      'terms',
      'notes',
    ];

    updateFields.forEach((field) => {
      if (req.body[field] !== undefined) {
        purchaseOrder[field] =
          field === 'items' ? parseBodyJson(req.body[field], req.body[field]) : req.body[field];
      }
    });

    // Recalculate totals if items changed
    if (req.body.items) {
      req.body.items = parseBodyJson(req.body.items, req.body.items);
      const expiryError = validateItemsExpiry(req.body.items);
      if (expiryError) {
        return res.status(400).json({
          success: false,
          message: expiryError,
        });
      }
      purchaseOrder.items = req.body.items;
      let subtotal = 0;
      let gstAmount = 0;
      let discountAmount = 0;

      purchaseOrder.items.forEach((item) => {
        const itemSubtotal = item.quantity * item.rate;
        const itemDiscount = (itemSubtotal * (item.discount || 0)) / 100;
        const itemGst = ((itemSubtotal - itemDiscount) * (item.gst || 0)) / 100;
        
        item.amount = itemSubtotal - itemDiscount + itemGst;
        subtotal += itemSubtotal;
        gstAmount += itemGst;
        discountAmount += itemDiscount;
      });

      purchaseOrder.subtotal = subtotal;
      purchaseOrder.gstAmount = gstAmount;
      purchaseOrder.discountAmount = discountAmount;
      purchaseOrder.totalAmount = subtotal - discountAmount + gstAmount + purchaseOrder.otherCharges;
    }

    purchaseOrder.updatedBy = req.user._id;
    await purchaseOrder.save();

    await purchaseOrder.populate(['supplier', 'items.product', 'items.unit']);

    res.json({
      success: true,
      message: 'Purchase Order updated successfully',
      data: purchaseOrder,
    });
  } catch (error) {
    console.error('Error updating purchase order:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating purchase order',
      error: error.message,
    });
  }
};

// Approve Purchase Order
export const approvePurchaseOrder = async (req, res) => {
  try {
    const purchaseOrder = await PurchaseOrder.findById(req.params.id);

    if (!purchaseOrder) {
      return res.status(404).json({
        success: false,
        message: 'Purchase Order not found',
      });
    }

    if (purchaseOrder.status !== 'pending' && purchaseOrder.status !== 'draft') {
      return res.status(400).json({
        success: false,
        message: 'Purchase Order cannot be approved',
      });
    }

    purchaseOrder.status = 'approved';
    purchaseOrder.approvedBy = req.user._id;
    purchaseOrder.approvedDate = new Date();
    purchaseOrder.updatedBy = req.user._id;

    await purchaseOrder.save();

    // Auto-create GRN if autoGRN is enabled
    if (purchaseOrder.autoGRN) {
      try {
        const { default: GRN } = await import('../models/grn.model.js');
        const { default: Product } = await import('../models/product.model.js');
        
        // Helper function to generate batch number (same as in grn.controller.js)
        const generateBatchNumber = async (productId) => {
          const product = await Product.findById(productId);
          const productName = product?.name || 'PROD';
          const date = new Date();
          const year = date.getFullYear().toString().slice(-2);
          const month = (date.getMonth() + 1).toString().padStart(2, '0');
          const day = date.getDate().toString().padStart(2, '0');
          const productCode = productName.substring(0, 3).toUpperCase().replace(/\s/g, '');
          const random = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
          const productIdShort = productId ? productId.toString().slice(-3) : '000';
          return `BATCH${productCode}${year}${month}${day}${random}`;
        };

        // Generate GRN number
        const grnNumber = await GRN.generateGRNNumber();

        // Transform PO items to GRN items
        const grnItems = await Promise.all(
          purchaseOrder.items.map(async (poItem) => {
            // Auto-generate batch number if not provided
            // batchNumber and lotNumber are treated as the same field
            let batchNumber = poItem.batchNumber || poItem.lotNumber;
            if (!batchNumber || !batchNumber.trim()) {
              batchNumber = await generateBatchNumber(poItem.product);
            }
            batchNumber = batchNumber.trim();

            // Convert expiryDate from string to Date if needed
            let expiryDate = poItem.expiryDate;
            if (expiryDate && typeof expiryDate === 'string') {
              expiryDate = new Date(expiryDate);
              if (isNaN(expiryDate.getTime())) {
                expiryDate = undefined;
              }
            }

            return {
              product: poItem.product,
              poItem: poItem._id,
              batchNumber: batchNumber, // batchNumber and lotNumber are the same
              quantity: poItem.quantity,
              unit: poItem.unit,
              rate: poItem.rate,
              acceptedQuantity: poItem.quantity, // Accept full quantity by default
              rejectedQuantity: 0,
              damageQuantity: 0,
              amount: poItem.amount,
              expiryDate: expiryDate || undefined,
              manufactureDate: undefined,
            };
          })
        );

        // Calculate totals
        let subtotal = 0;
        grnItems.forEach((item) => {
          subtotal += item.amount;
        });

        const totalAmount = subtotal + (purchaseOrder.gstAmount || 0) + (purchaseOrder.otherCharges || 0);

        // Create GRN
        const grn = new GRN({
          grnNumber,
          supplier: purchaseOrder.supplier,
          purchaseOrder: purchaseOrder._id,
          items: grnItems,
          subtotal,
          gstAmount: purchaseOrder.gstAmount || 0,
          freightCharges: 0,
          otherCharges: purchaseOrder.otherCharges || 0,
          totalAmount,
          status: 'draft', // Start as draft, can be approved later
          notes: `Auto-generated from Purchase Order ${purchaseOrder.poNumber}`,
          createdBy: req.user._id,
        });

        await grn.save();
        await grn.populate(['items.product', 'items.unit', 'purchaseOrder']);

        console.log(`Auto-created GRN ${grnNumber} for Purchase Order ${purchaseOrder.poNumber}`);
      } catch (grnError) {
        console.error('Error auto-creating GRN:', grnError);
        // Don't fail the approval if GRN creation fails, just log it
        // The PO is still approved, but GRN will need to be created manually
      }
    }

    await purchaseOrder.populate(['items.product', 'items.unit', 'approvedBy']);

    res.json({
      success: true,
      message: purchaseOrder.autoGRN 
        ? 'Purchase Order approved successfully. GRN has been auto-created.' 
        : 'Purchase Order approved successfully',
      data: purchaseOrder,
    });
  } catch (error) {
    console.error('Error approving purchase order:', error);
    res.status(500).json({
      success: false,
      message: 'Error approving purchase order',
      error: error.message,
    });
  }
};

// Cancel Purchase Order
export const cancelPurchaseOrder = async (req, res) => {
  try {
    const purchaseOrder = await PurchaseOrder.findById(req.params.id);

    if (!purchaseOrder) {
      return res.status(404).json({
        success: false,
        message: 'Purchase Order not found',
      });
    }

    if (['received', 'cancelled'].includes(purchaseOrder.status)) {
      return res.status(400).json({
        success: false,
        message: 'Purchase Order cannot be cancelled',
      });
    }

    purchaseOrder.status = 'cancelled';
    purchaseOrder.updatedBy = req.user._id;
    await purchaseOrder.save();

    res.json({
      success: true,
      message: 'Purchase Order cancelled successfully',
      data: purchaseOrder,
    });
  } catch (error) {
    console.error('Error cancelling purchase order:', error);
    res.status(500).json({
      success: false,
      message: 'Error cancelling purchase order',
      error: error.message,
    });
  }
};

// Delete Purchase Order
export const deletePurchaseOrder = async (req, res) => {
  try {
    const purchaseOrder = await PurchaseOrder.findById(req.params.id);

    if (!purchaseOrder) {
      return res.status(404).json({
        success: false,
        message: 'Purchase Order not found',
      });
    }

    if (purchaseOrder.status !== 'draft') {
      return res.status(400).json({
        success: false,
        message: 'Only draft purchase orders can be deleted',
      });
    }

    await PurchaseOrder.deleteOne({ _id: req.params.id });

    res.json({
      success: true,
      message: 'Purchase Order deleted successfully',
    });
  } catch (error) {
    console.error('Error deleting purchase order:', error);
    res.status(500).json({
      success: false,
      message: 'Error deleting purchase order',
      error: error.message,
    });
  }
};

