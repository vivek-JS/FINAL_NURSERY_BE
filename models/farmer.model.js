import mongoose, { Schema, model } from "mongoose";

const farmerSchema = new Schema({
  name: {
    type: String,
    required: [true, "Farmer name requried"],
  },
  village: {
    type: String,
    required: [true, "Village ID requried"],
  },
  taluka: {
    type: String,
    required: [true, "Taluka ID requried"],
  },
  district: {
    type: String,
    required: [true, "District ID requried"],
  },
  stateName: {
    type: String,
    required: [true, "State name requried"],
  },
  talukaName: {
    type: String,
    required: [true, "Taluka name requried"],
  },
  districtName: {
    type: String,
    required: [true, "District name requried"],
  },
  state: {
    type: String,
    required: [true, "State name requried"],
  },
  mobileNumber: {
    type: Number,
    required: false, // Allow null for invalid numbers
    // Note: Database has sparse unique index - allows multiple nulls, but valid numbers must be unique
  },
  alternateNumber: {
    type: Number,
    required: false,
  },
  isInvalidPhone: {
    type: Boolean,
    default: false,
  },
  originalPhoneNumber: {
    type: String,
    default: null,
  },
  opt_in: {
    type: Boolean,
    default: false,
  },
  // Opt-in metadata for webhook/event tracking
  opt_in_at: {
    type: Date,
    default: null,
  },
  opt_in_source: {
    type: String,
    default: null,
  },
  opt_in_webhook_id: {
    type: String,
    default: null,
    index: true
  },
  opt_in_metadata: {
    type: Schema.Types.Mixed,
    default: null
  },
  opt_in_verified: {
    type: Boolean,
    default: false
  },
  // Record of WhatsApp automation activities for this farmer
  whatsappAutomationActivities: [
    {
      automationJobId: { type: Schema.Types.ObjectId, ref: "AutomationJob" },
      sendEventId: { type: Schema.Types.ObjectId, ref: "SendEvent" },
      phone: { type: String },
      message: { type: String },
      // Status lifecycle: pending -> sent -> delivered -> read (or failed/skipped)
      status: { type: String, enum: ["pending", "sent", "delivered", "read", "failed", "skipped"], default: "pending" },
      timestamp: { type: Date, default: Date.now },
      // WATI tracking fields
      localMessageId: { type: String, default: null, index: false },
      whatsappMessageId: { type: String, default: null },
      deliveredAt: { type: Date, default: null },
      readAt: { type: Date, default: null },
      failedCode: { type: String, default: null },
      failedDetail: { type: String, default: null },
      templateName: { type: String, default: null },
      broadcastName: { type: String, default: null },
      source: { type: String, enum: ["farmer", "lead"], default: "farmer" }
    },
  ],
  // Array field to store all farmers referred by this farmer
  referredTo: [
    {
      farmerId: {
        type: Schema.Types.ObjectId,
        ref: "Farmer",
        required: true,
      },
      referredAt: {
        type: Date,
        default: Date.now,
      },
      orderId: {
        type: Schema.Types.ObjectId,
        ref: "Order",
      },
    },
  ],
});

// Add compound index for faster lookups by name and location
farmerSchema.index({ name: 1, village: 1, taluka: 1, district: 1 });

// Add index for phone number lookups
farmerSchema.index({ mobileNumber: 1 });
farmerSchema.index({ alternateNumber: 1 });
// Add index for opt_in status lookups
farmerSchema.index({ opt_in: 1 });
// Index for quick lookup by localMessageId in embedded activities
farmerSchema.index({ "whatsappAutomationActivities.localMessageId": 1 });

const Farmer = model("Farmer", farmerSchema);
export default Farmer;