import MerchantSellOrder from '../models/sellOrder.model.js';
import Merchant from '../models/merchant.model.js';
import Product from '../models/product.model.js';
import Batch from '../models/batch.model.js';
import InventoryTransaction from '../models/inventoryTransaction.model.js';

// Create Sell Order
export const createSellOrder = async (req, res) => {
  try {
    const {
      merchant,
      buyerName,
      buyerVillage,
      orderDate,
      deliveryDate,
      items,
      discountAmount,
      gstAmount,
      otherCharges,
      vehicleDetails,
      notes,
      payment,
    } = req.body;

    // Validate: Either merchant or buyerName must be provided
    if (!merchant && !buyerName) {
      return res.status(400).json({
        success: false,
        message: 'Either merchant or buyer name must be provided',
      });
    }

    // Validate stock availability for all items before creating order
    for (const item of items) {
      if (!item.product) {
        return res.status(400).json({
          success: false,
          message: 'Product ID is required for all items',
        });
      }

      const product = await Product.findById(item.product);
      if (!product) {
        return res.status(404).json({
          success: false,
          message: `Product not found: ${item.product}`,
        });
      }

      // Check if sufficient stock is available
      if (product.currentStock < item.quantity) {
        return res.status(400).json({
          success: false,
          message: `Insufficient stock for ${product.name}. Available: ${product.currentStock}, Required: ${item.quantity}`,
        });
      }

      // If batch number is provided, validate batch availability
      if (item.batchNumber && item.batchNumber.trim()) {
        const batch = await Batch.findOne({
          batchNumber: item.batchNumber.trim(),
          product: product._id,
        });

        if (!batch) {
          return res.status(404).json({
            success: false,
            message: `Batch ${item.batchNumber} not found for product ${product.name}`,
          });
        }

        if (batch.remainingQuantity < item.quantity) {
          return res.status(400).json({
            success: false,
            message: `Insufficient stock in batch ${batch.batchNumber} for ${product.name}. Available: ${batch.remainingQuantity}, Required: ${item.quantity}`,
          });
        }

        if (batch.status !== 'active') {
          return res.status(400).json({
            success: false,
            message: `Batch ${batch.batchNumber} is not active`,
          });
        }
      }
    }

    // Generate order number
    const orderNumber = await MerchantSellOrder.generateOrderNumber();

    // Calculate totals
    let subtotal = 0;
    let totalGstAmount = 0;
    let totalDiscountAmount = discountAmount || 0;

    items.forEach((item) => {
      const itemSubtotal = item.quantity * item.rate;
      const itemDiscount = (itemSubtotal * (item.discount || 0)) / 100;
      const itemGst = ((itemSubtotal - itemDiscount) * (item.gst || 0)) / 100;
      
      item.amount = itemSubtotal - itemDiscount + itemGst;
      subtotal += itemSubtotal;
      totalGstAmount += itemGst;
      totalDiscountAmount += itemDiscount;
    });

    const totalAmount = subtotal - totalDiscountAmount + (gstAmount || totalGstAmount) + (otherCharges || 0);

    // Calculate initial payment status
    let paymentStatus = 'pending';
    let paidAmount = 0;
    if (payment && payment.length > 0) {
      paidAmount = payment
        .filter(p => p.paymentStatus === 'COLLECTED')
        .reduce((sum, p) => sum + p.paidAmount, 0);
      
      if (paidAmount >= totalAmount) {
        paymentStatus = 'paid';
      } else if (paidAmount > 0) {
        paymentStatus = 'partial';
      }
    }

    const sellOrder = new MerchantSellOrder({
      orderNumber,
      merchant: merchant || null,
      buyerName: buyerName || null,
      buyerVillage: buyerVillage || null,
      orderDate: orderDate || new Date(),
      deliveryDate,
      items,
      subtotal,
      discountAmount: totalDiscountAmount,
      gstAmount: gstAmount || totalGstAmount,
      otherCharges: otherCharges || 0,
      totalAmount,
      payment: payment || [],
      paymentStatus,
      paidAmount,
      vehicleDetails: vehicleDetails || null,
      notes: notes || null,
      createdBy: req.user._id,
    });

    await sellOrder.save();
    await sellOrder.populate(['merchant', 'items.product', 'items.unit', 'createdBy']);

    // Update merchant totals only if merchant is provided
    if (merchant) {
      await Merchant.findByIdAndUpdate(merchant, {
        $inc: {
          totalOrderValue: totalAmount,
          totalPaidAmount: paidAmount,
          outstandingAmount: totalAmount - paidAmount,
        },
      });
    }

    res.status(201).json({
      success: true,
      message: 'Sell Order created successfully',
      data: sellOrder,
    });
  } catch (error) {
    console.error('Error creating sell order:', error);
    res.status(500).json({
      success: false,
      message: 'Error creating sell order',
      error: error.message,
    });
  }
};

