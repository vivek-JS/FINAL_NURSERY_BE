import express from 'express';
import InventoryTransaction from '../models/inventoryTransaction.model.js';
import { authenticateToken } from '../middlewares/auth.middleware.js';

const router = express.Router();

// All routes require authentication
router.use(authenticateToken);

// Get all transactions with filters
router.get('/', async (req, res) => {
  try {
    const {
      product,
      transactionType,
      startDate,
      endDate,
      page = 1,
      limit = 50,
    } = req.query;

    const query = {};

    if (product) {
      query.product = product;
    }

    if (transactionType) {
      query.transactionType = transactionType;
    }

    if (startDate || endDate) {
      query.transactionDate = {};
      if (startDate) query.transactionDate.$gte = new Date(startDate);
      if (endDate) query.transactionDate.$lte = new Date(endDate);
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [transactions, total] = await Promise.all([
      InventoryTransaction.find(query)
        .populate(['product', 'batch', 'unit', 'performedBy', 'approvedBy'])
        .sort({ transactionDate: -1 })
        .skip(skip)
        .limit(parseInt(limit)),
      InventoryTransaction.countDocuments(query),
    ]);

    res.json({
      success: true,
      data: transactions,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (error) {
    console.error('Error fetching transactions:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching transactions',
      error: error.message,
    });
  }
});

// Get transaction by ID
router.get('/:id', async (req, res) => {
  try {
    const transaction = await InventoryTransaction.findById(req.params.id)
      .populate(['product', 'batch', 'unit', 'performedBy', 'approvedBy']);

    if (!transaction) {
      return res.status(404).json({
        success: false,
        message: 'Transaction not found',
      });
    }

    res.json({
      success: true,
      data: transaction,
    });
  } catch (error) {
    console.error('Error fetching transaction:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching transaction',
      error: error.message,
    });
  }
});

export default router;

