import Supplier from '../models/supplier.model.js';

// Create supplier
export const createSupplier = async (req, res) => {
  try {
    const {
      code,
      name,
      contactPerson,
      phone,
      email,
      address,
      gstin,
      pan,
      paymentTerms,
      creditLimit,
      rating,
      notes,
    } = req.body;

    // Check if supplier code already exists
    const existingSupplier = await Supplier.findOne({ code });
    if (existingSupplier) {
      return res.status(400).json({
        success: false,
        message: 'Supplier code already exists',
      });
    }

    const supplier = new Supplier({
      code,
      name,
      contactPerson,
      phone,
      email,
      address,
      gstin,
      pan,
      paymentTerms: paymentTerms || 'net30',
      creditLimit: creditLimit || 0,
      rating,
      notes,
      createdBy: req.user._id,
    });

    await supplier.save();
    await supplier.populate('createdBy');

    res.status(201).json({
      success: true,
      message: 'Supplier created successfully',
      data: supplier,
    });
  } catch (error) {
    console.error('Error creating supplier:', error);
    res.status(500).json({
      success: false,
      message: 'Error creating supplier',
      error: error.message,
    });
  }
};

// Get all suppliers
export const getAllSuppliers = async (req, res) => {
  try {
    const {
      isActive,
      search,
      page = 1,
      limit = 50,
      sortBy = 'name',
      sortOrder = 'asc',
    } = req.query;

    const query = {};

    if (isActive !== undefined) {
      query.isActive = isActive === 'true';
    }

    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { code: { $regex: search, $options: 'i' } },
        { phone: { $regex: search, $options: 'i' } },
      ];
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const sort = { [sortBy]: sortOrder === 'asc' ? 1 : -1 };

    const [suppliers, total] = await Promise.all([
      Supplier.find(query)
        .populate('createdBy')
        .sort(sort)
        .skip(skip)
        .limit(parseInt(limit)),
      Supplier.countDocuments(query),
    ]);

    res.json({
      success: true,
      data: suppliers,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (error) {
    console.error('Error fetching suppliers:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching suppliers',
      error: error.message,
    });
  }
};

// Get supplier by ID
export const getSupplierById = async (req, res) => {
  try {
    const supplier = await Supplier.findById(req.params.id).populate('createdBy');

    if (!supplier) {
      return res.status(404).json({
        success: false,
        message: 'Supplier not found',
      });
    }

    // Get related purchase orders and GRNs
    const { default: PurchaseOrder } = await import('../models/purchaseOrder.model.js');
    const { default: GRN } = await import('../models/grn.model.js');

    const [purchaseOrders, grns] = await Promise.all([
      PurchaseOrder.find({ supplier: supplier._id })
        .sort({ poDate: -1 })
        .limit(10),
      GRN.find({ supplier: supplier._id })
        .sort({ grnDate: -1 })
        .limit(10),
    ]);

    res.json({
      success: true,
      data: {
        supplier,
        recentPurchaseOrders: purchaseOrders,
        recentGRNs: grns,
      },
    });
  } catch (error) {
    console.error('Error fetching supplier:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching supplier',
      error: error.message,
    });
  }
};

// Update supplier
export const updateSupplier = async (req, res) => {
  try {
    const supplier = await Supplier.findById(req.params.id);

    if (!supplier) {
      return res.status(404).json({
        success: false,
        message: 'Supplier not found',
      });
    }

    const updateFields = [
      'name',
      'contactPerson',
      'phone',
      'email',
      'address',
      'gstin',
      'pan',
      'paymentTerms',
      'creditLimit',
      'rating',
      'notes',
      'isActive',
    ];

    updateFields.forEach((field) => {
      if (req.body[field] !== undefined) {
        supplier[field] = req.body[field];
      }
    });

    await supplier.save();
    await supplier.populate('createdBy');

    res.json({
      success: true,
      message: 'Supplier updated successfully',
      data: supplier,
    });
  } catch (error) {
    console.error('Error updating supplier:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating supplier',
      error: error.message,
    });
  }
};

// Delete supplier (soft delete)
export const deleteSupplier = async (req, res) => {
  try {
    const supplier = await Supplier.findById(req.params.id);

    if (!supplier) {
      return res.status(404).json({
        success: false,
        message: 'Supplier not found',
      });
    }

    supplier.isActive = false;
    await supplier.save();

    res.json({
      success: true,
      message: 'Supplier deactivated successfully',
    });
  } catch (error) {
    console.error('Error deleting supplier:', error);
    res.status(500).json({
      success: false,
      message: 'Error deleting supplier',
      error: error.message,
    });
  }
};

