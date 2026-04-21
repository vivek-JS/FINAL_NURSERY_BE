import { getOpenAiApiKey } from "../../config/voiceFeedback.config.js";
import { MARATHI_FEEDBACK_SYSTEM_PROMPT } from "./marathiFeedback.prompt.js";

const TOOLS = [
  {
    type: "function",
    function: {
      name: "save_rating",
      description: "Save user rating between 1 and 5",
      parameters: {
        type: "object",
        properties: { rating: { type: "number" } },
        required: ["rating"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "save_feedback_summary",
      description: "Save satisfaction, issues, suggestions, callback need",
      parameters: {
        type: "object",
        properties: {
          satisfaction: {
            type: "string",
            enum: ["SATISFIED", "UNSATISFIED", "MIXED", "UNKNOWN"],
          },
          sentiment: {
            type: "string",
            enum: ["POSITIVE", "NEUTRAL", "NEGATIVE"],
          },
          issues: { type: "array", items: { type: "string" } },
          suggestions: { type: "array", items: { type: "string" } },
          wantsCallback: { type: "boolean" },
        },
        required: ["satisfaction", "sentiment"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "mark_callback_required",
      description: "Mark that customer wants a human callback",
      parameters: {
        type: "object",
        properties: { reason: { type: "string" } },
        required: ["reason"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_customer_context",
      description: "Get order and customer details",
      parameters: {
        type: "object",
        properties: { orderId: { type: "string" } },
        required: ["orderId"],
      },
    },
  },
];

/**
 * @param {{ messages: Array<{role:string,content?:string,tool_calls?:any,tool_call_id?:string,name?:string}>; orderContext: object }} param0
 * @returns {Promise<{ message: object, finishReason: string }>}
 */
export async function runOpenAiTurn({ messages, orderContext }) {
  const apiKey = getOpenAiApiKey();
  if (!apiKey) {
    const err = new Error("OpenAI is not configured (OPENAI_API_KEY).");
    err.code = "OPENAI_NOT_CONFIGURED";
    throw err;
  }

  const systemContent = `${MARATHI_FEEDBACK_SYSTEM_PROMPT}\n\nOrder context (JSON):\n${JSON.stringify(orderContext, null, 2)}`;

  const body = {
    model: process.env.OPENAI_FEEDBACK_MODEL || "gpt-4o-mini",
    messages: [{ role: "system", content: systemContent }, ...messages],
    tools: TOOLS,
    tool_choice: "auto",
    temperature: 0.4,
  };

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const t = await res.text();
    const err = new Error(`OpenAI error ${res.status}: ${t.slice(0, 500)}`);
    err.code = "OPENAI_HTTP_ERROR";
    throw err;
  }

  const data = await res.json();
  const choice = data.choices?.[0];
  return { message: choice?.message, finishReason: choice?.finish_reason || "stop" };
}
