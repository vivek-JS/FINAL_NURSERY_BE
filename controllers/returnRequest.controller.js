import ReturnRequest from "../models/returnRequest.model.js";
import Product from "../models/product.model.js";
import Batch from "../models/batch.model.js";
import InventoryTransaction from "../models/inventoryTransaction.model.js";
import mongoose from "mongoose";

// Get all return requests (with filters)
export const getAllReturnRequests = async (req, res) => {
  try {
    const { status, returnType, productId, requestedBy } = req.query;
    
    const filter = {};
    if (status) filter.status = status;
    if (returnType) filter.returnType = returnType;
    if (productId) filter.product = productId;
    if (requestedBy) filter.requestedBy = requestedBy;
    
    const returnRequests = await ReturnRequest.find(filter)
      .populate('product', 'name code')
      .populate('batch', 'batchNumber')
      .populate('unit', 'name abbreviation')
      .populate('requestedBy', 'name phoneNumber role')
      .populate('approvedBy', 'name phoneNumber role')
      .populate('rejectedBy', 'name phoneNumber role')
      .sort({ requestedDate: -1 });
    
    res.status(200).json({
      success: true,
      data: returnRequests,
      count: returnRequests.length
    });
  } catch (error) {
    console.error("Error fetching return requests:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching return requests",
      error: error.message
    });
  }
};

// Get return request by ID
export const getReturnRequestById = async (req, res) => {
  try {
    const { id } = req.params;
    
    const returnRequest = await ReturnRequest.findById(id)
      .populate('product', 'name code currentStock primaryUnit')
      .populate('batch', 'batchNumber remainingQuantity status')
      .populate('unit', 'name abbreviation')
      .populate('requestedBy', 'name phoneNumber role')
      .populate('approvedBy', 'name phoneNumber role')
      .populate('rejectedBy', 'name phoneNumber role')
      .populate('outwardId', 'outwardNumber outwardDate');
    
    if (!returnRequest) {
      return res.status(404).json({
        success: false,
        message: "Return request not found"
      });
    }
    
    res.status(200).json({
      success: true,
      data: returnRequest
    });
  } catch (error) {
    console.error("Error fetching return request:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching return request",
      error: error.message
    });
  }
};

// Approve return request (only ADMIN, SUPER_ADMIN, or INVENTORY_MANAGER)
export const approveReturnRequest = async (req, res) => {
  try {
    const { id } = req.params;
    const { remarks } = req.body;
    const approvedBy = req.user?._id;
    
    // Check user role - only ADMIN, SUPER_ADMIN can approve
    const userRole = req.user?.role;
    if (userRole !== 'ADMIN' && userRole !== 'SUPER_ADMIN') {
      return res.status(403).json({
        success: false,
        message: "Only ADMIN or SUPER_ADMIN can approve return requests"
      });
    }
    
    const returnRequest = await ReturnRequest.findById(id);
    if (!returnRequest) {
      return res.status(404).json({
        success: false,
        message: "Return request not found"
      });
    }
    
    if (returnRequest.status !== 'pending') {
      return res.status(400).json({
        success: false,
        message: `Return request is already ${returnRequest.status}`
      });
    }
    
    // Get product and batch details
    const product = await Product.findById(returnRequest.product);
    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Product not found"
      });
    }
    
    // Update return request status
    returnRequest.status = 'approved';
    returnRequest.approvedBy = approvedBy;
    returnRequest.approvedDate = new Date();
    if (remarks) returnRequest.remarks = remarks;
    
    await returnRequest.save();
    
    // Update product stock
    const balanceBefore = product.currentStock || 0;
    product.currentStock = balanceBefore + returnRequest.quantity;
    const balanceAfter = product.currentStock;
    await product.save();
    
    console.log(`✅ Approved return request ${returnRequest.requestNumber}: Added ${returnRequest.quantity} units to product ${product.name} stock: ${balanceBefore} -> ${balanceAfter}`);
    
    // Update batch if exists
    if (returnRequest.batch && mongoose.Types.ObjectId.isValid(returnRequest.batch)) {
      try {
        const batch = await Batch.findById(returnRequest.batch);
        if (batch) {
          const batchBefore = batch.remainingQuantity || 0;
          batch.remainingQuantity = batchBefore + returnRequest.quantity;
          if (batch.remainingQuantity > 0 && batch.status === 'exhausted') {
            batch.status = 'active';
          }
          await batch.save();
          console.log(`✅ Updated batch ${batch.batchNumber}: ${batchBefore} -> ${batch.remainingQuantity}`);
        }
      } catch (batchError) {
        console.error(`❌ Error updating batch:`, batchError);
        // Don't fail the whole request, just log the error
      }
    }
    
    // Create inventory transaction log
    try {
      const transactionNumber = await InventoryTransaction.generateTransactionNumber();
      const transaction = new InventoryTransaction({
        transactionNumber,
        transactionType: 'return',
        product: returnRequest.product,
        batch: returnRequest.batch || null,
        quantity: returnRequest.quantity,
        unit: returnRequest.unit,
        balanceBeforeTransaction: balanceBefore,
        balanceAfterTransaction: balanceAfter,
        rate: product.averagePrice || 0,
        value: (product.averagePrice || 0) * returnRequest.quantity,
        referenceType: returnRequest.referenceType,
        referenceId: returnRequest.referenceId,
        referenceNumber: returnRequest.referenceNumber,
        fromLocation: 'Sowing',
        toLocation: 'Main Warehouse',
        reason: returnRequest.reason,
        remarks: `Approved return request ${returnRequest.requestNumber}. ${returnRequest.remarks || ''}`,
        performedBy: returnRequest.requestedBy,
        approvedBy: approvedBy,
        metadata: {
          returnRequestId: returnRequest._id,
          returnRequestNumber: returnRequest.requestNumber,
          ...returnRequest.metadata
        }
      });
      await transaction.save();
      console.log(`✅ Created inventory transaction ${transactionNumber} for approved return`);
    } catch (transactionError) {
      console.error(`❌ Error creating inventory transaction:`, transactionError);
      // Don't fail the whole request, just log the error
    }
    
    // Populate and return updated return request
    const updatedReturnRequest = await ReturnRequest.findById(id)
      .populate('product', 'name code')
      .populate('batch', 'batchNumber')
      .populate('unit', 'name abbreviation')
      .populate('requestedBy', 'name phoneNumber role')
      .populate('approvedBy', 'name phoneNumber role');
    
    res.status(200).json({
      success: true,
      message: "Return request approved successfully",
      data: updatedReturnRequest
    });
  } catch (error) {
    console.error("Error approving return request:", error);
    res.status(500).json({
      success: false,
      message: "Error approving return request",
      error: error.message
    });
  }
};

