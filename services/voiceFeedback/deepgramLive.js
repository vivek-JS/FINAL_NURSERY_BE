import WebSocket from "ws";
import { getDeepgramApiKey } from "../../config/voiceFeedback.config.js";

/**
 * Live transcription (μ-law 8 kHz — typical telephony). Forward binary frames from the voice WS to `dg.send(buf)`.
 */
export function createDeepgramLiveConnection({ language = "mr", onTranscript, onError }) {
  const apiKey = getDeepgramApiKey();
  if (!apiKey) {
    const err = new Error("Deepgram is not configured (DEEPGRAM_API_KEY).");
    err.code = "DEEPGRAM_NOT_CONFIGURED";
    throw err;
  }

  const params = new URLSearchParams({
    model: "nova-2",
    language,
    encoding: "mulaw",
    sample_rate: "8000",
    channels: "1",
    punctuate: "true",
    interim_results: "true",
    smart_format: "true",
  });

  const url = `wss://api.deepgram.com/v1/listen?${params.toString()}`;
  const dg = new WebSocket(url, {
    headers: { Authorization: `Token ${apiKey}` },
  });

  dg.on("message", (raw) => {
    try {
      const msg = JSON.parse(String(raw));
      const alt = msg?.channel?.alternatives?.[0];
      const transcript = alt?.transcript?.trim();
      if (!transcript) return;
      const isFinal = !!msg.is_final;
      onTranscript({ transcript, isFinal, raw: msg });
    } catch (e) {
      onError?.(e);
    }
  });

  dg.on("error", (e) => onError?.(e));

  return dg;
}