// Get all Sell Orders
export const getAllSellOrders = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      search,
      merchant,
      status,
      paymentStatus,
      startDate,
      endDate,
    } = req.query;

    const query = {};

    if (search) {
      query.$or = [
        { orderNumber: { $regex: search, $options: 'i' } },
      ];
    }

    if (merchant) {
      query.merchant = merchant;
    }

    if (status) {
      query.status = status;
    }

    if (paymentStatus) {
      query.paymentStatus = paymentStatus;
    }

    if (startDate || endDate) {
      query.orderDate = {};
      if (startDate) query.orderDate.$gte = new Date(startDate);
      if (endDate) query.orderDate.$lte = new Date(endDate);
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [orders, total] = await Promise.all([
      MerchantSellOrder.find(query)
        .populate('merchant', 'name code phone')
        .populate('items.product', 'name code category')
        .populate('items.unit', 'name symbol')
        .populate('createdBy', 'name phoneNumber')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit)),
      MerchantSellOrder.countDocuments(query),
    ]);

    res.json({
      success: true,
      data: orders,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (error) {
    console.error('Error fetching sell orders:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching sell orders',
      error: error.message,
    });
  }
};

// Get sell order by ID
export const getSellOrderById = async (req, res) => {
  try {
    const { id } = req.params;

    const order = await MerchantSellOrder.findById(id)
      .populate('merchant')
      .populate('items.product')
      .populate('items.unit')
      .populate('createdBy', 'name phoneNumber');

    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Sell Order not found',
      });
    }

    res.json({
      success: true,
      data: { order },
    });
  } catch (error) {
    console.error('Error fetching sell order:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching sell order',
      error: error.message,
    });
  }
};

// Update sell order
export const updateSellOrder = async (req, res) => {
  try {
    const { id } = req.params;
    const updateData = req.body;

    const order = await MerchantSellOrder.findById(id);
    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Sell Order not found',
      });
    }

    // If payment is being updated, recalculate totals
    if (updateData.payment) {
      order.payment = updateData.payment;
      order.calculatePaymentTotals();
    }

    // Update other fields
    Object.keys(updateData).forEach(key => {
      if (key !== 'payment' && key !== '_id') {
        order[key] = updateData[key];
      }
    });

    await order.save();
    await order.populate(['merchant', 'items.product', 'items.unit', 'createdBy']);

    // Update merchant totals
    const paymentTotals = order.calculatePaymentTotals();
    await Merchant.findByIdAndUpdate(order.merchant, {
      $set: {
        totalPaidAmount: paymentTotals.totalPaid,
        outstandingAmount: paymentTotals.remaining,
      },
    });

    res.json({
      success: true,
      message: 'Sell Order updated successfully',
      data: order,
    });
  } catch (error) {
    console.error('Error updating sell order:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating sell order',
      error: error.message,
    });
  }
};

// Add payment to sell order
export const addPayment = async (req, res) => {
  try {
    const { id } = req.params;
    const paymentData = req.body;

    const order = await MerchantSellOrder.findById(id);
    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Sell Order not found',
      });
    }

    // Add payment
    order.payment.push(paymentData);
    order.calculatePaymentTotals();
    await order.save();

    // Update merchant totals only if merchant exists
    const paymentTotals = order.calculatePaymentTotals();
    if (order.merchant) {
      await Merchant.findByIdAndUpdate(order.merchant, {
        $inc: {
          totalPaidAmount: paymentData.paidAmount,
          outstandingAmount: -paymentData.paidAmount,
        },
      });
    }

    await order.populate(['merchant', 'items.product', 'items.unit', 'createdBy']);

    res.json({
      success: true,
      message: 'Payment added successfully',
      data: order,
    });
  } catch (error) {
    console.error('Error adding payment:', error);
    res.status(500).json({
      success: false,
      message: 'Error adding payment',
      error: error.message,
    });
  }
};

