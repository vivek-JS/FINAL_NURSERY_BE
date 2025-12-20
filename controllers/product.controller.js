import Product from '../models/product.model.js';
import Batch from '../models/batch.model.js';
import InventoryTransaction from '../models/inventoryTransaction.model.js';

// Create product
export const createProduct = async (req, res) => {
  try {
    const {
      code,
      name,
      description,
      category,
      primaryUnit,
      secondaryUnit,
      conversionFactor,
      minStockLevel,
      maxStockLevel,
      reorderLevel,
      hsn,
      gst,
      plantId, // For seeds category
      subtypeId, // For seeds category
    } = req.body;

    // Check if product code already exists
    const existingProduct = await Product.findOne({ code });
    if (existingProduct) {
      return res.status(400).json({
        success: false,
        message: 'Product code already exists',
      });
    }

    const productData = {
      code,
      name,
      description,
      category,
      primaryUnit,
      secondaryUnit,
      conversionFactor: conversionFactor || 1,
      minStockLevel: minStockLevel || 0,
      maxStockLevel,
      reorderLevel,
      hsn,
      gst: gst || 0,
      createdBy: req.user._id,
    };

    // Add plantId and subtypeId if category is "seeds" or "plants"
    if (category === 'seeds' || category === 'plants') {
      // Explicitly check for valid values (not null, undefined, or empty string)
      const validPlantId = plantId && 
        plantId !== null && 
        plantId !== undefined && 
        plantId !== 'null' && 
        plantId !== 'undefined' && 
        String(plantId).trim() !== '';
      
      if (validPlantId) {
        productData.plantId = plantId;
      }
      
      const validSubtypeId = subtypeId && 
        subtypeId !== null && 
        subtypeId !== undefined && 
        subtypeId !== 'null' && 
        subtypeId !== 'undefined' && 
        String(subtypeId).trim() !== '';
      
      if (validSubtypeId) {
        productData.subtypeId = subtypeId;
      }
      
      // Log for debugging
      console.log('Product creation - category:', category, 'plantId:', plantId, 'subtypeId:', subtypeId, 'validPlantId:', validPlantId);
    }

    const product = new Product(productData);

    await product.save();

    await product.populate(['primaryUnit', 'secondaryUnit', 'createdBy', 'plantId']);
    
    // Convert to plain object for easier manipulation
    const productObj = product.toObject ? product.toObject() : product;

    // Manually populate subtype information if plantId and subtypeId exist
    if (productObj.plantId && productObj.subtypeId) {
      try {
        const { default: PlantCms } = await import('../models/plantCms.model.js');
        const plant = await PlantCms.findById(productObj.plantId).select('name subtypes').lean();
        if (plant) {
          const subtype = plant.subtypes?.id(productObj.subtypeId);
          if (subtype) {
            productObj.subtype = {
              _id: subtype._id,
              name: subtype.name,
            };
          }
        }
      } catch (error) {
        console.error(`Error fetching subtype for product ${productObj._id}:`, error);
      }
    }

    res.status(201).json({
      success: true,
      message: 'Product created successfully',
      data: productObj,
    });
  } catch (error) {
    console.error('Error creating product:', error);
    res.status(500).json({
      success: false,
      message: 'Error creating product',
      error: error.message,
    });
  }
};

