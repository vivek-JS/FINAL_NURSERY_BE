import { isOrderBotTrigger } from "./whatsappOrderTriggers.js";
import { isTenDigitMobileMessage } from "../services/whatsappOrderFarmer.service.js";

const GLOBAL_COMMANDS = new Set([
  "cancel",
  "0",
  "रद्द",
  "help",
  "मदत",
  "menu",
  "मेनू",
]);

/**
 * Should this inbound text start or continue the order bot (ignore random chats)?
 * @param {string} text
 * @param {string | undefined} conversationStep - e.g. MAIN_MENU, ASK_MOBILE
 */
export function shouldAcceptOrderMessage(text, conversationStep) {
  const raw = String(text || "").trim();
  if (!raw) return false;

  const low = raw.toLowerCase();
  if (isOrderBotTrigger(raw)) return true;
  if (GLOBAL_COMMANDS.has(low)) return true;
  if (isTenDigitMobileMessage(raw)) return true;
  if (conversationStep && conversationStep !== "MAIN_MENU") return true;

  return false;
}
