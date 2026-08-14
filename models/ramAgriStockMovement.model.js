import mongoose from "mongoose";

export const RAM_AGRI_MOVEMENT_TYPES = {
  GRN_IN: "GRN_IN",
  MANUAL_IN: "MANUAL_IN",
  MANUAL_OUT: "MANUAL_OUT",
  SALE_DISPATCH_OUT: "SALE_DISPATCH_OUT",
  SOWING_RAISING_OUT: "SOWING_RAISING_OUT",
  SALES_RETURN_IN: "SALES_RETURN_IN",
  DEALER_RETURN_IN: "DEALER_RETURN_IN",
  ORDER_CANCEL_RESTORE_IN: "ORDER_CANCEL_RESTORE_IN",
  /** Stock returned to supplier (purchase return) — OUT */
  PURCHASE_RETURN_OUT: "PURCHASE_RETURN_OUT",
};

export const RAM_AGRI_MOVEMENT_TYPE_LIST = Object.values(RAM_AGRI_MOVEMENT_TYPES);

export const RAM_AGRI_MOVEMENT_CATEGORY_LABELS = {
  GRN_IN: "GRN",
  MANUAL_IN: "Manual adjustment",
  MANUAL_OUT: "Manual adjustment",
  SALE_DISPATCH_OUT: "Sale dispatch",
  SOWING_RAISING_OUT: "Raising / Sowing transfer",
  SALES_RETURN_IN: "Sales return",
  DEALER_RETURN_IN: "Dealer return",
  ORDER_CANCEL_RESTORE_IN: "Order cancel restore",
  PURCHASE_RETURN_OUT: "Purchase return",
};

const ramAgriStockMovementSchema = new mongoose.Schema(
  {
    ramAgriCropId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "RamAgriInputsProduct",
      required: true,
      index: true,
    },
    ramAgriVarietyId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    batchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "RamAgriBatch",
      index: true,
    },
    batchNumber: { type: String, trim: true },
    direction: {
      type: String,
      enum: ["IN", "OUT"],
      required: true,
      index: true,
    },
    movementType: {
      type: String,
      enum: RAM_AGRI_MOVEMENT_TYPE_LIST,
      required: true,
      index: true,
    },
    quantity: {
      type: Number,
      required: true,
      min: 0,
    },
    referenceType: { type: String, trim: true },
    referenceId: { type: mongoose.Schema.Types.ObjectId },
    referenceNumber: { type: String, trim: true },
    description: { type: String, trim: true },
    movementGroupKey: {
      type: String,
      trim: true,
      index: true,
      comment: "Groups batch-level rows into one ledger entry",
    },
    performedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

ramAgriStockMovementSchema.index({
  ramAgriCropId: 1,
  ramAgriVarietyId: 1,
  createdAt: -1,
});

const RamAgriStockMovement =
  mongoose.models.RamAgriStockMovement ||
  mongoose.model("RamAgriStockMovement", ramAgriStockMovementSchema);

export default RamAgriStockMovement;
