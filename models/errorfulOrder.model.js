import { Schema, model } from 'mongoose';

const errorfulOrderSchema = new Schema({
  // Raw Excel row data (store all fields from Excel)
  rawData: {
    type: Schema.Types.Mixed,
    required: true,
  },
  
  // Excel row number (1-indexed, including header)
  rowNumber: {
    type: Number,
    required: true,
  },
  
  // Booking number from Excel
  bookingNumber: {
    type: String,
  },
  
  // Parsed order ID (if parsing was successful)
  parsedOrderId: {
    type: Number,
  },
  
  // Error message explaining why the import failed
  errorMessage: {
    type: String,
    required: true,
  },
  
  // Error type/category (e.g., 'VALIDATION_ERROR', 'DUPLICATE_KEY', 'MISSING_DATA', 'DATE_ERROR', etc.)
  errorType: {
    type: String,
    enum: [
      'VALIDATION_ERROR',
      'DUPLICATE_KEY',
      'MISSING_DATA',
      'DATE_ERROR',
      'FARMER_ERROR',
      'PLANT_ERROR',
      'SLOT_ERROR',
      'UNKNOWN_ERROR'
    ],
    default: 'UNKNOWN_ERROR',
  },
  
  // Original filename of the Excel file
  sourceFilename: {
    type: String,
  },
  
  // Import batch ID (timestamp or unique identifier for this import session)
  importBatchId: {
    type: String,
  },
  
  // Whether this error has been reviewed/resolved
  isResolved: {
    type: Boolean,
    default: false,
  },
  
  // Resolution notes (if manually fixed)
  resolutionNotes: {
    type: String,
  },
  
  // Date when error was resolved
  resolvedAt: {
    type: Date,
  },
  
  // User who resolved the error (if manually fixed)
  resolvedBy: {
    type: Schema.Types.ObjectId,
    ref: 'User',
  },
  
  // Attempts to re-import this order
  retryAttempts: {
    type: Number,
    default: 0,
  },
  
  // Last retry date
  lastRetryAt: {
    type: Date,
  },
  
  // Whether this order was successfully imported after retry
  successfullyImported: {
    type: Boolean,
    default: false,
  },
  
  // Order ID if successfully imported after retry
  importedOrderId: {
    type: Schema.Types.ObjectId,
    ref: 'Order',
  },
}, { timestamps: true });

// Indexes for efficient querying
errorfulOrderSchema.index({ isResolved: 1, createdAt: -1 });
errorfulOrderSchema.index({ errorType: 1 });
errorfulOrderSchema.index({ bookingNumber: 1 });
errorfulOrderSchema.index({ importBatchId: 1 });
errorfulOrderSchema.index({ successfullyImported: 1 });
errorfulOrderSchema.index({ createdAt: -1 });

const ErrorfulOrder = model('ErrorfulOrder', errorfulOrderSchema);

export default ErrorfulOrder;




