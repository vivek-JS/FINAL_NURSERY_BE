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
      createdBy: req.user._id,
    });

    await purchaseOrder.save();
    await purchaseOrder.populate(['supplier', 'items.product', 'items.unit', 'createdBy']);

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

    const [purchaseOrders, total] = await Promise.all([
      PurchaseOrder.find(query)
        .populate(['supplier', 'items.product', 'createdBy'])
        .sort({ poDate: -1 })
        .skip(skip)
        .limit(parseInt(limit)),
      PurchaseOrder.countDocuments(query),
    ]);

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
        'supplier',
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

    res.json({
      success: true,
      message: 'Purchase Order approved successfully',
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

