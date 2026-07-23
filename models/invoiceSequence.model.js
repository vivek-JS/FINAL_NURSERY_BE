import { Schema, model } from "mongoose";

/**
 * Singleton-style settings for delivery challan / invoice numbering.
 * `nextNumber` is the next value that will be issued (e.g. 640 → first label uses 640, then counter moves on).
 */
const invoiceSequenceSchema = new Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      default: "delivery_challan",
    },
    prefix: {
      type: String,
      default: "R",
      trim: true,
    },
    nextNumber: {
      type: Number,
      required: true,
      min: 1,
      default: 1,
    },
  },
  { timestamps: true }
);

const InvoiceSequence = model("InvoiceSequence", invoiceSequenceSchema);

export const DELIVERY_CHALLAN_SEQUENCE_KEY = "delivery_challan";
/** Plant-scoped official DC keys: `dc_plant:{plantCmsId}` */
export const PLANT_DC_SEQUENCE_KEY_PREFIX = "dc_plant:";

export default InvoiceSequence;