// Delete sell order
export const deleteSellOrder = async (req, res) => {
  try {
    const { id } = req.params;

    const order = await MerchantSellOrder.findByIdAndDelete(id);

    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Sell Order not found',
      });
    }

    // Update merchant totals (subtract)
    await Merchant.findByIdAndUpdate(order.merchant, {
      $inc: {
        totalOrderValue: -order.totalAmount,
        totalPaidAmount: -order.paidAmount,
        outstandingAmount: -(order.totalAmount - order.paidAmount),
      },
    });

    res.json({
      success: true,
      message: 'Sell Order deleted successfully',
    });
  } catch (error) {
    console.error('Error deleting sell order:', error);
    res.status(500).json({
      success: false,
      message: 'Error deleting sell order',
      error: error.message,
    });
  }
};

// Approve Sell Order (reduce stock and create inventory transactions)
export const approveSellOrder = async (req, res) => {
  try {
    const { id } = req.params;
    const { qualityCheckRemarks } = req.body;

    const order = await MerchantSellOrder.findById(id)
      .populate('items.product')
      .populate('items.unit');

    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Sell Order not found',
      });
    }

    if (order.status !== 'draft' && order.status !== 'pending') {
      return res.status(400).json({
        success: false,
        message: `Cannot approve order with status: ${order.status}`,
      });
    }

    // Validate stock availability and update stock
    for (const item of order.items) {
      const product = await Product.findById(item.product._id || item.product);
      
      if (!product) {
        return res.status(404).json({
          success: false,
          message: `Product not found: ${item.product.name || item.product}`,
        });
      }

      // Check if sufficient stock is available
      if (product.currentStock < item.quantity) {
        return res.status(400).json({
          success: false,
          message: `Insufficient stock for ${product.name}. Available: ${product.currentStock}, Required: ${item.quantity}`,
        });
      }

      // If batch number is provided, validate and update batch
      if (item.batchNumber && item.batchNumber.trim()) {
        const batch = await Batch.findOne({
          batchNumber: item.batchNumber.trim(),
          product: product._id,
        });

        if (!batch) {
          return res.status(404).json({
            success: false,
            message: `Batch ${item.batchNumber} not found for product ${product.name}`,
          });
        }

        if (batch.remainingQuantity < item.quantity) {
          return res.status(400).json({
            success: false,
            message: `Insufficient stock in batch ${batch.batchNumber}. Available: ${batch.remainingQuantity}, Required: ${item.quantity}`,
          });
        }

        if (batch.status !== 'active') {
          return res.status(400).json({
            success: false,
            message: `Batch ${batch.batchNumber} is not active`,
          });
        }

        // Update batch quantity
        batch.remainingQuantity -= item.quantity;
        if (batch.remainingQuantity <= 0) {
          batch.status = 'exhausted';
        }
        await batch.save();
      }

      // Calculate stock values before update
      const balanceBefore = product.currentStock;
      const balanceAfter = balanceBefore - item.quantity;
      const stockValueBefore = product.stockValue || 0;
      
      // Update product stock
      product.currentStock = balanceAfter;
      
      // Calculate new stock value (using average price method)
      if (product.currentStock > 0 && product.averagePrice > 0) {
        product.stockValue = product.currentStock * product.averagePrice;
      } else {
        product.stockValue = 0;
      }

      await product.save();

      // Find batch if batch number is provided
      let batchId = null;
      if (item.batchNumber && item.batchNumber.trim()) {
        const batch = await Batch.findOne({
          batchNumber: item.batchNumber.trim(),
          product: product._id,
        });
        if (batch) {
          batchId = batch._id;
        }
      }

      // Create inventory transaction
      const transactionNumber = await InventoryTransaction.generateTransactionNumber();
      const transaction = new InventoryTransaction({
        transactionNumber,
        transactionType: 'outward',
        product: product._id,
        batch: batchId,
        quantity: item.quantity,
        unit: item.unit._id || item.unit,
        balanceBeforeTransaction: balanceBefore,
        balanceAfterTransaction: balanceAfter,
        rate: item.rate || 0,
        value: (item.rate || 0) * item.quantity,
        referenceType: 'SellOrder',
        referenceId: order._id,
        referenceNumber: order.orderNumber,
        fromLocation: 'Main Warehouse',
        toLocation: order.merchant?.name || order.buyerName || 'Customer',
        reason: 'Sale',
        remarks: qualityCheckRemarks || `Sell order ${order.orderNumber}`,
        performedBy: req.user._id,
        approvedBy: req.user._id,
      });

      await transaction.save();
    }

    // Update order status
    order.status = 'confirmed';
    if (qualityCheckRemarks) {
      order.notes = (order.notes || '') + (order.notes ? '\n' : '') + `Quality Check: ${qualityCheckRemarks}`;
    }
    await order.save();
    await order.populate(['merchant', 'items.product', 'items.unit', 'createdBy']);

    res.json({
      success: true,
      message: 'Sell Order approved successfully',
      data: order,
    });
  } catch (error) {
    console.error('Error approving sell order:', error);
    res.status(500).json({
      success: false,
      message: 'Error approving sell order',
      error: error.message,
    });
  }
};

