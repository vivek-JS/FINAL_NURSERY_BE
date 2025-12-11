import InventoryOutward from '../models/inventoryOutward.model.js';
import Batch from '../models/batch.model.js';
import Product from '../models/product.model.js';
import InventoryTransaction from '../models/inventoryTransaction.model.js';

// Helper function to create inventory transaction
const createOutwardTransaction = async (item, outward, user) => {
  const product = await Product.findById(item.product);
  const transactionNumber = await InventoryTransaction.generateTransactionNumber();

  const transaction = new InventoryTransaction({
    transactionNumber,
    transactionType: 'outward',
    product: item.product,
    batch: item.batch,
    quantity: item.quantity,
    unit: item.unit,
    balanceBeforeTransaction: product.currentStock,
    balanceAfterTransaction: product.currentStock - item.quantity,
    rate: item.rate,
    value: item.amount,
    referenceType: 'Outward',
    referenceId: outward._id,
    referenceNumber: outward.outwardNumber,
    fromLocation: 'Main Warehouse',
    toLocation: outward.destination || outward.department,
    reason: outward.purpose,
    remarks: outward.purposeDetails,
    performedBy: user._id,
  });

  await transaction.save();
  return transaction;
};

// Create Outward
export const createOutward = async (req, res) => {
  try {
    const {
      outwardDate,
      purpose,
      purposeDetails,
      department,
      recipientName,
      recipientPhone,
      destination,
      items,
      vehicleNumber,
      driverName,
      notes,
    } = req.body;

    // Generate outward number
    const outwardNumber = await InventoryOutward.generateOutwardNumber();

    // Calculate total
    let totalAmount = 0;
    items.forEach((item) => {
      if (item.amount) {
        totalAmount += item.amount;
      }
    });

    const outward = new InventoryOutward({
      outwardNumber,
      outwardDate: outwardDate || new Date(),
      purpose,
      purposeDetails,
      department,
      recipientName,
      recipientPhone,
      destination,
      items,
      totalAmount,
      vehicleNumber,
      driverName,
      notes,
      createdBy: req.user._id,
    });

    await outward.save();
    await outward.populate(['items.product', 'items.batch', 'items.unit', 'createdBy']);

    res.status(201).json({
      success: true,
      message: 'Outward entry created successfully',
      data: outward,
    });
  } catch (error) {
    console.error('Error creating outward:', error);
    res.status(500).json({
      success: false,
      message: 'Error creating outward',
      error: error.message,
    });
  }
};

// Issue Outward (reduce stock)
export const issueOutward = async (req, res) => {
  try {
    const { id } = req.params;

    const outward = await InventoryOutward.findById(id);

    if (!outward) {
      return res.status(404).json({
        success: false,
        message: 'Outward entry not found',
      });
    }

    if (outward.status === 'issued') {
      return res.status(400).json({
        success: false,
        message: 'Outward already issued',
      });
    }

    // Validate stock availability
    for (const item of outward.items) {
      const batch = await Batch.findById(item.batch);
      
      if (!batch) {
        return res.status(404).json({
          success: false,
          message: `Batch not found for item`,
        });
      }

      if (batch.remainingQuantity < item.quantity) {
        return res.status(400).json({
          success: false,
          message: `Insufficient stock in batch ${batch.batchNumber}`,
        });
      }

      if (batch.status !== 'active') {
        return res.status(400).json({
          success: false,
          message: `Batch ${batch.batchNumber} is not active`,
        });
      }
    }

    // Update batches and product stock
    for (const item of outward.items) {
      const batch = await Batch.findById(item.batch);
      batch.remainingQuantity -= item.quantity;
      
      if (batch.remainingQuantity <= 0) {
        batch.status = 'exhausted';
      }
      
      await batch.save();

      // Update product stock
      const product = await Product.findById(item.product);
      if (!product) {
        throw new Error(`Product not found for item: ${item.product}`);
      }

      // Validate stock availability before reducing
      if (product.currentStock < item.quantity) {
        throw new Error(`Insufficient stock. Available: ${product.currentStock}, Required: ${item.quantity}`);
      }

      product.currentStock -= item.quantity;
      
      if (item.rate) {
        const amountToDeduct = item.amount || (item.quantity * item.rate);
        product.stockValue = Math.max(0, (product.stockValue || 0) - amountToDeduct);
      }
      
      // Calculate average price safely
      if (product.currentStock > 0 && product.stockValue > 0) {
        product.averagePrice = product.stockValue / product.currentStock;
      } else {
        product.averagePrice = 0;
      }
      
      product.updatedBy = req.user._id;
      await product.save();

      // Create inventory transaction
      await createOutwardTransaction(item, outward, req.user);
    }

    // Update outward status
    outward.status = 'issued';
    outward.issuedBy = req.user._id;
    outward.issuedDate = new Date();
    outward.updatedBy = req.user._id;

    await outward.save();
    await outward.populate(['items.product', 'items.batch', 'items.unit', 'issuedBy']);

    res.json({
      success: true,
      message: 'Outward issued successfully and inventory updated',
      data: outward,
    });
  } catch (error) {
    console.error('Error issuing outward:', error);
    res.status(500).json({
      success: false,
      message: 'Error issuing outward',
      error: error.message,
    });
  }
};

