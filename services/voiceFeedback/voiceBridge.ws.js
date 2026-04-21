import { WebSocketServer } from "ws";
import { parse as parseUrl } from "node:url";
import { getVoiceFeedbackWsSecret } from "../../config/voiceFeedback.config.js";
import { VoiceFeedbackSession } from "./voiceSession.orchestrator.js";

/**
 * Attach μ-law / control WebSocket for Exotel (or manual tests).
 * URL: /api/v1/voice-feedback/media?secret=...&feedbackCallId=...&nurseryOrderId=...
 */
export function attachVoiceFeedbackWebSocket(httpServer) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (request, socket, head) => {
    const pathname = parseUrl(request.url || "", false).pathname || "";
    if (!pathname.startsWith("/api/v1/voice-feedback/media")) {
      return;
    }

    const q = parseUrl(request.url || "", true).query || {};
    const secret = getVoiceFeedbackWsSecret();
    if (!secret || String(q.secret || "") !== secret) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    const feedbackCallId = String(q.feedbackCallId || "").trim();
    const nurseryOrderId = String(q.nurseryOrderId || "").trim();
    if (!feedbackCallId || !nurseryOrderId) {
      socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      const session = new VoiceFeedbackSession(ws, { feedbackCallId, nurseryOrderId });
      session.start().catch((e) => {
        console.error("VoiceFeedbackSession:", e);
        try {
          ws.close(1011, "session failed");
        } catch {
          /* noop */
        }
      });
    });
  });

  wss.on("error", (err) => console.error("Voice feedback WSS error:", err));
}
