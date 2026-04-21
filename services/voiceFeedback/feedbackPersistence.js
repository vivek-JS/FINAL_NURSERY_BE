import FeedbackCall from "../../models/feedbackCall.model.js";
import FeedbackEvent from "../../models/feedbackEvent.model.js";

export async function appendTranscriptLine(feedbackCallId, line) {
  const doc = await FeedbackCall.findById(feedbackCallId);
  if (!doc) return;
  const label = line.speaker === "customer" ? "ग्राहक" : "सहाय्यक";
  const newLine = `${label}: ${line.text}`;
  if (!doc.transcriptJson) doc.transcriptJson = [];
  doc.transcriptJson.push({
    speaker: line.speaker,
    text: line.text,
    ts: line.ts ?? Date.now(),
  });
  doc.transcriptText = doc.transcriptText ? `${doc.transcriptText}\n${newLine}` : newLine;
  await doc.save();
}

export async function logFeedbackEvent(feedbackCallId, type, payload = {}) {
  await FeedbackEvent.create({ feedbackCallId, type, payload });
}

export async function saveRating(feedbackCallId, rating) {
  await FeedbackCall.findByIdAndUpdate(feedbackCallId, { rating: Number(rating) });
  await logFeedbackEvent(feedbackCallId, "TOOL_CALLED", { tool: "save_rating", rating });
}

export async function saveFeedbackSummary(feedbackCallId, data) {
  const wantsCallback = !!data.wantsCallback;
  await FeedbackCall.findByIdAndUpdate(feedbackCallId, {
    satisfaction: data.satisfaction,
    sentiment: data.sentiment,
    issues: data.issues || [],
    suggestions: data.suggestions || [],
    wantsCallback,
    resolutionStatus: wantsCallback ? "CALLBACK_REQUIRED" : "OPEN",
  });
  await logFeedbackEvent(feedbackCallId, "TOOL_CALLED", {
    tool: "save_feedback_summary",
    satisfaction: data.satisfaction,
    sentiment: data.sentiment,
  });
}

export async function markCallbackRequired(feedbackCallId, reason) {
  await FeedbackCall.findByIdAndUpdate(feedbackCallId, {
    wantsCallback: true,
    resolutionStatus: "CALLBACK_REQUIRED",
    escalationReason: reason || "",
  });
  await logFeedbackEvent(feedbackCallId, "TOOL_CALLED", {
    tool: "mark_callback_required",
    reason,
  });
}
