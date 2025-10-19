import GRN from '../models/grn.model.js';
import Batch from '../models/batch.model.js';
import Product from '../models/product.model.js';
import PurchaseOrder from '../models/purchaseOrder.model.js';
import InventoryTransaction from '../models/inventoryTransaction.model.js';

// Helper function to create inventory transaction
const createInventoryTransaction = async (item, grn, user) => {
  const product = await Product.findById(item.product);
  const transactionNumber = await InventoryTransaction.generateTransactionNumber();

  const transaction = new InventoryTransaction({
    transactionNumber,
    transactionType: 'inward',
    product: item.product,
    batch: item.batch,
    quantity: item.acceptedQuantity,
    unit: item.unit,
    balanceBeforeTransaction: product.currentStock,
    balanceAfterTransaction: product.currentStock + item.acceptedQuantity,
    rate: item.rate,
    value: item.amount,
    referenceType: 'GRN',
    referenceId: grn._id,
    referenceNumber: grn.grnNumber,
    toLocation: 'Main Warehouse',
    reason: 'GRN Entry',
    performedBy: user._id,
  });

  await transaction.save();
  return transaction;
};

// Create GRN
export const createGRN = async (req, res) => {
  try {
    const {
      supplier,
      purchaseOrder,
      invoiceNumber,
      invoiceDate,
      challanNumber,
      challanDate,
      vehicleNumber,
      driverName,
      items,
      freightCharges,
      otherCharges,
      notes,
    } = req.body;

    // Generate GRN number
    const grnNumber = await GRN.generateGRNNumber();

    // Calculate totals
    let subtotal = 0;
    let gstAmount = 0;

    items.forEach((item) => {
      subtotal += item.amount;
      // GST calculation if needed
    });

    const totalAmount = subtotal + gstAmount + (freightCharges || 0) + (otherCharges || 0);

    const grn = new GRN({
      grnNumber,
      supplier,
      purchaseOrder,
      invoiceNumber,
      invoiceDate,
      challanNumber,
      challanDate,
      vehicleNumber,
      driverName,
      items,
      subtotal,
      gstAmount,
      freightCharges: freightCharges || 0,
      otherCharges: otherCharges || 0,
      totalAmount,
      notes,
      createdBy: req.user._id,
    });

    await grn.save();
    await grn.populate(['supplier', 'purchaseOrder', 'items.product', 'items.unit', 'createdBy']);

    res.status(201).json({
      success: true,
      message: 'GRN created successfully',
      data: grn,
    });
  } catch (error) {
    console.error('Error creating GRN:', error);
    res.status(500).json({
      success: false,
      message: 'Error creating GRN',
      error: error.message,
    });
  }
};

// Approve GRN and update inventory
export const approveGRN = async (req, res) => {
  try {
    const { id } = req.params;
    const { qualityCheckRemarks } = req.body;

    const grn = await GRN.findById(id);

    if (!grn) {
      return res.status(404).json({
        success: false,
        message: 'GRN not found',
      });
    }

    if (grn.status === 'approved') {
      return res.status(400).json({
        success: false,
        message: 'GRN already approved',
      });
    }

    // Create batches and update inventory
    for (const item of grn.items) {
      if (item.acceptedQuantity > 0) {
        // Create batch
        const batch = new Batch({
          batchNumber: item.batchNumber,
          product: item.product,
          manufactureDate: item.manufactureDate,
          expiryDate: item.expiryDate,
          receivedDate: grn.grnDate,
          supplier: grn.supplier,
          purchasePrice: item.rate,
          quantity: item.acceptedQuantity,
          remainingQuantity: item.acceptedQuantity,
          unit: item.unit,
          grn: grn._id,
          createdBy: req.user._id,
        });

        await batch.save();

        // Update item with batch reference
        item.batch = batch._id;

        // Update product stock
        const product = await Product.findById(item.product);
        const oldStock = product.currentStock;
        const oldValue = product.stockValue;

        product.currentStock += item.acceptedQuantity;
        product.stockValue += item.amount;
        product.averagePrice = product.stockValue / product.currentStock;
        product.updatedBy = req.user._id;

        await product.save();

        // Create inventory transaction
        await createInventoryTransaction(item, grn, req.user);
      }
    }

    // Update GRN status
    grn.status = 'approved';
    grn.qualityCheckBy = req.user._id;
    grn.qualityCheckDate = new Date();
    grn.qualityCheckRemarks = qualityCheckRemarks;
    grn.updatedBy = req.user._id;

    await grn.save();

    // Update PO if linked
    if (grn.purchaseOrder) {
      const po = await PurchaseOrder.findById(grn.purchaseOrder);
      if (po) {
        // Update received quantities
        grn.items.forEach((grnItem) => {
          const poItem = po.items.find(
            (item) => item.product.toString() === grnItem.product.toString()
          );
          if (poItem) {
            poItem.receivedQuantity += grnItem.acceptedQuantity;
          }
        });

        // Check if PO is fully received
        const allReceived = po.items.every(
          (item) => item.receivedQuantity >= item.quantity
        );

        if (allReceived) {
          po.status = 'received';
        } else {
          po.status = 'partial_received';
        }

        await po.save();
      }
    }

    await grn.populate(['supplier', 'purchaseOrder', 'items.product', 'items.unit', 'items.batch']);

    res.json({
      success: true,
      message: 'GRN approved and inventory updated successfully',
      data: grn,
    });
  } catch (error) {
    console.error('Error approving GRN:', error);
    res.status(500).json({
      success: false,
      message: 'Error approving GRN',
      error: error.message,
    });
  }
};

