import Bull from "bull";
import FeedbackCall from "../models/feedbackCall.model.js";
import Farmer from "../models/farmer.model.js";
import {
  isVoiceFeedbackEnabled,
  getVoiceFeedbackDelayMs,
  shouldSkipInstantDispatchFeedback,
  getRedisUrlForBull,
} from "../config/voiceFeedback.config.js";
import { connectOutboundCall, isExotelVoiceConfigured } from "./voiceFeedback/exotelVoice.service.js";
import FeedbackEvent from "../models/feedbackEvent.model.js";

let queue = null;

function getQueue() {
  const redis = getRedisUrlForBull();
  if (!redis) return null;
  if (!queue) {
    try {
      queue = new Bull("voice-feedback-calls", redis, {
        defaultJobOptions: {
          removeOnComplete: 100,
          removeOnFail: 50,
          attempts: 2,
          backoff: { type: "fixed", delay: 60_000 },
        },
      });
      queue.process(async (job) => {
        const { feedbackCallId } = job.data;
        await executeStartCall(feedbackCallId);
      });
      queue.on("failed", (job, err) => {
        console.error("voice-feedback job failed:", job?.id, err?.message || err);
      });
    } catch (e) {
      console.error("voice-feedback Bull queue init failed:", e?.message || e);
      queue = null;
      return null;
    }
  }
  return queue;
}

async function resolveDialablePhone(order) {
  const ofm = order.orderFor?.mobileNumber;
  if (ofm != null && ofm !== "" && ofm !== 0) {
    const digits = String(ofm).replace(/\D/g, "");
    if (digits.length >= 10) return digits;
  }
  if (order.farmer) {
    const f = await Farmer.findById(order.farmer).select("mobileNumber").lean();
    if (f?.mobileNumber != null) return String(f.mobileNumber).replace(/\D/g, "");
  }
  return "";
}

function resolveCustomerName(order, farmerLean) {
  if (order.orderFor?.name) return String(order.orderFor.name).trim();
  if (farmerLean?.name) return String(farmerLean.name).trim();
  return "ग्राहक";
}

/**
 * Create a pending feedback call once per nursery order (idempotent).
 * @param {import("mongoose").Document|object} order — Order doc or lean
 * @param {{ isInstantDispatch?: boolean }} [options]
 * @returns {Promise<import("mongoose").Types.ObjectId|null>}
 */
export async function ensureFeedbackCallForOrder(order, options = {}) {
  if (!isVoiceFeedbackEnabled()) return null;
  if (!order || order.dealerOrder) return null;

  const oid = order._id;
  if (!oid) return null;

  if (options.isInstantDispatch && shouldSkipInstantDispatchFeedback()) {
    return null;
  }

  const phone = await resolveDialablePhone(order);
  if (!phone || phone.length < 10) {
    return null;
  }

  const farmerLean = order.farmer
    ? await Farmer.findById(order.farmer).select("name mobileNumber").lean()
    : null;

  const customerName = resolveCustomerName(order, farmerLean);
  const customerId = order.farmer || null;
  const dispatchDate = new Date();

  let fb = await FeedbackCall.findOne({ nurseryOrderId: oid });
  let created = false;
  if (!fb) {
    try {
      fb = await FeedbackCall.create({
        nurseryOrderId: oid,
        orderNumber: order.orderId,
        customerId,
        customerName,
        phone,
        dispatchDate,
        provider: "EXOTEL",
        callStatus: "PENDING",
        language: "mr",
      });
      created = true;
    } catch (e) {
      if (e?.code === 11000) {
        fb = await FeedbackCall.findOne({ nurseryOrderId: oid });
      } else {
        throw e;
      }
    }
  }

  if (!fb) return null;

  if (created) {
    await FeedbackEvent.create({
      feedbackCallId: fb._id,
      type: "CALL_INITIATED",
      payload: { source: "erp_dispatch", nurseryOrderId: String(oid) },
    });
  }

  if (fb.callStatus !== "PENDING") {
    return fb._id;
  }

  const delay = getVoiceFeedbackDelayMs();
  const q = getQueue();
  const jobPayload = { feedbackCallId: String(fb._id) };
  const jobOpts = { delay, jobId: `start-${fb._id}` };

  if (q) {
    try {
      await q.add(jobPayload, jobOpts);
    } catch (e) {
      if (String(e?.message || "").includes("job id already exists")) {
        /* duplicate schedule — ignore */
      } else {
        throw e;
      }
    }
  } else {
    setTimeout(() => {
      executeStartCall(String(fb._id)).catch((err) =>
        console.error("voice-feedback delayed start (no redis):", err)
      );
    }, delay);
  }

  return fb._id;
}

/**
 * Internal + manual start: Exotel outbound + persist SID.
 */
export async function executeStartCall(feedbackCallId) {
  const call = await FeedbackCall.findById(feedbackCallId);
  if (!call) return { ok: false, reason: "not_found" };
  if (!isVoiceFeedbackEnabled()) return { ok: false, reason: "disabled" };
  if (!["PENDING", "FAILED", "NO_ANSWER", "BUSY"].includes(call.callStatus)) {
    return { ok: false, reason: "not_dialable_state" };
  }
  if (!isExotelVoiceConfigured()) {
    console.warn("voice-feedback: Exotel voice not configured; skipping dial.");
    return { ok: false, reason: "exotel_not_configured" };
  }

  const customField = JSON.stringify({
    feedbackCallId: String(call._id),
    nurseryOrderId: String(call.nurseryOrderId),
    orderNumber: call.orderNumber,
    customerName: call.customerName,
    language: call.language,
  });

  let data;
  try {
    data = await connectOutboundCall({
      to: call.phone,
      record: true,
      customField,
    });
  } catch (e) {
    await FeedbackCall.findByIdAndUpdate(call._id, { callStatus: "FAILED" });
    await FeedbackEvent.create({
      feedbackCallId: call._id,
      type: "CALL_FAILED",
      payload: { outbound: true, message: String(e?.message || e) },
    });
    return { ok: false, reason: "exotel_error", message: String(e?.message || e) };
  }

  const sid =
    data?.Call?.Sid ||
    data?.Call?.sid ||
    data?.Sid ||
    data?.sid ||
    data?.CallSid ||
    null;

  if (!sid) {
    await FeedbackCall.findByIdAndUpdate(call._id, { callStatus: "FAILED" });
    await FeedbackEvent.create({
      feedbackCallId: call._id,
      type: "CALL_FAILED",
      payload: { outbound: true, message: "No CallSid in Exotel response", exotel: data },
    });
    return { ok: false, reason: "no_call_sid", raw: data };
  }

  await FeedbackCall.findByIdAndUpdate(call._id, {
    $set: {
      callStatus: "QUEUED",
      exotelCallSid: sid || undefined,
      scheduledAt: new Date(),
    },
    $inc: { attemptCount: 1 },
  });

  await FeedbackEvent.create({
    feedbackCallId: call._id,
    type: "CALL_INITIATED",
    payload: { exotel: data, outbound: true },
  });

  return { ok: true, sid, raw: data };
}
