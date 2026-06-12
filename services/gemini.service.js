import { GoogleGenAI, Type } from "@google/genai";

/** User instruction sent with the image; structured output schema enforces field shapes. */
const UPI_RECEIPT_PROMPT = `You are reading a UPI payment receipt screenshot (India). Text may be English, Marathi, or mixed.

Extract only these fields:
name
amount
utr_number
transaction_id
date
time
status
app_name
raw_text

Rules:
Return only valid JSON.
If a field is not visible return null.
Do not guess.
Receipts may show numbers in Marathi/Devanagari digits (०१२३४५६७८९). Always convert amount, utr_number, transaction_id, date, and time to Western Arabic digits (0-9) only.
amount must contain only numeric value without ₹ symbol (e.g. 500 or 1234.50).
utr_number must contain only reference number digits/characters as shown, using 0-9 not Devanagari.
status must be SUCCESS, FAILED, or PENDING.
raw_text must contain all visible OCR text from image exactly as shown (keep Marathi script and Devanagari digits in raw_text).`;

/** JSON schema for Gemini structured output (all string fields; nulls normalized in controller). */
const UPI_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    name: { type: Type.STRING, description: "Payer/payee or merchant name if visible" },
    amount: {
      type: Type.STRING,
      description: "Numeric amount only (Western 0-9), no currency symbol; convert Marathi/Devanagari digits",
    },
    utr_number: {
      type: Type.STRING,
      description: "UPI reference / UTR using Western 0-9 digits",
    },
    transaction_id: {
      type: Type.STRING,
      description: "Bank or app transaction id if shown, Western 0-9 digits",
    },
    date: { type: Type.STRING, description: "Date as on receipt, Western 0-9 digits" },
    time: { type: Type.STRING, description: "Time as on receipt, Western 0-9 digits" },
    status: { type: Type.STRING, description: "One of SUCCESS, FAILED, PENDING" },
    app_name: { type: Type.STRING, description: "e.g. PhonePe, Google Pay, Paytm" },
    raw_text: { type: Type.STRING, description: "All visible text from the screenshot" },
  },
  propertyOrdering: [
    "name",
    "amount",
    "utr_number",
    "transaction_id",
    "date",
    "time",
    "status",
    "app_name",
    "raw_text",
  ],
};

let clientSingleton = null;

function getGenAiClient() {
  const key = process.env.GEMINI_API_KEY;
  if (!key || typeof key !== "string" || !key.trim()) {
    throw new Error("GEMINI_API_KEY is not configured");
  }
  if (!clientSingleton) {
    clientSingleton = new GoogleGenAI({ apiKey: key.trim() });
  }
  return clientSingleton;
}

/**
 * Calls Gemini with inline image bytes and returns parsed JSON fields.
 * @param {Buffer} buffer
 * @param {string} mimeType e.g. image/jpeg
 */
export async function extractUpiFromImage(buffer, mimeType) {
  const ai = getGenAiClient();
  const imagePart = {
    inlineData: {
      mimeType: mimeType && mimeType.startsWith("image/") ? mimeType : "image/jpeg",
      data: buffer.toString("base64"),
    },
  };

  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: [imagePart, UPI_RECEIPT_PROMPT],
    config: {
      responseMimeType: "application/json",
      responseJsonSchema: UPI_RESPONSE_SCHEMA,
    },
  });

  const text = response.text;
  if (!text || typeof text !== "string") {
    throw new Error("Empty response from Gemini");
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Invalid JSON returned from Gemini");
  }
}
