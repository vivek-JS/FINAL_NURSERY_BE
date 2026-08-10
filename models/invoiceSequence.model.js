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
    },
    prefix: {
      type: String,
      default: "B",
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

/** @deprecated Legacy global fallback — no longer used for allocation */
export const DELIVERY_CHALLAN_SEQUENCE_KEY = "delivery_challan";

/** Global billable / non-billable DC sequences */
export const DC_BILLABLE_SEQUENCE_KEY = "dc_billable";
export const DC_NON_BILLABLE_SEQUENCE_KEY = "dc_non_billable";

/** Global billable / non-billable tax-invoice sequences */
export const INV_BILLABLE_SEQUENCE_KEY = "inv_billable";
export const INV_NON_BILLABLE_SEQUENCE_KEY = "inv_non_billable";

/** @deprecated Plant-scoped official DC keys (billable): `dc_plant:{plantCmsId}` */
export const PLANT_DC_SEQUENCE_KEY_PREFIX = "dc_plant:";
/** @deprecated Plant-scoped non-billable DC keys: `dc_plant_nb:{plantCmsId}` */
export const PLANT_NB_DC_SEQUENCE_KEY_PREFIX = "dc_plant_nb:";

export default InvoiceSequence;
