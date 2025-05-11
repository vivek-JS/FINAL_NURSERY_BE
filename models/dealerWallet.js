import mongoose, { Schema, model } from "mongoose";

// Schema for individual wallet entries
const walletEntrySchema = new Schema({
  plantType: {
    type: Schema.Types.ObjectId,
    ref: "PlantCms",
    required: true
  },
  subType: {
    type: Schema.Types.ObjectId,
    ref: "PlantCms.subtypes",
    required: true
  },
  bookingSlot: {
    type: Schema.Types.ObjectId,
    ref: "PlantSlot.subtypeSlots",
  },
  quantity: {
    type: Number,
    default: 0
  },
  bookedQuantity: {
    type: Number,
    default: 0
  },
  remainingQuantity: {
    type: Number,
    default: 0
  }
}, { _id: true });

// Pre-save middleware to calculate remaining quantity
walletEntrySchema.pre('save', function(next) {
  this.remainingQuantity = this.quantity - this.bookedQuantity;
  next();
});

// Transaction schema to record all financial and inventory movements
const transactionSchema = new Schema({
  type: {
    type: String,
    enum: ['CREDIT', 'DEBIT', 'INVENTORY_ADD', 'INVENTORY_BOOK', 'INVENTORY_RELEASE'],
    required: true
  },
  amount: {
    type: Number,
    required: true
  },
  balanceBefore: {
    type: Number,
    required: true
  },
  balanceAfter: {
    type: Number,
    required: true
  },
  description: {
    type: String,
    required: true
  },
  plantType: {
    type: Schema.Types.ObjectId,
    ref: "PlantCms"
  },
  subType: {
    type: Schema.Types.ObjectId,
    ref: "PlantCms.subtypes"
  },
  bookingSlot: {
    type: Schema.Types.ObjectId,
    ref: "PlantSlot.subtypeSlots"
  },
  quantity: {
    type: Number
  },
  reference: {
    type: String
  },
  referenceId: {
    type: Schema.Types.ObjectId
  },
  performedBy: {
    type: Schema.Types.ObjectId,
    ref: "User",
    required: true
  },
  status: {
    type: String,
    enum: ['PENDING', 'COMPLETED', 'FAILED', 'CANCELLED'],
    default: 'COMPLETED'
  }
}, { 
  timestamps: true 
});

// Main dealer wallet schema
const dealerWalletSchema = new Schema({
  dealer: {
    type: Schema.Types.ObjectId,
    ref: "User",
    required: true,
    unique: true
  },
  availableAmount: {
    type: Number,
    default: 0
  },
  entries: [walletEntrySchema],
  transactions: [transactionSchema]
}, { 
  timestamps: true 
});

// Indexes for better query performance
dealerWalletSchema.index({ dealer: 1 });
dealerWalletSchema.index({ "entries.plantType": 1 });
dealerWalletSchema.index({ "entries.subType": 1 });
dealerWalletSchema.index({ "entries.bookingSlot": 1 });
dealerWalletSchema.index({ "transactions.createdAt": -1 });
dealerWalletSchema.index({ "transactions.type": 1 });
dealerWalletSchema.index({ "transactions.referenceId": 1 });
dealerWalletSchema.index({ "transactions.status": 1 });

/**
 * DEBUG ENHANCED: Add transaction with comprehensive debugging
 */
