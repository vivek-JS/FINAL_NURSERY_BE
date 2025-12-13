import { Schema, model } from "mongoose";

const unprocessedFileSchema = new Schema(
  {
    filename: {
      type: String,
      required: true,
      unique: true,
    },
    originalFilename: {
      type: String,
      required: true,
    },
    filepath: {
      type: String,
      required: true,
    },
    unprocessedRowsCount: {
      type: Number,
      required: true,
      default: 0,
    },
    totalRows: {
      type: Number,
      required: true,
      default: 0,
    },
    successfulImports: {
      type: Number,
      default: 0,
    },
    failedImports: {
      type: Number,
      default: 0,
    },
    uploadedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
    uploadedByName: {
      type: String,
    },
    importSummary: {
      totalProcessed: { type: Number, default: 0 },
      successfulImports: { type: Number, default: 0 },
      failedImports: { type: Number, default: 0 },
      overflowSlots: { type: Number, default: 0 },
      invalidPhoneNumbers: { type: Number, default: 0 },
    },
    errors: [{
      bookingNo: String,
      orderId: String,
      error: String,
    }],
    downloadUrl: {
      type: String,
      required: true,
    },
    isDownloaded: {
      type: Boolean,
      default: false,
    },
    downloadedAt: {
      type: Date,
    },
    downloadedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
  },
  {
    timestamps: true,
  }
);

// Index for faster queries
unprocessedFileSchema.index({ createdAt: -1 });
unprocessedFileSchema.index({ uploadedBy: 1 });
unprocessedFileSchema.index({ isDownloaded: 1 });

const UnprocessedFile = model("UnprocessedFile", unprocessedFileSchema);

export default UnprocessedFile;




