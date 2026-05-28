import mongoose, { Schema } from "mongoose";

/**
 * Multi-step WATI conversation after order_ready template (reschedule delivery date).
 * Persists across PM2 restarts (unlike in-memory order bot state).
 */
const whatsappFarmReadySessionSchema = new Schema(
  {
    mobile10: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    orderId: {
      type: Schema.Types.ObjectId,
      ref: "Order",
      required: true,
      index: true,
    },
    step: {
      type: String,
      enum: ["offered_dates", "await_confirm"],
      required: true,
    },
    offeredDates: {
      type: [Date],
      default: [],
    },
    selectedDate: {
      type: Date,
      default: null,
    },
    oldDeliveryDate: {
      type: Date,
      default: null,
    },
    lastInboundMessageId: {
      type: String,
      trim: true,
      default: null,
    },
    expiresAt: {
      type: Date,
      required: true,
      index: { expireAfterSeconds: 0 },
    },
  },
  { timestamps: true }
);

whatsappFarmReadySessionSchema.index({ mobile10: 1 }, { unique: true });

const WhatsappFarmReadySession =
  mongoose.models.WhatsappFarmReadySession ||
  mongoose.model("WhatsappFarmReadySession", whatsappFarmReadySessionSchema);

export default WhatsappFarmReadySession;
