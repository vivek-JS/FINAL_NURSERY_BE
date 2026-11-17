import { Schema, model } from "mongoose";

export const FREIGHT_SLIP_STATUSES = ["TENTATIVE", "FINAL"];
export const FREIGHT_ENTRY_SOURCES = ["WEB", "APP"];

/** Fields compared between tentative and final to decide `finalUnchanged` / `changedFields`. */
export const FREIGHT_COMPARE_FIELDS = [
  "km",
  "billedKm",
  "extraKm",
  "localMarket",
  "rateCardId",
  "loadType",
  "crop",
  "crates",
  "ratePerKm",
  "freightAmount",
  "bhatta",
  "bhattas",
  "otherAmount",
  "remarks",
];

const entrySchema = new Schema(
  {
    km: { type: Number, required: true, min: 0 },
    /** Auto 5 km × order count. Not used on local-market plant quotes. */
    extraKm: { type: Number, default: 0, min: 0 },
    extraKmPerOrder: { type: Number, default: 5, min: 0 },
    orderCount: { type: Number, default: 0, min: 0 },
    billedKm: { type: Number, default: 0, min: 0 },
    localMarket: { type: Boolean, default: false },
    plants: { type: Number, default: 0, min: 0 },
    ratePerPlant: { type: Number, default: 0, min: 0 },
    rateCardId: { type: Schema.Types.ObjectId, ref: "FreightRateCard", default: null },
    rateCardName: { type: String, default: "" },
    loadType: { type: String, default: "" },
    crop: { type: String, default: "" },
    crates: { type: Number, default: 0, min: 0 },
    ratePerKm: { type: Number, default: 0, min: 0 },
    rateMode: { type: String, default: "" },
    rateNote: { type: String, default: "" },
    freightAmount: { type: Number, default: 0, min: 0 },
    /** Sum of `bhattas`. Kept so older slips and trip rent stay a single number. */
    bhatta: { type: Number, default: 0, min: 0 },
    bhattas: {
      type: [
        new Schema(
          {
            name: { type: String, default: "", trim: true },
            amount: { type: Number, default: 0, min: 0 },
          },
          { _id: false }
        ),
      ],
      default: [],
    },
    otherAmount: { type: Number, default: 0, min: 0 },
    totalAmount: { type: Number, default: 0, min: 0 },
    remarks: { type: String, default: "", trim: true },
    source: { type: String, enum: FREIGHT_ENTRY_SOURCES, default: "WEB" },
    by: { type: Schema.Types.ObjectId, ref: "User", default: null },
    byName: { type: String, default: "" },
    at: { type: Date, default: Date.now },
  },
  { _id: false }
);

const freightSlipSchema = new Schema(
  {
    dispatchId: { type: Schema.Types.ObjectId, ref: "Dispatch", required: true },
    transportId: { type: String, default: "" },
    slipNumber: { type: String, required: true },
    /** IST calendar day used to mint slipNumber (1 Jan 2026 → 1126). */
    slipDate: { type: Date, default: null },
    status: { type: String, enum: FREIGHT_SLIP_STATUSES, default: "TENTATIVE" },

    vehicleName: { type: String, default: "" },
    vehicleNumber: { type: String, default: "" },
    driverName: { type: String, default: "" },
    driverMobile: { type: String, default: "" },

    villages: {
      type: [
        {
          name: { type: String, required: true, trim: true },
          plants: { type: Number, default: 0, min: 0 },
          seq: { type: Number, default: 0 },
        },
      ],
      default: [],
    },
    loadSummary: {
      type: [
        {
          crop: { type: String, default: "" },
          plants: { type: Number, default: 0, min: 0 },
          crates: { type: Number, default: 0, min: 0 },
        },
      ],
      default: [],
    },

    tentative: { type: entrySchema, required: true },
    final: { type: entrySchema, default: null },
    finalUnchanged: { type: Boolean, default: null },
    changedFields: { type: [String], default: [] },

    history: {
      type: [
        {
          action: { type: String, enum: ["TENTATIVE_CREATED", "TENTATIVE_UPDATED", "FINALIZED"], required: true },
          source: { type: String, enum: FREIGHT_ENTRY_SOURCES, default: "WEB" },
          by: { type: Schema.Types.ObjectId, ref: "User", default: null },
          byName: { type: String, default: "" },
          at: { type: Date, default: Date.now },
          totalAmount: { type: Number, default: 0 },
          changedFields: { type: [String], default: [] },
        },
      ],
      default: [],
    },
  },
  { timestamps: true }
);

freightSlipSchema.index({ dispatchId: 1 }, { unique: true });
freightSlipSchema.index({ slipNumber: 1 }, { unique: true });
freightSlipSchema.index({ status: 1, createdAt: -1 });

export default model("FreightSlip", freightSlipSchema);