// Get all Outwards
export const getAllOutwards = async (req, res) => {
  try {
    const {
      purpose,
      status,
      search,
      startDate,
      endDate,
      page = 1,
      limit = 20,
    } = req.query;

    const query = {};

    if (purpose) {
      query.purpose = purpose;
    }

    if (status) {
      query.status = status;
    }

    if (search) {
      query.$or = [
        { outwardNumber: { $regex: search, $options: 'i' } },
        { recipientName: { $regex: search, $options: 'i' } },
        { department: { $regex: search, $options: 'i' } },
      ];
    }

    if (startDate || endDate) {
      query.outwardDate = {};
      if (startDate) query.outwardDate.$gte = new Date(startDate);
      if (endDate) query.outwardDate.$lte = new Date(endDate);
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [outwards, total] = await Promise.all([
      InventoryOutward.find(query)
        .populate(['items.product', 'items.batch', 'createdBy', 'issuedBy'])
        .sort({ outwardDate: -1 })
        .skip(skip)
        .limit(parseInt(limit)),
      InventoryOutward.countDocuments(query),
    ]);

    res.json({
      success: true,
      data: outwards,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (error) {
    console.error('Error fetching outwards:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching outwards',
      error: error.message,
    });
  }
};

// Get Outward by ID
export const getOutwardById = async (req, res) => {
  try {
    const outward = await InventoryOutward.findById(req.params.id)
      .populate([
        'items.product',
        'items.batch',
        'items.unit',
        'createdBy',
        'updatedBy',
        'approvedBy',
        'issuedBy',
      ]);

    if (!outward) {
      return res.status(404).json({
        success: false,
        message: 'Outward entry not found',
      });
    }

    res.json({
      success: true,
      data: outward,
    });
  } catch (error) {
    console.error('Error fetching outward:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching outward',
      error: error.message,
    });
  }
};

// Update Outward
export const updateOutward = async (req, res) => {
  try {
    const outward = await InventoryOutward.findById(req.params.id);

    if (!outward) {
      return res.status(404).json({
        success: false,
        message: 'Outward entry not found',
      });
    }

    if (outward.status === 'issued') {
      return res.status(400).json({
        success: false,
        message: 'Cannot update issued outward',
      });
    }

    const updateFields = [
      'purpose',
      'purposeDetails',
      'department',
      'recipientName',
      'recipientPhone',
      'destination',
      'items',
      'vehicleNumber',
      'driverName',
      'notes',
    ];

    updateFields.forEach((field) => {
      if (req.body[field] !== undefined) {
        outward[field] = req.body[field];
      }
    });

    // Recalculate total if items changed
    if (req.body.items) {
      let totalAmount = 0;
      outward.items.forEach((item) => {
        if (item.amount) {
          totalAmount += item.amount;
        }
      });
      outward.totalAmount = totalAmount;
    }

    outward.updatedBy = req.user._id;
    await outward.save();

    await outward.populate(['items.product', 'items.batch', 'items.unit']);

    res.json({
      success: true,
      message: 'Outward updated successfully',
      data: outward,
    });
  } catch (error) {
    console.error('Error updating outward:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating outward',
      error: error.message,
    });
  }
};

// Delete Outward
export const deleteOutward = async (req, res) => {
  try {
    const outward = await InventoryOutward.findById(req.params.id);

    if (!outward) {
      return res.status(404).json({
        success: false,
        message: 'Outward entry not found',
      });
    }

    if (outward.status === 'issued') {
      return res.status(400).json({
        success: false,
        message: 'Cannot delete issued outward',
      });
    }

    await InventoryOutward.deleteOne({ _id: req.params.id });

    res.json({
      success: true,
      message: 'Outward deleted successfully',
    });
  } catch (error) {
    console.error('Error deleting outward:', error);
    res.status(500).json({
      success: false,
      message: 'Error deleting outward',
      error: error.message,
    });
  }
};

// Get available batches for a product
export const getAvailableBatches = async (req, res) => {
  try {
    const { productId } = req.params;

    const batches = await Batch.find({
      product: productId,
      status: 'active',
      remainingQuantity: { $gt: 0 },
    })
      .populate(['product', 'unit', 'supplier'])
      .sort({ receivedDate: 1 }); // FIFO

    res.json({
      success: true,
      data: batches,
    });
  } catch (error) {
    console.error('Error fetching available batches:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching available batches',
      error: error.message,
    });
  }
};

