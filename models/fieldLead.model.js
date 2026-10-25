import { Schema, model } from "mongoose";

const placeSchema = new Schema(
  {
    stateName: { type: String, default: "Maharashtra" },
    stateCode: { type: String, default: "MH" },
    districtCode: { type: String, default: "" },
    districtName: { type: String, default: "" },
    talukaCode: { type: String, default: "" },
    talukaName: { type: String, default: "" },
    villageName: { type: String, default: "" },
  },
  { _id: false }
);

const leadSchema = new Schema(
  {
    mobile: { type: String, required: true, unique: true, index: true, trim: true },
    name: { type: String, required: true, trim: true },
    farmerId: { type: Schema.Types.ObjectId, ref: "Farmer" },
    place: { type: placeSchema, default: () => ({}) },
    publicLinkId: { type: Schema.Types.ObjectId, ref: "PublicFarmerLink" },
    assignedTo: [{ type: Schema.Types.ObjectId, ref: "User", index: true }],
    status: { type: String, enum: ["open", "won", "dropped"], default: "open" },
    lastFollowUpAt: { type: Date },
    followUpCount: { type: Number, default: 0 },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

leadSchema.index({ assignedTo: 1, lastFollowUpAt: -1 });

const followUpSchema = new Schema(
  {
    leadId: { type: Schema.Types.ObjectId, ref: "Lead", required: true, index: true },
    by: { type: Schema.Types.ObjectId, ref: "User", required: true },
    note: { type: String, default: "" },
    photos: [{ url: String, key: String, _id: false }],
    audio: { url: String, key: String, seconds: Number },
    nextAt: { type: Date },
    place: { type: placeSchema },
    gps: {
      lat: Number,
      lng: Number,
      accuracy: Number,
      area: { type: String, default: "" },
    },
  },
  { timestamps: true }
);

followUpSchema.index({ by: 1, createdAt: -1 });
followUpSchema.index({ leadId: 1, createdAt: -1 });

const leadTargetSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, unique: true },
    dailyTarget: { type: Number, default: 10, min: 0 },
  },
  { timestamps: true }
);

export const Lead = model("Lead", leadSchema);
export const FieldFollowUp = model("FieldFollowUp", followUpSchema);
export const LeadTarget = model("LeadTarget", leadTargetSchema);
