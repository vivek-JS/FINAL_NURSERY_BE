import fs from "fs";
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";

let failed = false;

function messaging() {
  if (failed) return null;
  if (!getApps().length) {
    const path = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!path || !fs.existsSync(path)) {
      failed = true;
      console.error("[fcm] FIREBASE_SERVICE_ACCOUNT file is missing");
      return null;
    }
    const serviceAccount = JSON.parse(fs.readFileSync(path, "utf8"));
    initializeApp({ credential: cert(serviceAccount) });
  }
  return getMessaging();
}

/** Wakes a closed Android app. Data values must be strings. */
export async function sendFcmNotification({ token, title, body, data = {} }) {
  const client = messaging();
  if (!client || !token || token.startsWith("ExponentPushToken[")) return false;
  const payload = {};
  for (const [key, value] of Object.entries(data)) {
    if (value == null) continue;
    payload[key] = String(value);
  }
  await client.send({
    token,
    notification: { title, body: body || title },
    data: payload,
    android: {
      priority: "high",
      notification: {
        channelId: "shed_assign",
        sound: "default",
        visibility: "public",
        notificationPriority: "PRIORITY_MAX",
        defaultVibrateTimings: false,
        vibrateTimingsMillis: [0, 450, 180, 450, 180, 700],
      },
    },
  });
  return true;
}