// Get all GRNs
export const getAllGRNs = async (req, res) => {
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
      query.$or = [
        { grnNumber: { $regex: search, $options: 'i' } },
        { invoiceNumber: { $regex: search, $options: 'i' } },
        { challanNumber: { $regex: search, $options: 'i' } },
      ];
    }

    if (startDate || endDate) {
      query.grnDate = {};
      if (startDate) query.grnDate.$gte = new Date(startDate);
      if (endDate) query.grnDate.$lte = new Date(endDate);
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [grns, total] = await Promise.all([
      GRN.find(query)
        .populate(['supplier', 'purchaseOrder', 'items.product', 'createdBy'])
        .sort({ grnDate: -1 })
        .skip(skip)
        .limit(parseInt(limit)),
      GRN.countDocuments(query),
    ]);

    res.json({
      success: true,
      data: grns,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (error) {
    console.error('Error fetching GRNs:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching GRNs',
      error: error.message,
    });
  }
};

// Get GRN by ID
export const getGRNById = async (req, res) => {
  try {
    const grn = await GRN.findById(req.params.id)
      .populate([
        'supplier',
        'purchaseOrder',
        'items.product',
        'items.unit',
        'items.batch',
        'createdBy',
        'updatedBy',
        'qualityCheckBy',
      ]);

    if (!grn) {
      return res.status(404).json({
        success: false,
        message: 'GRN not found',
      });
    }

    res.json({
      success: true,
      data: grn,
    });
  } catch (error) {
    console.error('Error fetching GRN:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching GRN',
      error: error.message,
    });
  }
};

// Update GRN
export const updateGRN = async (req, res) => {
  try {
    const grn = await GRN.findById(req.params.id);

    if (!grn) {
      return res.status(404).json({
        success: false,
        message: 'GRN not found',
      });
    }

    if (grn.status === 'approved') {
      return res.status(400).json({
        success: false,
        message: 'Cannot update approved GRN',
      });
    }

    const updateFields = [
      'invoiceNumber',
      'invoiceDate',
      'challanNumber',
      'challanDate',
      'vehicleNumber',
      'driverName',
      'items',
      'freightCharges',
      'otherCharges',
      'notes',
    ];

    updateFields.forEach((field) => {
      if (req.body[field] !== undefined) {
        grn[field] = req.body[field];
      }
    });

    // Recalculate totals if items changed
    if (req.body.items) {
      let subtotal = 0;
      let gstAmount = 0;

      grn.items.forEach((item) => {
        subtotal += item.amount;
      });

      grn.subtotal = subtotal;
      grn.gstAmount = gstAmount;
      grn.totalAmount = subtotal + gstAmount + grn.freightCharges + grn.otherCharges;
    }

    grn.updatedBy = req.user._id;
    await grn.save();

    await grn.populate(['supplier', 'purchaseOrder', 'items.product', 'items.unit']);

    res.json({
      success: true,
      message: 'GRN updated successfully',
      data: grn,
    });
  } catch (error) {
    console.error('Error updating GRN:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating GRN',
      error: error.message,
    });
  }
};

// Delete GRN
export const deleteGRN = async (req, res) => {
  try {
    const grn = await GRN.findById(req.params.id);

    if (!grn) {
      return res.status(404).json({
        success: false,
        message: 'GRN not found',
      });
    }

    if (grn.status === 'approved') {
      return res.status(400).json({
        success: false,
        message: 'Cannot delete approved GRN',
      });
    }

    await GRN.deleteOne({ _id: req.params.id });

    res.json({
      success: true,
      message: 'GRN deleted successfully',
    });
  } catch (error) {
    console.error('Error deleting GRN:', error);
    res.status(500).json({
      success: false,
      message: 'Error deleting GRN',
      error: error.message,
    });
  }
};

