import Merchant from '../models/merchant.model.js';

// Create merchant
export const createMerchant = async (req, res) => {
  try {
    const {
      code,
      name,
      category,
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

    // Check if merchant code already exists
    const existingMerchant = await Merchant.findOne({ code });
    if (existingMerchant) {
      return res.status(400).json({
        success: false,
        message: 'Merchant code already exists',
      });
    }

    // Generate code if not provided
    const merchantCode = code || await Merchant.generateCode();

    const merchant = new Merchant({
      code: merchantCode,
      name,
      category: category || 'both',
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

    await merchant.save();
    await merchant.populate('createdBy');

    res.status(201).json({
      success: true,
      message: 'Merchant created successfully',
      data: merchant,
    });
  } catch (error) {
    console.error('Error creating merchant:', error);
    res.status(500).json({
      success: false,
      message: 'Error creating merchant',
      error: error.message,
    });
  }
};

// Get all merchants
export const getAllMerchants = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      search,
      isActive,
    } = req.query;

    const query = {};

    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { code: { $regex: search, $options: 'i' } },
        { phone: { $regex: search, $options: 'i' } },
        { contactPerson: { $regex: search, $options: 'i' } },
      ];
    }

    if (isActive !== undefined) {
      query.isActive = isActive === 'true';
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [merchants, total] = await Promise.all([
      Merchant.find(query)
        .populate('createdBy', 'name phoneNumber')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit)),
      Merchant.countDocuments(query),
    ]);

    res.json({
      success: true,
      data: merchants,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (error) {
    console.error('Error fetching merchants:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching merchants',
      error: error.message,
    });
  }
};

// Get merchant by ID
export const getMerchantById = async (req, res) => {
  try {
    const { id } = req.params;

    const merchant = await Merchant.findById(id).populate('createdBy', 'name phoneNumber');

    if (!merchant) {
      return res.status(404).json({
        success: false,
        message: 'Merchant not found',
      });
    }

    res.json({
      success: true,
      data: { merchant },
    });
  } catch (error) {
    console.error('Error fetching merchant:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching merchant',
      error: error.message,
    });
  }
};

// Update merchant
export const updateMerchant = async (req, res) => {
  try {
    const { id } = req.params;
    const updateData = req.body;

    const merchant = await Merchant.findByIdAndUpdate(
      id,
      { $set: updateData },
      { new: true, runValidators: true }
    ).populate('createdBy', 'name phoneNumber');

    if (!merchant) {
      return res.status(404).json({
        success: false,
        message: 'Merchant not found',
      });
    }

    res.json({
      success: true,
      message: 'Merchant updated successfully',
      data: merchant,
    });
  } catch (error) {
    console.error('Error updating merchant:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating merchant',
      error: error.message,
    });
  }
};

// Delete merchant
export const deleteMerchant = async (req, res) => {
  try {
    const { id } = req.params;

    const merchant = await Merchant.findByIdAndDelete(id);

    if (!merchant) {
      return res.status(404).json({
        success: false,
        message: 'Merchant not found',
      });
    }

    res.json({
      success: true,
      message: 'Merchant deleted successfully',
    });
  } catch (error) {
    console.error('Error deleting merchant:', error);
    res.status(500).json({
      success: false,
      message: 'Error deleting merchant',
      error: error.message,
    });
  }
};

// Get merchant ledger (payments, orders, products)
export const getMerchantLedger = async (req, res) => {
  try {
    const { id } = req.params;
    const { startDate, endDate } = req.query;

    const merchant = await Merchant.findById(id);
    if (!merchant) {
      return res.status(404).json({
        success: false,
        message: 'Merchant not found',
      });
    }

    // Import models dynamically to avoid circular dependencies
    const MerchantSellOrder = (await import('../models/sellOrder.model.js')).default;
    const Payment = (await import('../models/payment.model.js')).default || null;

    // Build date filter
    const dateFilter = {};
    if (startDate || endDate) {
      dateFilter.createdAt = {};
      if (startDate) dateFilter.createdAt.$gte = new Date(startDate);
      if (endDate) dateFilter.createdAt.$lte = new Date(endDate);
    }

    // Get orders
    const orders = await MerchantSellOrder.find({ merchant: id, ...dateFilter })
      .populate('items.product', 'name code category')
      .sort({ createdAt: -1 });

    // Get all payments from sell orders (unwind payments array)
    const ordersWithPayments = await MerchantSellOrder.find({ merchant: id, ...dateFilter })
      .select('payment orderNumber orderDate totalAmount')
      .sort({ createdAt: -1 });

    // Extract and flatten all payments from orders
    const payments = [];
    ordersWithPayments.forEach(order => {
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

    res.json({
      success: true,
      data: {
        merchant: {
          ...merchant.toObject(),
          totalOrderValue,
          totalPaidAmount,
          outstandingAmount,
        },
        orders: orders.map(order => ({
          orderNumber: order.orderNumber,
          orderDate: order.orderDate,
          totalAmount: order.totalAmount,
          paymentStatus: order.paymentStatus,
          status: order.status,
          items: order.items,
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
    console.error('Error fetching merchant ledger:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching merchant ledger',
      error: error.message,
    });
  }
};

