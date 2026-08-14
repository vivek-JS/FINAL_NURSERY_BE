import mongoose from "mongoose";

const lineSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: "Product" },
    productName: { type: String, trim: true },
    /** Classic Batch or RamAgriBatch id */
    batch: { type: mongoose.Schema.Types.ObjectId, required: true },
    batchNumber: { type: String, trim: true },
    isRamAgriProduct: { type: Boolean, default: false },
    ramAgriCropId: { type: mongoose.Schema.Types.ObjectId },
    ramAgriVarietyId: { type: mongoose.Schema.Types.ObjectId },
    grn: { type: mongoose.Schema.Types.ObjectId, ref: "GRN" },
    grnNumber: { type: String, trim: true },
    purchaseOrder: { type: mongoose.Schema.Types.ObjectId, ref: "PurchaseOrder" },
    poNumber: { type: String, trim: true },
    unit: { type: mongoose.Schema.Types.ObjectId, ref: "MeasurementUnit" },
    returnQuantity: { type: Number, required: true, min: 0.01 },
    rate: { type: Number, default: 0, min: 0 },
    amount: { type: Number, default: 0, min: 0 },
    expiryDate: { type: Date },
    slotId: { type: mongoose.Schema.Types.ObjectId },
  },
  { _id: true }
);

const purchaseReturnSchema = new mongoose.Schema(
  {
    returnNumber: { type: String, required: true, unique: true, trim: true, index: true },
    purchaseOrder: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PurchaseOrder",
      required: true,
      index: true,
    },
    poNumber: { type: String, trim: true, index: true },
    /** PO_WISE = single PO picker; SUPPLIER_BATCH = supplier → batches spanning POs */
    source: {
      type: String,
      enum: ["PO_WISE", "SUPPLIER_BATCH"],
      default: "PO_WISE",
      index: true,
    },
    /** When source=SUPPLIER_BATCH: every PO touched by this return */
    affectedPurchaseOrders: [
      {
        purchaseOrder: { type: mongoose.Schema.Types.ObjectId, ref: "PurchaseOrder" },
        poNumber: String,
        returnQuantity: { type: Number, default: 0 },
        returnAmount: { type: Number, default: 0 },
      },
    ],
    supplier: { type: mongoose.Schema.Types.ObjectId, ref: "Supplier", index: true },
    status: {
      type: String,
      enum: ["COMPLETED", "CANCELLED"],
      default: "COMPLETED",
      index: true,
    },
    lines: { type: [lineSchema], default: [] },
    totalQuantity: { type: Number, default: 0, min: 0 },
    totalAmount: { type: Number, default: 0, min: 0 },
    returnReason: { type: String, trim: true },
    returnNotes: { type: String, trim: true },
    returnedAt: { type: Date, default: Date.now },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    /** Generated return invoice # (PRIYY#####) */
    invoiceNumber: { type: String, trim: true, index: true, sparse: true },
    invoiceGeneratedAt: { type: Date },
    /** Money ledger AP posting status (immutable lines — use REVERSAL to correct) */
    ledgerStatus: {
      type: String,
      enum: ["PENDING", "POSTED", "SKIPPED", "FAILED"],
      default: "PENDING",
      index: true,
    },
    ledgerError: { type: String, trim: true, default: "" },
  },
  { timestamps: true }
);

purchaseReturnSchema.index({ returnedAt: -1 });
purchaseReturnSchema.index({ purchaseOrder: 1, status: 1 });

purchaseReturnSchema.statics.generateReturnNumber = async function () {
  const yn = new Date().getFullYear().toString().slice(-2);
  const prefix = `PR${yn}`;
  const last = await this.findOne({ returnNumber: new RegExp(`^${prefix}`) })
    .sort({ returnNumber: -1 })
    .select("returnNumber")
    .lean();
  let seq = 1;
  if (last?.returnNumber) {
    const n = parseInt(String(last.returnNumber).replace(/\D/g, "").slice(-5), 10);
    if (Number.isFinite(n)) seq = n + 1;
  }
  return `${prefix}${String(seq).padStart(5, "0")}`;
};

const PurchaseReturn = mongoose.model("PurchaseReturn", purchaseReturnSchema);
export default PurchaseReturn;