// Get all products with filters
export const getAllProducts = async (req, res) => {
  try {
    const {
      category,
      isActive,
      search,
      page = 1,
      limit = 50,
      sortBy = 'name',
      sortOrder = 'asc',
    } = req.query;

    const query = {};

    if (category) {
      query.category = category;
    }

    if (isActive !== undefined) {
      query.isActive = isActive === 'true';
    }

    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { code: { $regex: search, $options: 'i' } },
      ];
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const sort = { [sortBy]: sortOrder === 'asc' ? 1 : -1 };

    const [products, total] = await Promise.all([
      Product.find(query)
        .populate(['primaryUnit', 'secondaryUnit', 'createdBy', 'plantId'])
        .sort(sort)
        .skip(skip)
        .limit(parseInt(limit))
        .lean(), // Use lean for easier manipulation
      Product.countDocuments(query),
    ]);

    // Manually populate subtype information for products with plantId and subtypeId
    const { default: PlantCms } = await import('../models/plantCms.model.js');
    const productsWithSubtype = await Promise.all(
      products.map(async (product) => {
        if (product.plantId && product.subtypeId) {
          try {
            const plant = await PlantCms.findById(product.plantId).select('name subtypes').lean();
            if (plant) {
              const subtype = plant.subtypes?.id(product.subtypeId);
              if (subtype) {
                product.subtype = {
                  _id: subtype._id,
                  name: subtype.name,
                };
              }
            }
          } catch (error) {
            console.error(`Error fetching subtype for product ${product._id}:`, error);
          }
        }
        return product;
      })
    );

    res.json({
      success: true,
      data: productsWithSubtype,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (error) {
    console.error('Error fetching products:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching products',
      error: error.message,
    });
  }
};

// Get product by ID
export const getProductById = async (req, res) => {
  try {
    const product = await Product.findById(req.params.id)
      .populate(['primaryUnit', 'secondaryUnit', 'createdBy', 'updatedBy', 'plantId'])
      .lean(); // Use lean for easier manipulation

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found',
      });
    }

    // Manually populate plant and subtype information if plantId and subtypeId exist
    if (product.plantId) {
      try {
        const { default: PlantCms } = await import('../models/plantCms.model.js');
        const plant = await PlantCms.findById(product.plantId).select('name subtypes').lean();
        if (plant) {
          // Add plant object
          product.plant = {
            _id: plant._id,
            name: plant.name,
          };
          
          // Add subtype if subtypeId exists
          if (product.subtypeId) {
            const subtype = plant.subtypes?.id(product.subtypeId);
            if (subtype) {
              product.subtype = {
                _id: subtype._id,
                name: subtype.name,
              };
            }
          }
        }
      } catch (error) {
        console.error(`Error fetching plant/subtype for product ${product._id}:`, error);
      }
    }

    // Get batches for this product
    const batchDocs = await Batch.find({ product: product._id })
      .populate(['unit'])
      .sort({ receivedDate: -1 })
      .lean(); // Use lean for plain objects
    
    // Manually populate supplier/merchant for batches
    const { default: Merchant } = await import('../models/merchant.model.js');
    const { default: Supplier } = await import('../models/supplier.model.js');
    
    const batches = await Promise.all(batchDocs.map(async (batch) => {
      if (batch.supplier) {
        let supplierId = batch.supplier;
        if (typeof supplierId === 'object' && supplierId._id) {
          supplierId = supplierId._id.toString();
        } else if (typeof supplierId !== 'string') {
          supplierId = supplierId.toString();
        }
        
        // Try Supplier first
        const supplierDoc = await Supplier.findById(supplierId).lean();
        if (supplierDoc) {
          batch.supplier = supplierDoc;
        } else {
          // Try Merchant
          const merchant = await Merchant.findById(supplierId).lean();
          if (merchant) {
            batch.supplier = {
              _id: merchant._id,
              name: merchant.name,
              phone: merchant.phone,
              email: merchant.email,
              type: 'merchant',
            };
          }
        }
      }
      return batch;
    }));

    // Get recent transactions
    const recentTransactions = await InventoryTransaction.find({ product: product._id })
      .populate(['batch', 'unit', 'performedBy'])
      .sort({ transactionDate: -1 })
      .limit(20);

    // Get packets information for seeds type products (both available and used)
    let packets = [];
    if (product.category && product.category.toLowerCase() === 'seeds') {
      try {
        const { default: InventoryOutward } = await import('../models/inventoryOutward.model.js');
        
        // Find all issued outward entries with this product, purpose=production, status=issued
        const outwards = await InventoryOutward.find({
          purpose: 'production',
          status: 'issued',
          'items.product': product._id,
        })
          .populate([
            {
              path: 'items.product',
              select: 'name code plantId subtypeId',
              populate: [
                {
                  path: 'plantId',
                  select: 'name',
                },
              ],
            },
            'items.batch',
            'items.unit',
            {
              path: 'items.sowing',
              select: 'plantId plantName subtypeId subtypeName sowingDate expectedReadyDate totalQuantityRequired officeSowed primarySowed totalSowed status orderId orderNumber sowingLocation notes',
              populate: [
                {
                  path: 'plantId',
                  select: 'name',
                },
                {
                  path: 'orderId',
                  select: 'orderNumber orderDate',
                },
              ],
            },
          ])
          .sort({ outwardDate: -1 })
          .lean();

        // Extract all items (both available and used)
        outwards.forEach((outward) => {
          outward.items.forEach((item) => {
            if (item.product && item.product._id.toString() === product._id.toString()) {
              const availableQty = item.quantity - (item.usedQuantity || 0);
              
              // Get plant and subtype info from product
              let packetPlant = null;
              let packetSubtype = null;
              
              // Get plant from product (already populated)
              if (product.plant) {
                packetPlant = product.plant;
              } else if (product.plantId) {
                // If plantId is populated as object
                if (typeof product.plantId === 'object' && product.plantId.name) {
                  packetPlant = {
                    _id: product.plantId._id || product.plantId,
                    name: product.plantId.name,
                  };
                } else if (item.product?.plantId) {
                  // Try from item product
                  if (typeof item.product.plantId === 'object' && item.product.plantId.name) {
                    packetPlant = {
                      _id: item.product.plantId._id || item.product.plantId,
                      name: item.product.plantId.name,
                    };
                  }
                }
              }
              
              // Get subtype from product (already populated)
              if (product.subtype) {
                packetSubtype = product.subtype;
              } else if (item.sowing && item.sowing.length > 0 && item.sowing[0].subtypeName) {
                // Fallback to sowing subtype info
                packetSubtype = {
                  _id: item.sowing[0].subtypeId,
                  name: item.sowing[0].subtypeName,
                };
              }
              
              packets.push({
                outwardId: outward._id,
                outwardNumber: outward.outwardNumber,
                outwardDate: outward.outwardDate,
                itemId: item._id,
                batch: item.batch,
                batchNumber: item.batch?.batchNumber || 'N/A',
                quantity: item.quantity,
                usedQuantity: item.usedQuantity || 0,
                availableQuantity: availableQty,
                unit: item.unit,
                rate: item.rate,
                amount: item.amount,
                plant: packetPlant,
                subtype: packetSubtype,
                sowing: item.sowing || [],
              });
            }
          });
        });
      } catch (error) {
        console.error(`Error fetching packets for product ${product._id}:`, error);
        // Continue without packets if there's an error
      }
    }

    res.json({
      success: true,
      data: {
        product,
        batches,
        recentTransactions,
        ...(packets.length > 0 || product.category?.toLowerCase() === 'seeds' ? { packets } : {}),
      },
    });
  } catch (error) {
    console.error('Error fetching product:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching product',
      error: error.message,
    });
  }
};

