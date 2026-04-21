import mongoose from "mongoose";
import catchAsync from "../utility/catchAsync.js";
import AppError from "../utility/appError.js";
import generateResponse from "../utility/responseFormat.js";
import FeedbackCall from "../models/feedbackCall.model.js";
import FeedbackEvent from "../models/feedbackEvent.model.js";
import { executeStartCall } from "../services/feedbackCallScheduling.js";

function normalizeExotelPayload(body) {
  const b = body && typeof body === "object" ? body : {};
  const callSid =
    b.CallSid ||
    b.Sid ||
    b.Call?.Sid ||
    b.call_sid ||
    b.CallSid ||
    null;
  const callStatus = (
    b.CallStatus ||
    b.Status ||
    b.Call?.Status ||
    b.call_status ||
    ""
  )
    .toString()
    .toLowerCase();
  const recordingUrl =
    b.RecordingUrl || b.RecordingSid || b.recording_url || b.recordingUrl || null;
  const duration = Number(b.DialCallDuration || b.CallDuration || b.Duration || b.duration || 0);
  return { callSid, callStatus, recordingUrl, duration, raw: b };
}

export const exotelStatusWebhook = catchAsync(async (req, res) => {
  const { callSid, callStatus, recordingUrl, duration, raw } = normalizeExotelPayload(req.body);
  if (!callSid) {
    return res.status(200).json({ ok: true, note: "no_sid" });
  }

  const call = await FeedbackCall.findOne({ exotelCallSid: callSid });
  if (!call) {
    return res.status(200).json({ ok: true, note: "unknown_call" });
  }

  const update = {};

  if (callStatus === "in-progress" || callStatus === "answered") {
    update.callStatus = "ANSWERED";
    update.startedAt = call.startedAt || new Date();
  }
  if (callStatus === "completed") {
    update.callStatus = "COMPLETED";
    update.endedAt = new Date();
  }
  if (callStatus === "failed") update.callStatus = "FAILED";
  if (callStatus === "busy") update.callStatus = "BUSY";
  if (callStatus === "no-answer" || callStatus === "noanswer") update.callStatus = "NO_ANSWER";

  if (recordingUrl) update.recordingUrl = String(recordingUrl);
  if (duration > 0) update.durationSec = duration;

  if (Object.keys(update).length) {
    await FeedbackCall.findByIdAndUpdate(call._id, update);
    let eventType = "CALL_INITIATED";
    if (update.callStatus === "COMPLETED") eventType = "CALL_COMPLETED";
    else if (["FAILED", "BUSY", "NO_ANSWER"].includes(update.callStatus)) eventType = "CALL_FAILED";
    else if (update.callStatus === "ANSWERED") eventType = "CALL_ANSWERED";
    await FeedbackEvent.create({
      feedbackCallId: call._id,
      type: eventType,
      payload: raw,
    });
  }

  res.status(200).json({ ok: true });
});

export const startCall = catchAsync(async (req, res) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) {
    throw new AppError("Invalid feedback call id", 400);
  }
  const result = await executeStartCall(id);
  if (!result.ok) {
    throw new AppError(
      result.message || result.reason || "Could not start call",
      400
    );
  }
  res.status(200).json(generateResponse("Success", "Call queued", result, null));
});

export const listCalls = catchAsync(async (req, res) => {
  const { status, from, to, limit = "50", skip = "0" } = req.query;
  const q = {};
  if (status) q.callStatus = status;
  if (from || to) {
    q.createdAt = {};
    if (from) q.createdAt.$gte = new Date(from);
    if (to) q.createdAt.$lte = new Date(to);
  }
  const lim = Math.min(200, Math.max(1, Number(limit) || 50));
  const sk = Math.max(0, Number(skip) || 0);
  const [items, total] = await Promise.all([
    FeedbackCall.find(q).sort({ createdAt: -1 }).skip(sk).limit(lim).lean(),
    FeedbackCall.countDocuments(q),
  ]);
  res.status(200).json(
    generateResponse("Success", "List", { items, total, limit: lim, skip: sk }, null)
  );
});

export const getCall = catchAsync(async (req, res) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) {
    throw new AppError("Invalid id", 400);
  }
  const doc = await FeedbackCall.findById(id).lean();
  if (!doc) throw new AppError("Not found", 404);
  res.status(200).json(generateResponse("Success", "Call", doc, null));
});

export const getTranscript = catchAsync(async (req, res) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) {
    throw new AppError("Invalid id", 400);
  }
  const doc = await FeedbackCall.findById(id).select("transcriptText transcriptJson").lean();
  if (!doc) throw new AppError("Not found", 404);
  res.status(200).json(generateResponse("Success", "Transcript", doc, null));
});

export const getEvents = catchAsync(async (req, res) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) {
    throw new AppError("Invalid id", 400);
  }
  const events = await FeedbackEvent.find({ feedbackCallId: id })
    .sort({ createdAt: 1 })
    .limit(500)
    .lean();
  res.status(200).json(generateResponse("Success", "Events", events, null));
});

export const resolveCallback = catchAsync(async (req, res) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) {
    throw new AppError("Invalid id", 400);
  }
  const doc = await FeedbackCall.findByIdAndUpdate(
    id,
    { resolutionStatus: "RESOLVED", wantsCallback: false },
    { new: true }
  );
  if (!doc) throw new AppError("Not found", 404);
  await FeedbackEvent.create({
    feedbackCallId: doc._id,
    type: "CALL_COMPLETED",
    payload: { manual: "resolve_callback" },
  });
  res.status(200).json(generateResponse("Success", "Updated", doc, null));
});

export const dashboardSummary = catchAsync(async (req, res) => {
  const [total, completed, answered, ratings, callbacks, failedish] = await Promise.all([
    FeedbackCall.countDocuments({}),
    FeedbackCall.countDocuments({ callStatus: "COMPLETED" }),
    FeedbackCall.countDocuments({ callStatus: { $in: ["ANSWERED", "COMPLETED"] } }),
    FeedbackCall.aggregate([
      { $match: { rating: { $gte: 1, $lte: 5 } } },
      { $group: { _id: null, avg: { $avg: "$rating" }, n: { $sum: 1 } } },
    ]),
    FeedbackCall.countDocuments({ wantsCallback: true }),
    FeedbackCall.countDocuments({ callStatus: { $in: ["FAILED", "BUSY", "NO_ANSWER"] } }),
  ]);

  const satisfied = await FeedbackCall.countDocuments({ satisfaction: "SATISFIED" });
  const denom = await FeedbackCall.countDocuments({ satisfaction: { $exists: true, $ne: null } });

  const avgRow = ratings[0] || {};
  res.status(200).json(
    generateResponse(
      "Success",
      "Summary",
      {
        totalCalls: total,
        connectedCalls: answered,
        completedCalls: completed,
        averageRating: avgRow.avg || null,
        ratingCount: avgRow.n || 0,
        satisfiedPercent: denom ? Math.round((100 * satisfied) / denom) : null,
        callbackRequired: callbacks,
        failedBusyNoAnswer: failedish,
      },
      null
    )
  );
});
