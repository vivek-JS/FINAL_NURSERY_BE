import { WebSocketServer } from "ws";
import jwt from "jsonwebtoken";
import { parse as parseUrl } from "node:url";

const PATH = "/api/v1/shed/live";
const socketsByUser = new Map();

function userKey(id) {
  return String(id || "");
}

function addSocket(userId, ws) {
  const key = userKey(userId);
  if (!key) return;
  let set = socketsByUser.get(key);
  if (!set) {
    set = new Set();
    socketsByUser.set(key, set);
  }
  set.add(ws);
  ws.on("close", () => {
    set.delete(ws);
    if (set.size === 0) socketsByUser.delete(key);
  });
}

/** Push one inbox notice to every open shed app for this user. */
export function emitShedNotice(userId, notice) {
  const set = socketsByUser.get(userKey(userId));
  if (!set || set.size === 0) return;
  const payload = JSON.stringify({ event: "notice", ...notice });
  for (const ws of set) {
    if (ws.readyState === 1) {
      try {
        ws.send(payload);
      } catch {
        /* closed mid-send */
      }
    }
  }
}

function userIdFromToken(token) {
  const raw = String(token || "").trim();
  if (!raw || !process.env.PRIVATE_KEY) return "";
  const { data } = jwt.verify(raw, process.env.PRIVATE_KEY);
  return userKey(data?._id);
}

/**
 * Live notices while the shed app is open.
 * Client connects, then sends { "token": "<access token>" } as the first message.
 */
export function attachShedLiveSocket(httpServer) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (request, socket, head) => {
    const pathname = parseUrl(request.url || "", false).pathname || "";
    if (pathname !== PATH) return;

    wss.handleUpgrade(request, socket, head, (ws) => {
      let authed = false;
      const timer = setTimeout(() => {
        if (!authed) {
          try {
            ws.close(4001, "auth timeout");
          } catch {
            /* noop */
          }
        }
      }, 8000);

      ws.on("message", (buf) => {
        let msg = null;
        try {
          msg = JSON.parse(String(buf || ""));
        } catch {
          msg = null;
        }
        if (!authed) {
          try {
            const userId = userIdFromToken(msg?.token);
            if (!userId) {
              ws.close(4001, "unauthorized");
              return;
            }
            authed = true;
            clearTimeout(timer);
            addSocket(userId, ws);
            ws.send(JSON.stringify({ event: "ready" }));
          } catch {
            try {
              ws.close(4001, "unauthorized");
            } catch {
              /* noop */
            }
          }
          return;
        }
        if (msg?.event === "ping") {
          try {
            ws.send(JSON.stringify({ event: "pong" }));
          } catch {
            /* noop */
          }
        }
      });
    });
  });

  wss.on("error", (err) => console.error("Shed live socket error:", err));
}