// Get all pending payments for sell orders (for accountant)
export const getPendingPayments = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 100,
      search,
      startDate,
      endDate,
      paymentStatus = 'PENDING',
    } = req.query;

    const query = {};

    // Search filtering (on order fields, not payment)
    if (search) {
      query.$or = [
        { orderNumber: { $regex: search, $options: 'i' } },
        { buyerName: { $regex: search, $options: 'i' } },
      ];
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    // Use aggregation to unwind payments and filter
    const pipeline = [
      { $match: query },
      { $unwind: { path: '$payment', preserveNullAndEmptyArrays: false } },
      {
        $match: {
          ...(paymentStatus ? { 'payment.paymentStatus': paymentStatus } : {}),
          ...(startDate || endDate ? {
            'payment.paymentDate': {
              ...(startDate ? {
                $gte: (() => {
                  const [day, month, year] = startDate.split('-');
                  return new Date(`${year}-${month}-${day}T00:00:00.000Z`);
                })()
              } : {}),
              ...(endDate ? {
                $lte: (() => {
                  const [day, month, year] = endDate.split('-');
                  return new Date(`${year}-${month}-${day}T23:59:59.999Z`);
                })()
              } : {}),
            }
          } : {}),
        },
      },
      {
        $lookup: {
          from: 'merchants',
          localField: 'merchant',
          foreignField: '_id',
          as: 'merchantData',
        },
      },
      {
        $lookup: {
          from: 'users',
          localField: 'createdBy',
          foreignField: '_id',
          as: 'createdByData',
        },
      },
      {
        $project: {
          _id: 1,
          orderNumber: 1,
          merchant: { $arrayElemAt: ['$merchantData', 0] },
          buyerName: 1,
          buyerVillage: 1,
          orderDate: 1,
          totalAmount: 1,
          paymentStatus: 1,
          paidAmount: 1,
          status: 1,
          payment: 1,
          createdBy: { $arrayElemAt: ['$createdByData', 0] },
          createdAt: 1,
        },
      },
      { $sort: { 'payment.paymentDate': -1 } },
      { $skip: skip },
      { $limit: parseInt(limit) },
    ];

    const [payments, totalCountResult] = await Promise.all([
      MerchantSellOrder.aggregate(pipeline),
      MerchantSellOrder.aggregate([
        { $match: query },
        { $unwind: '$payment' },
        {
          $match: paymentStatus ? { 'payment.paymentStatus': paymentStatus } : {},
        },
        { $count: 'total' },
      ]),
    ]);

    const total = totalCountResult[0]?.total || 0;

    res.json({
      success: true,
      data: payments,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (error) {
    console.error('Error fetching pending payments:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching pending payments',
      error: error.message,
    });
  }
};

// Update payment status for sell order (accept/reject)
export const updateSellOrderPaymentStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { paymentId, paymentStatus, remark } = req.body;

    if (!paymentId || !paymentStatus) {
      return res.status(400).json({
        success: false,
        message: 'Payment ID and Payment Status are required',
      });
    }

    const order = await MerchantSellOrder.findById(id);
    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Sell Order not found',
      });
    }

    // Find and update the payment
    const paymentIndex = order.payment.findIndex(
      (p) => p._id.toString() === paymentId
    );

    if (paymentIndex === -1) {
      return res.status(404).json({
        success: false,
        message: 'Payment not found',
      });
    }

    // Update payment status
    order.payment[paymentIndex].paymentStatus = paymentStatus;
    if (remark) {
      order.payment[paymentIndex].remark = remark;
    }
    if (paymentStatus === 'COLLECTED') {
      order.payment[paymentIndex].collectedBy = req.user._id;
      order.payment[paymentIndex].collectedAt = new Date();
    }

    // Recalculate payment totals
    order.calculatePaymentTotals();
    await order.save();

    // Update merchant totals only if merchant exists
    if (order.merchant) {
      const paymentTotals = order.calculatePaymentTotals();
      await Merchant.findByIdAndUpdate(order.merchant, {
        $set: {
          totalPaidAmount: paymentTotals.totalPaid,
          outstandingAmount: paymentTotals.remaining,
        },
      });
    }

    await order.populate(['merchant', 'items.product', 'items.unit', 'createdBy']);

    res.json({
      success: true,
      message: 'Payment status updated successfully',
      data: order,
    });
  } catch (error) {
    console.error('Error updating payment status:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating payment status',
      error: error.message,
    });
  }
};

