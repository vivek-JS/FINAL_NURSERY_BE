import WebSocket from "ws";
import FeedbackCall from "../../models/feedbackCall.model.js";
import Order from "../../models/order.model.js";
import Farmer from "../../models/farmer.model.js";
import { buildOpeningLine } from "./marathiFeedback.prompt.js";
import { synthesizeSpeech } from "./elevenlabs.service.js";
import { runOpenAiTurn } from "./openaiFeedback.service.js";
import { createDeepgramLiveConnection } from "./deepgramLive.js";
import {
  appendTranscriptLine,
  logFeedbackEvent,
  saveRating,
  saveFeedbackSummary,
  markCallbackRequired,
} from "./feedbackPersistence.js";
import { getDeepgramApiKey } from "../../config/voiceFeedback.config.js";

async function buildOrderContext(nurseryOrderId) {
  const order = await Order.findById(nurseryOrderId)
    .select("orderId numberOfPlants orderStatus plantName farmer orderFor dealerOrder")
    .populate("plantName", "name")
    .lean();
  if (!order) return { error: "Order not found" };
  let farmerName = "";
  let mobile = "";
  if (order.farmer) {
    const f = await Farmer.findById(order.farmer).select("name mobileNumber").lean();
    farmerName = f?.name || "";
    mobile = f?.mobileNumber != null ? String(f.mobileNumber) : "";
  }
  return {
    orderId: String(order._id),
    orderNumber: order.orderId,
    orderStatus: order.orderStatus,
    plantName: order.plantName?.name || "",
    numberOfPlants: order.numberOfPlants,
    farmerName,
    mobile,
    orderForName: order.orderFor?.name || "",
    orderForMobile:
      order.orderFor?.mobileNumber != null &&
      order.orderFor.mobileNumber !== "" &&
      order.orderFor.mobileNumber !== 0
        ? String(order.orderFor.mobileNumber)
        : "",
  };
}

async function executeToolCall(feedbackCallId, nurseryOrderId, name, args) {
  switch (name) {
    case "save_rating":
      await saveRating(feedbackCallId, args.rating);
      return { ok: true };
    case "save_feedback_summary":
      await saveFeedbackSummary(feedbackCallId, {
        satisfaction: args.satisfaction,
        sentiment: args.sentiment,
        issues: args.issues,
        suggestions: args.suggestions,
        wantsCallback: args.wantsCallback,
      });
      return { ok: true };
    case "mark_callback_required":
      await markCallbackRequired(feedbackCallId, args.reason);
      return { ok: true };
    case "get_customer_context":
      return await buildOrderContext(args.orderId || nurseryOrderId);
    default:
      return { error: "unknown_tool" };
  }
}

/**
 * Runs OpenAI with tool loop until assistant returns speakable text.
 */
async function runAgentLoop(messages, orderContext, feedbackCallId, nurseryOrderId) {
  const max = 8;
  for (let i = 0; i < max; i++) {
    const { message } = await runOpenAiTurn({ messages, orderContext });
    if (!message) return "समजलं. धन्यवाद.";
    messages.push(message);

    if (message.tool_calls?.length) {
      for (const tc of message.tool_calls) {
        const fn = tc.function;
        let args = {};
        try {
          args = JSON.parse(fn.arguments || "{}");
        } catch {
          args = {};
        }
        const out = await executeToolCall(
          feedbackCallId,
          nurseryOrderId,
          fn.name,
          args
        );
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify(out),
        });
      }
      continue;
    }

    const text = (message.content || "").trim();
    if (text) return text;
    break;
  }
  return "आपल्या अभिप्रायाबद्दल धन्यवाद.";
}

export class VoiceFeedbackSession {
  /**
   * @param {import("ws").WebSocket} ws
   * @param {{ feedbackCallId: string; nurseryOrderId: string }} ctx
   */
  constructor(ws, ctx) {
    this.ws = ws;
    this.feedbackCallId = ctx.feedbackCallId;
    this.nurseryOrderId = ctx.nurseryOrderId;
    this.messages = [];
    this.dg = null;
    this.opened = false;
    this.orderContext = null;
  }

  async start() {
    const call = await FeedbackCall.findById(this.feedbackCallId);
    if (!call) {
      this.ws.close(1008, "Unknown feedback call");
      return;
    }
    this.orderContext = await buildOrderContext(this.nurseryOrderId);
    await logFeedbackEvent(this.feedbackCallId, "CALL_INITIATED", {
      nurseryOrderId: String(this.nurseryOrderId),
    });

    const opening = buildOpeningLine(call.customerName);
    await this.speakAgentLine(opening);
    this.messages.push({ role: "assistant", content: opening });

    const useDg = !!getDeepgramApiKey();
    if (useDg) {
      try {
        this.dg = createDeepgramLiveConnection({
          language: call.language === "multi" ? "multi" : "mr",
          onTranscript: (ev) => this.onDeepgram(ev),
          onError: (err) => console.error("Deepgram error:", err),
        });
        this.dg.on("open", () => {
          this.opened = true;
        });
      } catch (e) {
        console.error("Deepgram connect failed:", e?.message || e);
      }
    }

    this.ws.on("message", (data, isBinary) => {
      if (isBinary && this.dg && this.opened && this.dg.readyState === WebSocket.OPEN) {
        this.dg.send(data);
      } else if (!isBinary) {
        this.onControlJson(String(data));
      }
    });

    this.ws.on("close", () => this.dispose());
    this.ws.on("error", () => this.dispose());
  }

  async onDeepgram(ev) {
    if (!ev.isFinal || !ev.transcript) return;
    await logFeedbackEvent(this.feedbackCallId, "FINAL_TRANSCRIPT", { text: ev.transcript });
    await this.handleUserText(ev.transcript);
  }

  onControlJson(str) {
    try {
      const j = JSON.parse(str);
      if (j?.type === "simulate_user" && j.text) {
        this.handleUserText(String(j.text)).catch(console.error);
      }
    } catch {
      /* ignore */
    }
  }

  async handleUserText(text) {
    const t = text.trim();
    if (!t) return;
    await appendTranscriptLine(this.feedbackCallId, { speaker: "customer", text: t });
    this.messages.push({ role: "user", content: t });
    await logFeedbackEvent(this.feedbackCallId, "AI_TURN", { phase: "request" });

    let reply = "";
    try {
      reply = await runAgentLoop(
        this.messages,
        this.orderContext,
        this.feedbackCallId,
        this.nurseryOrderId
      );
    } catch (e) {
      console.error("OpenAI turn failed:", e?.message || e);
      reply = "माफ करा, सध्या तांत्रिक अडचण आहे. आमच्या टीमकडून आपल्याला परत कॉल केला जाईल.";
    }

    await this.speakAgentLine(reply);
  }

  async speakAgentLine(text) {
    const trimmed = (text || "").trim();
    if (!trimmed) return;
    await appendTranscriptLine(this.feedbackCallId, { speaker: "agent", text: trimmed });
    try {
      const audio = await synthesizeSpeech(trimmed);
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(audio, { binary: true });
      }
    } catch (e) {
      console.error("TTS failed:", e?.message || e);
      await logFeedbackEvent(this.feedbackCallId, "CALL_FAILED", {
        phase: "tts",
        message: String(e?.message || e),
      });
    }
  }

  dispose() {
    try {
      if (this.dg && this.dg.readyState === WebSocket.OPEN) this.dg.close();
    } catch {
      /* noop */
    }
    this.dg = null;
  }
}
