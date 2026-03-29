import mongoose, { Schema } from "mongoose";

/**
 * Stores ICICI EazyPay QR generation attempts for audit and reconciliation.
 * Index merchantTranId for webhook / status lookup later.
 */
const iciciQrTransactionSchema = new Schema(
  {
    orderId: { type: String, required: true, index: true },
    merchantTranId: { type: String, required: true, unique: true, index: true },
    /** Where this QR was created from — standalone API vs farmer order vs agri order */
    context: {
      type: String,
      enum: ["STANDALONE", "FARMER_ORDER", "AGRI_ORDER"],
      default: "STANDALONE",
      index: true,
    },
    /** MongoDB _id of Order or AgriSalesOrder when context is FARMER_ORDER / AGRI_ORDER */
    linkedOrderMongoId: { type: Schema.Types.ObjectId, index: true },
    amount: { type: Number, required: true },
    provider: { type: String, default: "ICICI_EAZYPAY" },
    status: {
      type: String,
      enum: ["CREATED", "FAILED", "PAID", "EXPIRED"],
      default: "CREATED",
    },
    qrData: { type: Schema.Types.Mixed },
    requestPayload: { type: Schema.Types.Mixed },
    responsePayload: { type: Schema.Types.Mixed },
    expiresAt: { type: Date },
  },
  { timestamps: true }
);

const IciciQrTransaction =
  mongoose.models.IciciQrTransaction ||
  mongoose.model("IciciQrTransaction", iciciQrTransactionSchema);

export default IciciQrTransaction;
