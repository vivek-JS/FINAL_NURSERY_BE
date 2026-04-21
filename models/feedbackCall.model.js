import mongoose, { Schema, model } from "mongoose";

const transcriptLineSchema = new Schema(
  {
    speaker: { type: String, enum: ["agent", "customer"], required: true },
    text: { type: String, required: true },
    ts: { type: Number },
  },
  { _id: false }
);

const feedbackCallSchema = new Schema(
  {
    /** Mongo _id of nursery Order — canonical join key */
    nurseryOrderId: {
      type: Schema.Types.ObjectId,
      ref: "Order",
      required: true,
      unique: true,
      index: true,
    },
    orderNumber: { type: Number },
    customerId: { type: Schema.Types.ObjectId, ref: "Farmer" },
    customerName: { type: String, default: "" },
    phone: { type: String, required: true, trim: true },

    dispatchDate: { type: Date },
    scheduledAt: { type: Date },
    startedAt: { type: Date },
    endedAt: { type: Date },

    provider: { type: String, enum: ["EXOTEL"], default: "EXOTEL" },
    exotelCallSid: { type: String, default: null, index: true, sparse: true },

    callStatus: {
      type: String,
      enum: ["PENDING", "QUEUED", "ANSWERED", "COMPLETED", "FAILED", "BUSY", "NO_ANSWER"],
      default: "PENDING",
      index: true,
    },

    recordingUrl: { type: String },
    durationSec: { type: Number },

    language: { type: String, enum: ["mr", "multi"], default: "mr" },
    transcriptText: { type: String },
    transcriptJson: [transcriptLineSchema],

    rating: { type: Number, min: 1, max: 5 },
    satisfaction: {
      type: String,
      enum: ["SATISFIED", "UNSATISFIED", "MIXED", "UNKNOWN"],
    },
    sentiment: {
      type: String,
      enum: ["POSITIVE", "NEUTRAL", "NEGATIVE"],
    },
    issues: [{ type: String }],
    suggestions: [{ type: String }],
    wantsCallback: { type: Boolean, default: false },

    resolutionStatus: {
      type: String,
      enum: ["OPEN", "RESOLVED", "CALLBACK_REQUIRED"],
      default: "OPEN",
    },
    escalationReason: { type: String },

    /** Attempt counter for future retry policy */
    attemptCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

feedbackCallSchema.index({ callStatus: 1, createdAt: -1 });

const FeedbackCall =
  mongoose.models.FeedbackCall || model("FeedbackCall", feedbackCallSchema);

export default FeedbackCall;
