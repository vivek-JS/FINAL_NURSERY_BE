import PurchaseOrder from '../models/purchaseOrder.model.js';

// Create Purchase Order
export const createPurchaseOrder = async (req, res) => {
  try {
    const {
      supplier,
      poDate,
      expectedDeliveryDate,
      items,
      otherCharges,
      terms,
      notes,
      autoGRN, // Auto GRN flag
    } = req.body;

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
      autoGRN: autoGRN === true || autoGRN === 'true' || autoGRN === 1, // Store auto GRN flag (handle string/boolean)
      createdBy: req.user._id,
    });

    await purchaseOrder.save();
    console.log('💾 Purchase Order saved with autoGRN:', purchaseOrder.autoGRN);
    await purchaseOrder.populate(['items.product', 'items.unit', 'createdBy']);

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
    const isAutoGRNEnabled = purchaseOrder.autoGRN === true || purchaseOrder.autoGRN === 'true' || purchaseOrder.autoGRN === 1 || autoGRN === true || autoGRN === 'true' || autoGRN === 1;
    console.log('🔍 Checking autoGRN flag:', { 
      autoGRN, 
      purchaseOrderAutoGRN: purchaseOrder.autoGRN,
      isAutoGRNEnabled 
    });
    
    if (isAutoGRNEnabled) {
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
            // Auto-generate batch number if not provided
            let batchNumber = poItem.batchNumber || poItem.lotNumber;
            if (!batchNumber || !batchNumber.trim()) {
              batchNumber = await generateBatchNumber(poItem.product._id || poItem.product);
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

            // Format exactly matching the GRN API payload from curl command
            return {
              product: poItem.product._id || poItem.product,
              batchNumber: batchNumber,
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
        
        // Populate GRN data
        await grn.populate(['items.product', 'items.unit', 'purchaseOrder']);
        
        // Handle supplier/merchant population
        if (grn.supplier) {
          const { default: Merchant } = await import('../models/merchant.model.js');
          const { default: Supplier } = await import('../models/supplier.model.js');
          
          const supplierId = grn.supplier._id || grn.supplier;
          const supplierDoc = await Supplier.findById(supplierId);
          if (supplierDoc) {
            grn.supplier = supplierDoc;
          } else {
            const merchant = await Merchant.findById(supplierId);
            if (merchant) {
              grn.supplier = {
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

        const grnData = grn;

        // Re-populate purchase order with updated status
        await purchaseOrder.populate(['items.product', 'items.unit', 'approvedBy']);

        res.status(201).json({
          success: true,
          message: 'Purchase Order created, approved, and GRN auto-generated successfully',
          data: {
            purchaseOrder,
            grn: grnData,
          },
        });
        return;
        return;
      } catch (grnError) {
        console.error('❌ Error auto-creating GRN:', grnError);
        // If GRN creation fails, still return the PO but with a warning
        res.status(201).json({
          success: true,
          message: 'Purchase Order created and approved, but GRN auto-generation failed. Please create GRN manually.',
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

    const updateFields = [
      'expectedDeliveryDate',
      'items',
      'otherCharges',
      'terms',
      'notes',
    ];

    updateFields.forEach((field) => {
      if (req.body[field] !== undefined) {
        purchaseOrder[field] = req.body[field];
      }
    });

    // Recalculate totals if items changed
    if (req.body.items) {
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

