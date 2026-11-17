/**
 * Parallel farmer free-text Marathi via linked Baileys WhatsApp
 * (alongside WATI templates). OFF by default — set WHATSAPP_FARMER_MARATHI_BAILEYS=true.
 */

import { sendWhatsAppText } from "./whatsapp/transport.js";
import { isWhatsAppReady } from "./whatsapp/index.js";
import {
  formatOrderPlacedMarathiText,
  formatPaymentAcceptedMarathiText,
} from "../utility/orderConfirmationMarathiText.js";

function enabled() {
  if (process.env.WHATSAPP_ALERTS_ENABLED !== "true") return false;
  if (process.env.WHATSAPP_FARMER_MARATHI_BAILEYS !== "true") return false;
  return true;
}

function mobileOf(sendTo) {
  const raw = sendTo?.mobileNumber ?? sendTo?.phoneNumber;
  const digits = String(raw ?? "").replace(/\D/g, "");
  if (digits.length === 10) return `91${digits}`;
  if (digits.length === 12 && digits.startsWith("91")) return digits;
  return digits.length >= 10 ? digits : "";
}

/**
 * @param {"placed"|"payment"} kind
 * @param {object} sendTo
 * @param {object} orderDetails
 */
export async function sendFarmerOrderMarathiViaBaileys(kind, sendTo, orderDetails) {
  if (!enabled()) {
    return { skipped: true, reason: "disabled" };
  }
  if (!isWhatsAppReady) {
    return { skipped: true, reason: "whatsapp_not_ready" };
  }
  const mobile = mobileOf(sendTo);
  if (!mobile) {
    return { skipped: true, reason: "no_mobile" };
  }
  const text =
    kind === "payment"
      ? formatPaymentAcceptedMarathiText(sendTo, orderDetails)
      : formatOrderPlacedMarathiText(sendTo, orderDetails);
  try {
    const result = await sendWhatsAppText(mobile, text);
    if (result?.ok) {
      console.log(
        `[Baileys Marathi] Farmer ${kind} sent → ${mobile} (order ${orderDetails?.orderId || "—"})`
      );
    } else {
      console.warn(
        `[Baileys Marathi] Farmer ${kind} not sent:`,
        result?.reason || "unknown"
      );
    }
    return result;
  } catch (err) {
    console.error(`[Baileys Marathi] Farmer ${kind} error:`, err?.message || err);
    return { ok: false, reason: err?.message || String(err) };
  }
}
