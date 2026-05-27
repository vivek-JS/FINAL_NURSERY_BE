import mongoose, { Schema } from "mongoose";

const bankAuditLogSchema = new Schema(
  {
    action: { type: String, required: true, index: true },
    direction: { type: String, enum: ["INBOUND", "OUTBOUND"], default: "OUTBOUND" },
    status: { type: String, enum: ["SUCCESS", "FAILED"], index: true },
    httpStatus: { type: Number },
    durationMs: { type: Number },
    userId: { type: Schema.Types.ObjectId, ref: "User" },
    idempotencyKey: { type: String, index: true },
    requestMeta: { type: Schema.Types.Mixed },
    responseMeta: { type: Schema.Types.Mixed },
    errorMessage: { type: String },
    errorCode: { type: String },
    ipAddress: { type: String },
  },
  { timestamps: true }
);

bankAuditLogSchema.index({ createdAt: -1 });

const BankAuditLog =
  mongoose.models.BankAuditLog || mongoose.model("BankAuditLog", bankAuditLogSchema);

export default BankAuditLog;
