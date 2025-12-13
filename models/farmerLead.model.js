import { Schema, model } from "mongoose";

const farmerLeadSchema = new Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true
    },
    mobileNumber: {
      type: String,
      required: true,
      trim: true
    },
    stateCode: { type: String, required: true },
    stateName: { type: String, required: true },
    districtCode: { type: String, required: true },
    districtName: { type: String, required: true },
    talukaCode: { type: String, required: true },
    talukaName: { type: String, required: true },
    villageName: { type: String, required: true },
    publicLinkId: {
      type: Schema.Types.ObjectId,
      ref: "PublicFarmerLink",
      required: true
    },
    sourceSlug: {
      type: String,
      index: true
    },
    status: {
      type: String,
      enum: ["new", "processed", "discarded"],
      default: "new"
    },
    meta: {
      type: Schema.Types.Mixed
    }
  },
  {
    timestamps: true
  }
);

const FarmerLead = model("FarmerLead", farmerLeadSchema);

export default FarmerLead;