// Get farmer ledger (for sell orders created with farmer name)
export const getFarmerLedger = async (req, res) => {
  try {
    const { farmerName, mobileNumber } = req.query;

    if (!farmerName && !mobileNumber) {
      return res.status(400).json({
        success: false,
        message: 'Either farmer name or mobile number is required',
      });
    }

    // Build query to find sell orders by farmer name or mobile
    const query = {};
    if (farmerName) {
      query.buyerName = { $regex: farmerName, $options: 'i' };
    }

    // If mobile number provided, try to find farmer and match by name
    if (mobileNumber) {
      try {
        const Farmer = (await import('../models/farmer.model.js')).default;
        const farmer = await Farmer.findOne({ mobileNumber: parseInt(mobileNumber) });
        if (farmer) {
          query.$or = [
            { buyerName: { $regex: farmer.name, $options: 'i' } },
            { buyerName: { $regex: farmerName || '', $options: 'i' } },
          ];
        }
      } catch (err) {
        console.log('Farmer model not found, using buyerName only');
      }
    }

    // Get all sell orders for this farmer
    const orders = await MerchantSellOrder.find(query)
      .populate('items.product', 'name code category')
      .populate('items.unit', 'name abbreviation')
      .sort({ createdAt: -1 });

    if (orders.length === 0) {
      return res.json({
        success: true,
        data: {
          farmer: {
            name: farmerName || 'Unknown',
            mobileNumber: mobileNumber || null,
          },
          orders: [],
          payments: [],
          productLedger: [],
          summary: {
            totalOrders: 0,
            totalOrderValue: 0,
            totalPaidAmount: 0,
            totalPendingPayments: 0,
            outstandingAmount: 0,
            totalProducts: 0,
            totalPayments: 0,
            collectedPayments: 0,
            pendingPayments: 0,
          },
        },
      });
    }

    // Extract and flatten all payments from orders
    const payments = [];
    orders.forEach(order => {
      if (order.payment && Array.isArray(order.payment)) {
        order.payment.forEach(payment => {
          payments.push({
            ...payment.toObject(),
            orderNumber: order.orderNumber,
            orderDate: order.orderDate,
            orderTotalAmount: order.totalAmount,
          });
        });
      }
    });

    // Sort payments by date (most recent first)
    payments.sort((a, b) => new Date(b.paymentDate) - new Date(a.paymentDate));

    // Calculate totals
    const totalOrderValue = orders.reduce((sum, order) => sum + (order.totalAmount || 0), 0);
    const totalPaidAmount = payments.reduce((sum, payment) => {
      return sum + (payment.paymentStatus === 'COLLECTED' ? (payment.paidAmount || 0) : 0);
    }, 0);
    const totalPendingPayments = payments.reduce((sum, payment) => {
      return sum + (payment.paymentStatus === 'PENDING' ? (payment.paidAmount || 0) : 0);
    }, 0);
    const outstandingAmount = totalOrderValue - totalPaidAmount;

    // Product ledger - aggregate by product
    const productLedger = {};
    orders.forEach(order => {
      order.items.forEach(item => {
        const productId = item.product?._id || item.product;
        const productName = item.product?.name || 'Unknown';
        if (!productLedger[productId]) {
          productLedger[productId] = {
            productId,
            productName,
            totalQuantity: 0,
            totalValue: 0,
            orders: [],
          };
        }
        productLedger[productId].totalQuantity += item.quantity || 0;
        productLedger[productId].totalValue += item.amount || 0;
        productLedger[productId].orders.push({
          orderId: order.orderNumber,
          quantity: item.quantity,
          amount: item.amount,
          date: order.createdAt,
        });
      });
    });

    // Get farmer details if mobile number provided
    let farmerDetails = {
      name: farmerName || orders[0]?.buyerName || 'Unknown',
      mobileNumber: mobileNumber || null,
      village: orders[0]?.buyerVillage || null,
    };

    if (mobileNumber) {
      try {
        const Farmer = (await import('../models/farmer.model.js')).default;
        const farmer = await Farmer.findOne({ mobileNumber: parseInt(mobileNumber) });
        if (farmer) {
          farmerDetails = {
            name: farmer.name,
            mobileNumber: farmer.mobileNumber,
            village: farmer.village,
            taluka: farmer.taluka,
            district: farmer.district,
            state: farmer.state,
          };
        }
      } catch (err) {
        console.log('Could not fetch farmer details');
      }
    }

    res.json({
      success: true,
      data: {
        farmer: farmerDetails,
        orders: orders.map(order => ({
          _id: order._id,
          orderNumber: order.orderNumber,
          orderDate: order.orderDate,
          deliveryDate: order.deliveryDate,
          totalAmount: order.totalAmount,
          paymentStatus: order.paymentStatus,
          status: order.status,
          items: order.items.map(item => ({
            product: item.product,
            quantity: item.quantity,
            unit: item.unit,
            rate: item.rate,
            amount: item.amount,
          })),
          createdAt: order.createdAt,
        })),
        payments: payments.map(payment => ({
          paymentId: payment._id,
          paidAmount: payment.paidAmount,
          paymentDate: payment.paymentDate,
          paymentStatus: payment.paymentStatus,
          modeOfPayment: payment.modeOfPayment,
          bankName: payment.bankName,
          transactionId: payment.transactionId,
          chequeNumber: payment.chequeNumber,
          upiId: payment.upiId,
          receiptPhoto: payment.receiptPhoto,
          remark: payment.remark,
          orderNumber: payment.orderNumber,
          orderDate: payment.orderDate,
          orderTotalAmount: payment.orderTotalAmount,
          collectedBy: payment.collectedBy,
          collectedAt: payment.collectedAt,
        })),
        productLedger: Object.values(productLedger),
        summary: {
          totalOrders: orders.length,
          totalOrderValue,
          totalPaidAmount,
          totalPendingPayments,
          outstandingAmount,
          totalProducts: Object.keys(productLedger).length,
          totalPayments: payments.length,
          collectedPayments: payments.filter(p => p.paymentStatus === 'COLLECTED').length,
          pendingPayments: payments.filter(p => p.paymentStatus === 'PENDING').length,
        },
      },
    });
  } catch (error) {
    console.error('Error fetching farmer ledger:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching farmer ledger',
      error: error.message,
    });
  }
};