dealerWalletSchema.statics.addTransaction = async function(
  dealerId, 
  type, 
  amount, 
  description, 
  performedBy, 
  reference = null, 
  referenceId = null,
  plantDetails = {},
  status = 'COMPLETED'
) {
  console.log('\n========== WALLET TRANSACTION DEBUGGING ==========');
  console.log('Method called: addTransaction');
  console.log('Parameters:');
  console.log('- dealerId:', dealerId, typeof dealerId);
  console.log('- type:', type);
  console.log('- amount:', amount, typeof amount);
  console.log('- description:', description);
  console.log('- performedBy:', performedBy, typeof performedBy);
  console.log('- reference:', reference);
  console.log('- referenceId:', referenceId);
  
  // Validate required parameters
  if (!dealerId) {
    console.error('ERROR: dealerId is required');
    throw new Error('dealerId is required');
  }
  if (!type) {
    console.error('ERROR: type is required');
    throw new Error('type is required');
  }
  if (amount === undefined || amount === null) {
    console.error('ERROR: amount is required');
    throw new Error('amount is required');
  }
  if (!description) {
    console.error('ERROR: description is required');
    throw new Error('description is required');
  }
  if (!performedBy) {
    console.error('ERROR: performedBy is required');
    throw new Error('performedBy is required');
  }
  
  // Make sure amount is a number
  amount = Number(amount);
  if (isNaN(amount)) {
    console.error('ERROR: amount must be a valid number');
    throw new Error('amount must be a valid number');
  }
  
  console.log('All parameters validated');
  
  // Check if dealerId is already an ObjectId
  let dealerObjectId;
  try {
    if (dealerId instanceof mongoose.Types.ObjectId) {
      dealerObjectId = dealerId;
      console.log('dealerId is already an ObjectId instance');
    } else {
      dealerObjectId = new mongoose.Types.ObjectId(dealerId.toString());
      console.log('dealerId converted to ObjectId:', dealerObjectId);
    }
  } catch (err) {
    console.error('ERROR: Failed to convert dealerId to ObjectId:', err.message);
    throw new Error(`Invalid dealerId format: ${dealerId}`);
  }
  
  // Check if performedBy is already an ObjectId
  let performedByObjectId;
  try {
    if (performedBy instanceof mongoose.Types.ObjectId) {
      performedByObjectId = performedBy;
      console.log('performedBy is already an ObjectId instance');
    } else {
      performedByObjectId = new mongoose.Types.ObjectId(performedBy.toString());
      console.log('performedBy converted to ObjectId:', performedByObjectId);
    }
  } catch (err) {
    console.error('ERROR: Failed to convert performedBy to ObjectId:', err.message);
    throw new Error(`Invalid performedBy format: ${performedBy}`);
  }
  
  const session = await mongoose.startSession();
  session.startTransaction();
  console.log('Transaction session started');
  
  try {
    // First, find the wallet using the dealerObjectId
    console.log('Searching for wallet with dealer:', dealerObjectId);
    let wallet = await this.findOne({ dealer: dealerObjectId }).session(session);
    
    // Log the found wallet or create a new one
    if (wallet) {
      console.log('Existing wallet found:', wallet._id);
      console.log('Current wallet state:');
      console.log('- availableAmount:', wallet.availableAmount);
      console.log('- transactions count:', wallet.transactions ? wallet.transactions.length : 0);
    } else {
      console.log('No wallet found, creating new wallet');
      try {
        // Create a new wallet
        const newWallet = new this({
          dealer: dealerObjectId,
          availableAmount: 0,
          entries: [],
          transactions: []
        });
        await newWallet.save({ session });
        wallet = newWallet;
        console.log('New wallet created with ID:', wallet._id);
      } catch (createErr) {
        console.error('ERROR: Failed to create new wallet:', createErr);
        throw createErr;
      }
    }
    
    // Calculate balance changes
    const balanceBefore = wallet.availableAmount || 0;
    let balanceAfter = balanceBefore;
    
    console.log('Processing transaction type:', type);
    // Update wallet balance based on transaction type
    switch (type) {
      case 'CREDIT':
        balanceAfter = balanceBefore + amount;
        console.log(`CREDIT: ${balanceBefore} + ${amount} = ${balanceAfter}`);
        break;
      case 'DEBIT':
        if (balanceBefore < amount) {
          console.error(`ERROR: Insufficient balance: ${balanceBefore} < ${amount}`);
          throw new Error(`Insufficient balance: ${balanceBefore} < ${amount}`);
        }
        balanceAfter = balanceBefore - amount;
        console.log(`DEBIT: ${balanceBefore} - ${amount} = ${balanceAfter}`);
        break;
      case 'INVENTORY_ADD':
      case 'INVENTORY_BOOK':
      case 'INVENTORY_RELEASE':
        if (amount !== 0) {
          balanceAfter = type === 'INVENTORY_ADD' ? balanceBefore + amount : balanceBefore - amount;
          console.log(`${type}: Balance change from ${balanceBefore} to ${balanceAfter}`);
        } else {
          console.log(`${type}: No balance change (amount is 0)`);
        }
        break;
      default:
        console.error(`ERROR: Invalid transaction type: ${type}`);
        throw new Error(`Invalid transaction type: ${type}`);
    }
    
    // Process referenceId if provided
    let referenceIdObj = null;
    if (referenceId) {
      try {
        if (referenceId instanceof mongoose.Types.ObjectId) {
          referenceIdObj = referenceId;
        } else {
          referenceIdObj = new mongoose.Types.ObjectId(referenceId.toString());
        }
        console.log('referenceId converted to ObjectId:', referenceIdObj);
      } catch (err) {
        console.error('WARNING: Invalid referenceId format - using as is:', referenceId);
        referenceIdObj = referenceId;
      }
    }
    
    // Create the transaction record
    console.log('Creating transaction record');
    const transaction = {
      type,
      amount,
      balanceBefore,
      balanceAfter,
      description,
      performedBy: performedByObjectId,
      reference,
      referenceId: referenceIdObj,
      status,
      ...plantDetails
    };
    
    console.log('Transaction object created');
    
    // Now try THREE different approaches to ensure one works
    
    // APPROACH 1: Direct push and save
    // console.log('APPROACH 1: Direct push and save');
    // try {
    //   console.log('Current transactions array length:', wallet.transactions ? wallet.transactions.length : 0);
      
    //   // Initialize transactions array if it doesn't exist
    //   if (!wallet.transactions) {
    //     console.log('Initializing transactions array');
    //     wallet.transactions = [];
    //   }
      
    //   // Add transaction
    //   wallet.transactions.push(transaction);
    //   console.log('Transaction pushed to array, new length:', wallet.transactions.length);
      
    //   // Update balance
    //   wallet.availableAmount = balanceAfter;
    //   console.log('Wallet balance updated to:', balanceAfter);
      
    //   // Save wallet
    //   console.log('Saving wallet...');
    //   await wallet.save({ session });
    //   console.log('Wallet saved successfully');
      
    //   // Check if transaction was added
    //   const savedWallet = await this.findOne({ _id: wallet._id }).session(session);
    //   console.log('Saved wallet transactions count:', savedWallet.transactions.length);
      
    //   if (savedWallet.transactions.length === wallet.transactions.length) {
    //     console.log('APPROACH 1 SUCCESSFUL: Transaction saved correctly');
    //   } else {
    //     console.error('WARNING: Transaction might not have been saved properly');
    //   }
    // } catch (approach1Error) {
    //   console.error('APPROACH 1 FAILED:', approach1Error);
    //   // Continue to next approach
    // }
    
    // // APPROACH 2: FindOneAndUpdate
    // console.log('\nAPPROACH 2: FindOneAndUpdate');
    // try {
    //   const updatedWallet = await this.findOneAndUpdate(
    //     { _id: wallet._id },
    //     { 
    //       $set: { availableAmount: balanceAfter },
    //       $push: { transactions: transaction }
    //     },
    //     { 
    //       new: true, 
    //       session,
    //       runValidators: true
    //     }
    //   );
      
    //   if (updatedWallet) {
    //     console.log('APPROACH 2 SUCCESSFUL: Wallet updated');
    //     console.log('Updated wallet transactions count:', updatedWallet.transactions.length);
    //   } else {
    //     console.error('APPROACH 2 FAILED: No wallet returned from update');
    //   }
    // } catch (approach2Error) {
    //   console.error('APPROACH 2 FAILED:', approach2Error);
    //   // Continue to next approach
    // }
    
    // APPROACH 3: Direct update using Mongoose's update API
    console.log('\nAPPROACH 3: Direct update');
    try {
      const updateResult = await this.updateOne(
        { _id: wallet._id },
        { 
          $set: { availableAmount: balanceAfter },
          $push: { transactions: transaction }
        },
        { session }
      );
      
      console.log('APPROACH 3 result:', updateResult);
      if (updateResult.modifiedCount > 0) {
        console.log('APPROACH 3 SUCCESSFUL: Wallet updated');
      } else {
        console.error('APPROACH 3 WARNING: No documents modified');
      }
    } catch (approach3Error) {
      console.error('APPROACH 3 FAILED:', approach3Error);
    }
    
    // Commit transaction
    console.log('Committing transaction...');
    await session.commitTransaction();
    console.log('Transaction committed successfully');
    
    // Verify the transaction was added
    const finalWallet = await this.findOne({ _id: wallet._id });
    console.log('Final wallet state:');
    console.log('- availableAmount:', finalWallet.availableAmount);
    console.log('- transactions count:', finalWallet.transactions.length);
    
    if (finalWallet.transactions.length > 0) {
      const lastTransaction = finalWallet.transactions[finalWallet.transactions.length - 1];
      console.log('Last transaction:');
      console.log('- type:', lastTransaction.type);
      console.log('- amount:', lastTransaction.amount);
      console.log('- description:', lastTransaction.description);
      console.log('========== TRANSACTION DEBUGGING COMPLETE ==========\n');
      return lastTransaction;
    } else {
      console.error('ERROR: No transactions found in wallet after save!');
      console.log('========== TRANSACTION DEBUGGING COMPLETE ==========\n');
      return null;
    }
  } catch (error) {
    console.error('CRITICAL ERROR in transaction process:', error);
    console.log('Aborting transaction...');
    await session.abortTransaction();
    console.log('Transaction aborted');
    console.log('========== TRANSACTION DEBUGGING COMPLETE ==========\n');
    throw error;
  } finally {
    console.log('Ending session');
    session.endSession();
  }
};