// Update product
export const updateProduct = async (req, res) => {
  try {
    const {
      name,
      description,
      category,
      primaryUnit,
      secondaryUnit,
      conversionFactor,
      minStockLevel,
      maxStockLevel,
      reorderLevel,
      hsn,
      gst,
      isActive,
      plantId, // For seeds category
      subtypeId, // For seeds category
    } = req.body;

    const product = await Product.findById(req.params.id);

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found',
      });
    }

    // Update fields
    if (name) product.name = name;
    if (description !== undefined) product.description = description;
    if (category) product.category = category;
    if (primaryUnit) product.primaryUnit = primaryUnit;
    if (secondaryUnit !== undefined) product.secondaryUnit = secondaryUnit;
    if (conversionFactor) product.conversionFactor = conversionFactor;
    if (minStockLevel !== undefined) product.minStockLevel = minStockLevel;
    if (maxStockLevel !== undefined) product.maxStockLevel = maxStockLevel;
    if (reorderLevel !== undefined) product.reorderLevel = reorderLevel;
    if (hsn !== undefined) product.hsn = hsn;
    if (gst !== undefined) product.gst = gst;
    if (isActive !== undefined) product.isActive = isActive;

    // Update plantId and subtypeId if category is "seeds" or "plants"
    if (category === 'seeds' || category === 'plants') {
      if (plantId !== undefined) product.plantId = plantId || null;
      if (subtypeId !== undefined) product.subtypeId = subtypeId || null;
    } else {
      // Clear plantId and subtypeId if category is not "seeds" or "plant"
      product.plantId = null;
      product.subtypeId = null;
    }

    product.updatedBy = req.user._id;

    await product.save();
    await product.populate(['primaryUnit', 'secondaryUnit', 'createdBy', 'updatedBy', 'plantId']);
    
    // Convert to plain object for easier manipulation
    const productObj = product.toObject ? product.toObject() : product;

    // Manually populate subtype information if plantId and subtypeId exist
    if (productObj.plantId && productObj.subtypeId) {
      try {
        const { default: PlantCms } = await import('../models/plantCms.model.js');
        const plant = await PlantCms.findById(productObj.plantId).select('name subtypes').lean();
        if (plant) {
          const subtype = plant.subtypes?.id(productObj.subtypeId);
          if (subtype) {
            productObj.subtype = {
              _id: subtype._id,
              name: subtype.name,
            };
          }
        }
      } catch (error) {
        console.error(`Error fetching subtype for product ${productObj._id}:`, error);
      }
    }

    res.json({
      success: true,
      message: 'Product updated successfully',
      data: productObj,
    });
  } catch (error) {
    console.error('Error updating product:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating product',
      error: error.message,
    });
  }
};

