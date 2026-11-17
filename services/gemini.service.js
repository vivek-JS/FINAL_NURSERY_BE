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

/** Text prompt → parsed JSON matching `schema` (Gemini structured output). */
export async function generateJson(
  prompt,
  schema,
  { model = "gemini-2.5-flash", thinking = false } = {}
) {
  const ai = getGenAiClient();
  const response = await ai.models.generateContent({
    model,
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      responseJsonSchema: schema,
      ...(thinking ? {} : { thinkingConfig: { thinkingBudget: 0 } }),
    },
  });
  const text = response.text;
  if (!text || typeof text !== "string") {
    throw new Error("Empty response from Gemini");
  }
  return JSON.parse(text);
}

const SUPPLIER_INVOICE_PROMPT = `You are reading a supplier invoice or delivery bill for an Indian nursery store.
The bill may be printed or handwritten. Text may be English, Hindi, Marathi, or mixed. Digits may be Western or Devanagari.

Extract:
invoiceNumber: the vendor bill or invoice number, as printed. Empty string if not visible.
invoiceDate: the bill date as YYYY-MM-DD. Empty string if not visible.
supplierName: the seller or shop name. Empty string if not visible.
lines: every product row you can see. For each row:
- name: the item name as written, keep the script you see
- quantity: number of units, Western digits only
- unit: the unit if written, such as kg, g, ltr, ml, bag, pkt, box, nos. Empty string if not written
- rate: price for one unit, Western digits only, no currency symbol. 0 if not visible
- amount: line total if written, Western digits only. 0 if not visible

Rules:
Return only JSON matching the schema.
Do not invent rows that are not on the bill.
Skip totals, tax, freight, and round-off rows.
If handwriting is messy, still return the best reading of each row that has a name.
Convert Devanagari digits to 0-9 in numbers and in the invoice number.`;

const SUPPLIER_INVOICE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    invoiceNumber: { type: Type.STRING },
    invoiceDate: { type: Type.STRING },
    supplierName: { type: Type.STRING },
    lines: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          name: { type: Type.STRING },
          quantity: { type: Type.NUMBER },
          unit: { type: Type.STRING },
          rate: { type: Type.NUMBER },
          amount: { type: Type.NUMBER },
        },
      },
    },
  },
};

/**
 * Reads a printed or handwritten supplier bill into invoice number and line items.
 * @param {Buffer} buffer
 * @param {string} mimeType
 */
export async function extractSupplierInvoice(buffer, mimeType) {
  const ai = getGenAiClient();
  const imagePart = {
    inlineData: {
      mimeType: mimeType && mimeType.startsWith("image/") ? mimeType : "image/jpeg",
      data: buffer.toString("base64"),
    },
  };
  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: [imagePart, SUPPLIER_INVOICE_PROMPT],
    config: {
      responseMimeType: "application/json",
      responseJsonSchema: SUPPLIER_INVOICE_SCHEMA,
      thinkingConfig: { thinkingBudget: 0 },
    },
  });
  const text = response.text;
  if (!text || typeof text !== "string") {
    throw new Error("Could not read this bill. Try a clearer photo.");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Could not read this bill. Try a clearer photo.");
  }
}

export { Type as GeminiType };

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
