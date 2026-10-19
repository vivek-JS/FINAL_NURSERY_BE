import mongoose from "mongoose";
import catchAsync from "../utility/catchAsync.js";
import AppError from "../utility/appError.js";
import generateResponse from "../utility/responseFormat.js";
import Order from "../models/order.model.js";
import { sanitizeVoiceNotes } from "../utils/voiceNotes.js";

/**
 * Adds a voice-note remark recorded after booking (Ram Orders app order detail).
 * POST /api/v1/order/:orderId/voice-notes  { url, durationSec, note? }
 */
export const addOrderVoiceNote = catchAsync(async (req, res, next) => {
  const { orderId } = req.params;
  if (!mongoose.isValidObjectId(orderId)) return next(new AppError("Invalid order id", 400));
  const [note] = sanitizeVoiceNotes([req.body || {}], req.user, "LATER");
  if (!note) return next(new AppError("Upload the voice note first (audio URL missing)", 400));

  const order = await Order.findOneAndUpdate(
    { _id: orderId },
    { $push: { voiceNotes: note } },
    { new: true, projection: { voiceNotes: 1, orderId: 1 } }
  ).lean();
  if (!order) return next(new AppError("Order not found", 404));

  return res
    .status(201)
    .json(generateResponse("Success", "Voice note saved", { orderId: order.orderId, voiceNotes: order.voiceNotes }, undefined));
});
