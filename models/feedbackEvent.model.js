import mongoose, { Schema, model } from "mongoose";

const feedbackEventSchema = new Schema(
  {
    feedbackCallId: {
      type: Schema.Types.ObjectId,
      ref: "FeedbackCall",
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: [
        "CALL_INITIATED",
        "CALL_ANSWERED",
        "PARTIAL_TRANSCRIPT",
        "FINAL_TRANSCRIPT",
        "TOOL_CALLED",
        "CALL_COMPLETED",
        "CALL_FAILED",
        "AI_TURN",
      ],
      required: true,
    },
    payload: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

feedbackEventSchema.index({ feedbackCallId: 1, createdAt: -1 });

const FeedbackEvent =
  mongoose.models.FeedbackEvent || model("FeedbackEvent", feedbackEventSchema);

export default FeedbackEvent;
