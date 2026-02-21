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
      trim: true,
      unique: true,
      index: true
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
    },
    opt_in: {
      type: Boolean,
      default: false
    }
  },
  {
    timestamps: true
  }
);

// Add index for opt_in status lookups
farmerLeadSchema.index({ opt_in: 1 });

// Additional opt-in tracking fields
farmerLeadSchema.add({
  opt_in_at: { type: Date, default: null },
  opt_in_source: { type: String, default: null },
  opt_in_webhook_id: { type: String, default: null, index: true },
  opt_in_metadata: { type: Schema.Types.Mixed, default: null },
  opt_in_verified: { type: Boolean, default: false }
});

// History of WhatsApp automation activities for this lead
farmerLeadSchema.add({
  whatsappAutomationActivities: [
    {
      automationJobId: { type: Schema.Types.ObjectId, ref: "AutomationJob" },
      sendEventId: { type: Schema.Types.ObjectId, ref: "SendEvent" },
      phone: { type: String },
      message: { type: String },
      status: { type: String, enum: ["sent", "failed", "skipped"] },
      timestamp: { type: Date, default: Date.now },
    },
  ],
});

const FarmerLead = model("FarmerLead", farmerLeadSchema);

export default FarmerLead;