// Reject return request
export const rejectReturnRequest = async (req, res) => {
  try {
    const { id } = req.params;
    const { rejectionReason } = req.body;
    const rejectedBy = req.user?._id;
    
    // Check user role - only ADMIN, SUPER_ADMIN can reject
    const userRole = req.user?.role;
    if (userRole !== 'ADMIN' && userRole !== 'SUPER_ADMIN') {
      return res.status(403).json({
        success: false,
        message: "Only ADMIN or SUPER_ADMIN can reject return requests"
      });
    }
    
    if (!rejectionReason) {
      return res.status(400).json({
        success: false,
        message: "Rejection reason is required"
      });
    }
    
    const returnRequest = await ReturnRequest.findById(id);
    if (!returnRequest) {
      return res.status(404).json({
        success: false,
        message: "Return request not found"
      });
    }
    
    if (returnRequest.status !== 'pending') {
      return res.status(400).json({
        success: false,
        message: `Return request is already ${returnRequest.status}`
      });
    }
    
    returnRequest.status = 'rejected';
    returnRequest.rejectedBy = rejectedBy;
    returnRequest.rejectedDate = new Date();
    returnRequest.rejectionReason = rejectionReason;
    
    await returnRequest.save();
    
    // Populate and return updated return request
    const updatedReturnRequest = await ReturnRequest.findById(id)
      .populate('product', 'name code')
      .populate('batch', 'batchNumber')
      .populate('unit', 'name abbreviation')
      .populate('requestedBy', 'name phoneNumber role')
      .populate('rejectedBy', 'name phoneNumber role');
    
    res.status(200).json({
      success: true,
      message: "Return request rejected",
      data: updatedReturnRequest
    });
  } catch (error) {
    console.error("Error rejecting return request:", error);
    res.status(500).json({
      success: false,
      message: "Error rejecting return request",
      error: error.message
    });
  }
};

// Get pending return requests count (for dashboard/notifications)
export const getPendingReturnRequestsCount = async (req, res) => {
  try {
    const count = await ReturnRequest.countDocuments({ status: 'pending' });
    
    res.status(200).json({
      success: true,
      count
    });
  } catch (error) {
    console.error("Error fetching pending return requests count:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching pending return requests count",
      error: error.message
    });
  }
};



