import { Schema, model } from "mongoose";

const locationRuleSchema = new Schema(
  {
    stateCode: { type: String, required: true },
    stateName: { type: String, required: true },
    districts: [
      {
        districtCode: { type: String, required: true },
        districtName: { type: String, required: true }
      }
    ],
    talukas: [
      {
        talukaCode: { type: String, required: true },
        talukaName: { type: String, required: true },
        districtCode: { type: String, required: false }
      }
    ],
    villages: [
      {
        villageCode: { type: String, required: false },
        villageName: { type: String, required: true },
        talukaCode: { type: String, required: false },
        districtCode: { type: String, required: false }
      }
    ]
  },
  { _id: false }
);

const publicFarmerLinkSchema = new Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true
    },
    slug: {
      type: String,
      required: true,
      unique: true,
      index: true,
      lowercase: true,
      trim: true
    },
    description: {
      type: String,
      default: ""
    },
    isActive: {
      type: Boolean,
      default: true
    },
    locationRules: {
      type: [locationRuleSchema],
      default: []
    },
    maxSubmissions: {
      type: Number
    },
    meta: {
      type: Schema.Types.Mixed
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User"
    }
  },
  {
    timestamps: true
  }
);

const PublicFarmerLink = model("PublicFarmerLink", publicFarmerLinkSchema);

export default PublicFarmerLink;