/**
 * Debug-enhanced method to add a payment
 */
dealerWalletSchema.statics.addPayment = async function(
  dealerId,
  amount,
  description,
  performedBy,
  reference = null,
  referenceId = null
) {
  console.log('\n========== WALLET PAYMENT DEBUGGING ==========');
  console.log('Method called: addPayment');
  console.log('Parameters:');
  console.log('- dealerId:', dealerId, typeof dealerId);
  console.log('- amount:', amount, typeof amount);
  console.log('- description:', description);
  console.log('- performedBy:', performedBy);
  console.log('- reference:', reference);
  console.log('- referenceId:', referenceId);
  
  // Ensure amount is a number
  amount = Number(amount);
  if (isNaN(amount)) {
    console.error('ERROR: amount must be a valid number');
    throw new Error('amount must be a valid number');
  }
  
  // Determine transaction type based on amount
  const transactionType = amount >= 0 ? 'CREDIT' : 'DEBIT';
  const absAmount = Math.abs(amount);
  
  console.log(`Transaction type determined: ${transactionType}, absAmount: ${absAmount}`);
  console.log('Calling addTransaction method...');
  
  try {
    const result = await this.addTransaction(
      dealerId,
      transactionType,
      absAmount,
      description,
      performedBy,
      reference,
      referenceId
    );
    
    console.log('addTransaction result:', result ? 'Success' : 'Failed');
    console.log('========== WALLET PAYMENT DEBUGGING COMPLETE ==========\n');
    return result;
  } catch (error) {
    console.error('Error in addPayment:', error);
    console.log('========== WALLET PAYMENT DEBUGGING COMPLETE ==========\n');
    throw error;
  }
};

