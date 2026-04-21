/**
 * Exotel outbound voice — India cluster (Mumbai).
 *
 * ## Integration notes (spike / operator checklist)
 *
 * 1. **Outbound connect (this file)**  
 *    `POST https://{EXOTEL_SUBDOMAIN}/v1/Accounts/{AccountSid}/Calls/connect.json`  
 *    Form body (x-www-form-urlencoded), Basic auth = API key : API token.  
 *    Typical fields (India outbound to customer + applet):
 *    - `From` — customer mobile to dial (E.164 or 10-digit as per Exotel account)
 *    - `CallerId` — your Exotel virtual / ExoPhone number shown to callee
 *    - `Url` — ExoML / Voice applet URL (same idea as `EXOTEL_FLOW_URL`)
 *    - `CallType` — `trans` (transactional) when applicable
 *    - `StatusCallback` — HTTPS URL for terminal + answered events
 *    - `StatusCallbackEvents[0]=terminal&StatusCallbackEvents[1]=answered` (or comma form per docs)
 *    - `StatusCallbackContentType` — `application/json` if you prefer JSON payloads
 *    - `CustomField` — opaque string; we store JSON `{ feedbackCallId, orderId }` for correlation
 *    - `Record` — `true` to enable account-level recording when supported
 *
 * 2. **Custom streaming (Deepgram + OpenAI + ElevenLabs)**  
 *    Exotel product naming varies (Voicebot / App Builder / programmable voice).  
 *    You must point the applet (or passthru) at a capability that streams **8-bit μ-law 8 kHz**
 *    (or another encoding Deepgram accepts) to your server WebSocket:
 *    `wss://{PUBLIC_BASE_URL}/api/v1/voice-feedback/media?...`  
 *    Configure query `secret` = `VOICE_FEEDBACK_WS_SECRET` if your Exotel flow can append it.  
 *    Until the stream is wired, outbound calls still run; transcript/AI fill once audio reaches `voiceBridge.ws.js`.
 *
 * 3. **Compliance**  
 *    India TRAI / DLT and consent rules apply to outbound; use transactional templates / opt-in as required.
 *
 * @see https://developer.exotel.com/api/make-a-call-api
 */
import axios from "axios";
import {
  getExotelApiKey,
  getExotelApiToken,
  getExotelAccountSid,
  getExotelSubdomain,
} from "../../config/exotel.config.js";
import {
  getExotelCallerId,
  getExotelFlowUrl,
  getPublicBaseUrl,
} from "../../config/voiceFeedback.config.js";

export function isExotelVoiceConfigured() {
  return !!(
    getExotelApiKey() &&
    getExotelApiToken() &&
    getExotelAccountSid() &&
    getExotelCallerId() &&
    getExotelFlowUrl()
  );
}

/**
 * @param {{ to: string; record?: boolean; statusCallback?: string; customField?: string }} params
 */
export async function connectOutboundCall(params) {
  const apiKey = getExotelApiKey();
  const apiToken = getExotelApiToken();
  const sid = getExotelAccountSid();
  const subdomain = getExotelSubdomain();
  const callerId = getExotelCallerId();
  const flowUrl = getExotelFlowUrl();

  if (!apiKey || !apiToken || !sid || !callerId || !flowUrl) {
    const err = new Error("Exotel voice is not fully configured (credentials, EXOTEL_CALLER_ID, EXOTEL_FLOW_URL).");
    err.code = "EXOTEL_VOICE_NOT_CONFIGURED";
    throw err;
  }

  const base = `https://${subdomain}`;
  const url = `${base}/v1/Accounts/${sid}/Calls/connect.json`;

  const statusCallback =
    params.statusCallback ||
    `${getPublicBaseUrl()}/api/v1/voice-feedback/exotel/status`;

  const body = new URLSearchParams();
  body.set("From", String(params.to).replace(/\s/g, ""));
  body.set("CallerId", String(callerId).replace(/\s/g, ""));
  body.set("Url", flowUrl);
  body.set("CallType", "trans");
  body.set("Record", params.record !== false ? "true" : "false");
  body.set("StatusCallback", statusCallback);
  body.set("StatusCallbackEvents", "terminal,answered");
  body.set("StatusCallbackContentType", "application/json");
  if (params.customField) body.set("CustomField", params.customField);
  const payload = body.toString();

  const response = await axios.post(url, payload, {
    auth: { username: apiKey, password: apiToken },
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    timeout: 45000,
  });

  return response.data;
}
