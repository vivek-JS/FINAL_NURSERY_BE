/**
 * Routes incoming WhatsApp messages + delivery receipts to the existing ERP handlers.
 * Handlers are imported lazily: they import whatsappAlertService, which imports this module's facade.
 */
import { getActiveSocket, waEvents } from "./connection.js";
import { toInboundMessage } from "./messageAdapter.js";
import { sendWhatsAppText } from "./transport.js";

/** Baileys status (ERROR 0 … PLAYED 5) → campaign ack scale (-1 failed … 4 played). */
const toCampaignAck = (status) => status - 1;

const logError = (scope) => (err) =>
  console.error(`[WhatsApp] ${scope} handler error:`, err?.message || err);

async function routeInbound(raw) {
  const msg = await toInboundMessage(raw, { socket: getActiveSocket(), sendText: sendWhatsAppText });
  if (msg.fromMe || msg.isStatus) return;

  const [{ handleCampaignInboundMessage }, { handleAgriLoadInboundMessage }, { handleWebJsInboundMessage }] =
    await Promise.all([
      import("../whatsappCampaignBridge.service.js"),
      import("../whatsappAgriLoadInbound.service.js"),
      import("../whatsappOrderWebInbound.js"),
    ]);

  await handleCampaignInboundMessage(msg).catch(logError("Campaign inbound"));
  const agri = await handleAgriLoadInboundMessage(msg);
  if (agri?.handled) return;
  await handleWebJsInboundMessage(msg);
}

async function routeAck(messageId, status) {
  const { handleCampaignMessageAck } = await import("../whatsappCampaignBridge.service.js");
  await handleCampaignMessageAck(messageId, toCampaignAck(status));
}

async function flushQueuedAlerts() {
  const { flushPendingWhatsAppAlerts } = await import("../whatsappAlertService.js");
  await flushPendingWhatsAppAlerts();
}

let attached = false;

export function attachWhatsAppRouters() {
  if (attached) return;
  attached = true;
  waEvents.on("message", (raw) => void routeInbound(raw).catch(logError("Inbound")));
  waEvents.on("ack", (id, status) => void routeAck(id, status).catch(logError("Ack")));
  waEvents.on("ready", () => void flushQueuedAlerts().catch(logError("Alert flush")));
}
