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
    } = req.body;

    // Check if product code already exists
    const existingProduct = await Product.findOne({ code });
    if (existingProduct) {
      return res.status(400).json({
        success: false,
        message: 'Product code already exists',
      });
    }

    const product = new Product({
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
    });

    await product.save();

    await product.populate(['primaryUnit', 'secondaryUnit', 'createdBy']);

    res.status(201).json({
      success: true,
      message: 'Product created successfully',
      data: product,
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
        .populate(['primaryUnit', 'secondaryUnit', 'createdBy'])
        .sort(sort)
        .skip(skip)
        .limit(parseInt(limit)),
      Product.countDocuments(query),
    ]);

    res.json({
      success: true,
      data: products,
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
      .populate(['primaryUnit', 'secondaryUnit', 'createdBy', 'updatedBy']);

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found',
      });
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

    res.json({
      success: true,
      data: {
        product,
        batches,
        recentTransactions,
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

    product.updatedBy = req.user._id;

    await product.save();
    await product.populate(['primaryUnit', 'secondaryUnit', 'createdBy', 'updatedBy']);

    res.json({
      success: true,
      message: 'Product updated successfully',
      data: product,
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
    }).populate(['primaryUnit', 'secondaryUnit']);

    res.json({
      success: true,
      data: products,
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