/**
 * Legacy method for backward compatibility
 */
dealerWalletSchema.statics.updateBalance = async function(
  dealerId,
  amount,
  description = 'Balance adjustment',
  performedBy = null,
  reference = 'MANUAL',
  referenceId = null
) {
  console.log('\n========== WALLET BALANCE UPDATE DEBUGGING ==========');
  console.log('Method called: updateBalance (legacy method)');
  console.log('Parameters:');
  console.log('- dealerId:', dealerId);
  console.log('- amount:', amount);
  console.log('- description:', description);
  console.log('- performedBy:', performedBy);
  console.log('- reference:', reference);
  console.log('- referenceId:', referenceId);
  
  // If performedBy is not provided, use dealerId as fallback
  if (!performedBy) {
    console.log('No performedBy provided, using dealerId as fallback');
    performedBy = dealerId;
  }
  
  try {
    const result = await this.addPayment(
      dealerId,
      amount,
      description,
      performedBy,
      reference,
      referenceId
    );
    
    console.log('addPayment result:', result ? 'Success' : 'Failed');
    console.log('========== WALLET BALANCE UPDATE DEBUGGING COMPLETE ==========\n');
    return result;
  } catch (error) {
    console.error('Error in updateBalance:', error);
    console.log('========== WALLET BALANCE UPDATE DEBUGGING COMPLETE ==========\n');
    throw error;
  }
};

