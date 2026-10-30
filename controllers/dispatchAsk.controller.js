import mongoose from "mongoose";
import { getDispatchLagwad } from "../services/dispatchLagwad.service.js";
import { parseWindowDays } from "../utility/dispatchLagwadBuckets.js";
import {
  buildDispatchBrief,
  expandDispatchRange,
  inclusiveDays,
  parseDispatchInsights,
  rulesDispatchInsights,
} from "../utility/dispatchAskBrief.js";

const MAX_RANGE_DAYS = 120;
const DEFAULT_QUESTION =
  "What do the bookings in the selected dates tell us? Where are we short, where can we still book, and how does this compare with the same days before and after?";

function analystPrompt(brief) {
  return [
    "You are the booking desk analyst at Ram Biotech, a plant nursery.",
    "Staff picked a date range on the dispatch screen. They see only the SELECTED section.",
    "BEFORE and AFTER are the same number of days on either side. Use them only to judge booking trend and whether the next period is already full.",
    "Do not list BEFORE or AFTER as their own report. Every insight must be about the SELECTED dates.",
    "",
    "Cover bookings first:",
    "- Are selected bookings covered by lagwad, short, or still open?",
    "- Which selected slots are over-booked, and which still have room to book?",
    "- Are selected bookings higher or lower than the days just before?",
    "- Is the period after already tight, so new bookings in the selected range should slow down?",
    "- How much of the selected dispatch is overdue?",
    "If they asked something specific, answer that first, still from these numbers only.",
    "",
    "Use only numbers in the brief. Never invent crops, dates, or plant counts.",
    "Reply in the language of the question. Marathi in Devanagari if the question is Marathi, Hindi if Hindi, otherwise simple English.",
    "",
    "OUTPUT: one JSON object, nothing else.",
    'headline: one line about the SELECTED range.',
    'insights: 3 to 6 items. Each has title (short), detail (1-2 sentences, no line breaks), tone ("risk" | "watch" | "ok").',
    "risk = over-booked or overdue. ok = room to book. watch = trend or a tight next period.",
    "",
    brief,
  ].join("\n");
}

async function askOpenRouter(prompt) {
  const apiKey = String(process.env.OPENROUTER_API_KEY || "").trim();
  if (!apiKey) {
    const error = new Error("OPENROUTER_API_KEY is not set");
    error.status = 500;
    throw error;
  }
  const model = String(process.env.OPENROUTER_MODEL || "openrouter/free").trim() || "openrouter/free";
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://erp.rambiotechplants.com",
      "X-Title": "Ram Live Dispatch",
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        { role: "system", content: "Reply with a single JSON object. No markdown." },
        { role: "user", content: prompt },
      ],
    }),
    signal: AbortSignal.timeout(45000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body?.error?.message || `OpenRouter HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  const text = body?.choices?.[0]?.message?.content || "";
  return { model: body?.model || model, parsed: parseDispatchInsights(text) };
}

export const askDispatchAnalyst = async (req, res) => {
  try {
    const { plantId, subtypeId, from, to } = req.body || {};
    if (!mongoose.isValidObjectId(String(plantId || ""))) {
      return res.status(400).json({ success: false, message: "Valid plantId is required" });
    }
    if (subtypeId && !mongoose.isValidObjectId(String(subtypeId))) {
      return res.status(400).json({ success: false, message: "Invalid subtypeId" });
    }
    const range = expandDispatchRange(from, to);
    if (!range) {
      return res.status(400).json({ success: false, message: "from/to must be YYYY-MM-DD and from <= to" });
    }
    if (inclusiveDays(range.focusFrom, range.focusTo) > MAX_RANGE_DAYS) {
      return res.status(400).json({ success: false, message: `Range is limited to ${MAX_RANGE_DAYS} days` });
    }

    const windowDays = parseWindowDays(req.body?.windowDays);
    const question = String(req.body?.question || "").trim().slice(0, 500) || DEFAULT_QUESTION;
    const query = { plantId, subtypeId: subtypeId || null, windowDays };
    const [before, focus, after] = await Promise.all([
      getDispatchLagwad({ ...query, from: range.beforeFrom, to: range.beforeTo, rollPast: false }),
      getDispatchLagwad({ ...query, from: range.focusFrom, to: range.focusTo }),
      getDispatchLagwad({ ...query, from: range.afterFrom, to: range.afterTo, rollPast: false }),
    ]);

    const brief = buildDispatchBrief({
      crop: focus.context?.plantName,
      subtype: focus.context?.subtypeName,
      today: focus.context?.today,
      windowDays,
      range,
      before,
      focus,
      after,
      question,
    });

    let advice = null;
    let model = process.env.OPENROUTER_MODEL || "openrouter/free";
    let source = "rules";
    try {
      let reply = await askOpenRouter(analystPrompt(brief));
      if (!reply.parsed) reply = await askOpenRouter(analystPrompt(brief));
      if (reply.parsed) {
        advice = reply.parsed;
        model = reply.model;
        source = "openrouter";
      }
    } catch (error) {
      console.error("askDispatchAnalyst openrouter:", error?.message || error);
    }
    if (!advice) advice = rulesDispatchInsights({ focus, before, after, padDays: range.padDays });

    return res.status(200).json({
      success: true,
      focus: { from: range.focusFrom, to: range.focusTo },
      context: {
        beforeFrom: range.beforeFrom,
        beforeTo: range.beforeTo,
        afterFrom: range.afterFrom,
        afterTo: range.afterTo,
        padDays: range.padDays,
      },
      headline: advice.headline,
      insights: advice.insights,
      source,
      model,
      question,
    });
  } catch (error) {
    console.error("askDispatchAnalyst:", error);
    return res.status(500).json({ success: false, message: "Could not read dispatch bookings" });
  }
};