// Delete product (soft delete)
export const deleteProduct = async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found',
      });
    }

    // Check if product has stock
    if (product.currentStock > 0) {
      return res.status(400).json({
        success: false,
        message: 'Cannot delete product with existing stock',
      });
    }

    product.isActive = false;
    product.updatedBy = req.user._id;
    await product.save();

    res.json({
      success: true,
      message: 'Product deleted successfully',
    });
  } catch (error) {
    console.error('Error deleting product:', error);
    res.status(500).json({
      success: false,
      message: 'Error deleting product',
      error: error.message,
    });
  }
};

// Get low stock products
export const getLowStockProducts = async (req, res) => {
  try {
    const products = await Product.find({
      isActive: true,
      $expr: {
        $lte: ['$currentStock', '$reorderLevel'],
      },
    })
      .populate(['primaryUnit', 'secondaryUnit', 'plantId'])
      .lean(); // Use lean for easier manipulation

    // Manually populate subtype information for products with plantId and subtypeId
    const { default: PlantCms } = await import('../models/plantCms.model.js');
    const productsWithSubtype = await Promise.all(
      products.map(async (product) => {
        if (product.plantId && product.subtypeId) {
          try {
            const plant = await PlantCms.findById(product.plantId).select('name subtypes').lean();
            if (plant) {
              const subtype = plant.subtypes?.id(product.subtypeId);
              if (subtype) {
                product.subtype = {
                  _id: subtype._id,
                  name: subtype.name,
                };
              }
            }
          } catch (error) {
            console.error(`Error fetching subtype for product ${product._id}:`, error);
          }
        }
        return product;
      })
    );

    res.json({
      success: true,
      data: productsWithSubtype,
    });
  } catch (error) {
    console.error('Error fetching low stock products:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching low stock products',
      error: error.message,
    });
  }
};

// Get inventory summary
export const getInventorySummary = async (req, res) => {
  try {
    const [
      totalProducts,
      activeProducts,
      lowStockCount,
      totalStockValue,
      categoryWiseStock,
    ] = await Promise.all([
      Product.countDocuments(),
      Product.countDocuments({ isActive: true }),
      Product.countDocuments({
        isActive: true,
        $expr: { $lte: ['$currentStock', '$reorderLevel'] },
      }),
      Product.aggregate([
        { $match: { isActive: true } },
        { $group: { _id: null, total: { $sum: '$stockValue' } } },
      ]),
      Product.aggregate([
        { $match: { isActive: true } },
        {
          $group: {
            _id: '$category',
            count: { $sum: 1 },
            totalValue: { $sum: '$stockValue' },
            totalStock: { $sum: '$currentStock' },
          },
        },
      ]),
    ]);

    res.json({
      success: true,
      data: {
        totalProducts,
        activeProducts,
        lowStockCount,
        totalStockValue: totalStockValue[0]?.total || 0,
        categoryWiseStock,
      },
    });
  } catch (error) {
    console.error('Error fetching inventory summary:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching inventory summary',
      error: error.message,
    });
  }
};