/**
 * Debug method to manually verify wallet existence and state
 */
dealerWalletSchema.statics.debugWallet = async function(dealerId) {
  console.log('\n========== WALLET DEBUG INFO ==========');
  console.log('Checking wallet for dealerId:', dealerId);
  
  try {
    const wallet = await this.findOne({ dealer: dealerId });
    
    if (wallet) {
      console.log('Wallet found!');
      console.log('- ID:', wallet._id);
      console.log('- Dealer:', wallet.dealer);
      console.log('- Available Amount:', wallet.availableAmount);
      console.log('- Entries Count:', wallet.entries.length);
      console.log('- Transactions Count:', wallet.transactions ? wallet.transactions.length : 0);
      
      if (wallet.transactions && wallet.transactions.length > 0) {
        console.log('\nLast 3 transactions:');
        const lastThree = wallet.transactions.slice(-3).reverse();
        lastThree.forEach((t, i) => {
          console.log(`\nTransaction ${i+1}:`);
          console.log('- Type:', t.type);
          console.log('- Amount:', t.amount);
          console.log('- Balance Before:', t.balanceBefore);
          console.log('- Balance After:', t.balanceAfter);
          console.log('- Description:', t.description);
          console.log('- Created At:', t.createdAt);
        });
      } else {
        console.log('No transactions found in wallet');
      }
      
      return wallet;
    } else {
      console.log('No wallet found for this dealer');
      return null;
    }
  } catch (error) {
    console.error('Error while debugging wallet:', error);
    return null;
  } finally {
    console.log('========== WALLET DEBUG INFO COMPLETE ==========\n');
  }
};

// Helper method to get wallet summary
dealerWalletSchema.methods.getSummary = function() {
  return {
    availableAmount: this.availableAmount,
    totalQuantity: this.entries.reduce((sum, entry) => sum + entry.quantity, 0),
    totalBookedQuantity: this.entries.reduce((sum, entry) => sum + entry.bookedQuantity, 0),
    totalRemainingQuantity: this.entries.reduce((sum, entry) => sum + entry.remainingQuantity, 0),
    entriesCount: this.entries.length,
    transactionsCount: this.transactions.length
  };
};

// Helper method to get recent transactions
dealerWalletSchema.methods.getRecentTransactions = function(limit = 10) {
  if (!this.transactions || this.transactions.length === 0) {
    return [];
  }
  
  return this.transactions
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, limit);
};

const DealerWallet = model("DealerWallet", dealerWalletSchema);

export default DealerWallet;