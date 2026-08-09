#!/usr/bin/env node
/**
 * Local WhatsApp alert test — QR scanner + test message.
 *
 * Usage (from FINAL_NURSERY_BE):
 *   node scripts/whatsapp-test-local.mjs              # show QR + wait for scan
 *   node scripts/whatsapp-test-local.mjs --send       # send test after ready
 *   node scripts/whatsapp-test-local.mjs --status     # status only
 *   node scripts/whatsapp-test-local.mjs --qr         # print QR from last-qr.txt
 *
 * Requires WHATSAPP_ALERTS_ENABLED=true and WHATSAPP_ADMIN_NUMBERS in .env.
 * API server (npm run dev) should be running on PORT — uses its WhatsApp client.
 */

import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import qrcode from "qrcode-terminal";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PORT = process.env.PORT || 8000;
const API = `http://localhost:${PORT}/api/v1`;

const args = new Set(process.argv.slice(2));
const mode = args.has("--status")
  ? "status"
  : args.has("--qr")
    ? "qr"
    : args.has("--send")
      ? "send"
      : "full";

function printQrFromFile() {
  const qrFile = path.join(
    process.env.WHATSAPP_SESSION_PATH || path.join(ROOT, ".wwebjs_auth"),
    "last-qr.txt"
  );
  if (!fs.existsSync(qrFile)) {
    console.log("No QR file yet. Start API server: npm run dev");
    console.log("QR will appear in server logs and at:", qrFile);
    return false;
  }
  const lines = fs.readFileSync(qrFile, "utf8").trim().split("\n");
  console.log(lines[0] || "QR file");
  if (!lines[1]) {
    console.log("QR payload empty — session may already be logged in.");
    return false;
  }
  console.log("\n📱 Scan with WhatsApp → Settings → Linked Devices → Link a device:\n");
  qrcode.generate(lines[1], { small: true });
  console.log("\nFile:", qrFile);
  return true;
}

async function resolveAuthToken() {
  if (process.env.SUPER_ADMIN_TOKEN) return process.env.SUPER_ADMIN_TOKEN;

  const url = process.env.MONGO_URL || process.env.MONGODB_URI;
  if (!url) throw new Error("MONGO_URL required to mint JWT (or set SUPER_ADMIN_TOKEN)");

  await mongoose.connect(url);
  const user = await mongoose.connection
    .collection("users")
    .findOne({ role: "SUPER_ADMIN" }, { projection: { _id: 1, phoneNumber: 1, name: 1, role: 1, jobTitle: 1 } });
  await mongoose.disconnect();

  if (!user?._id) throw new Error("No SUPER_ADMIN user in DB");

  const secret = process.env.JWT_SECRET || process.env.PRIVATE_KEY;
  if (!secret) throw new Error("JWT_SECRET or PRIVATE_KEY required");

  return jwt.sign(
    {
      _id: String(user._id),
      phoneNumber: user.phoneNumber,
      role: user.role,
      jobTitle: user.jobTitle || user.role,
      name: user.name || "Super Admin",
      type: "access",
    },
    secret,
    { expiresIn: "1d", audience: "nursery-users", issuer: "nursery-app" }
  );
}

async function apiGet(token, pathSuffix) {
  const res = await fetch(`${API}${pathSuffix}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.json();
}

async function apiPost(token, pathSuffix, body = {}) {
  const res = await fetch(`${API}${pathSuffix}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function waitForReady(token, maxSec = 180) {
  const start = Date.now();
  while (Date.now() - start < maxSec * 1000) {
    const status = await apiGet(token, "/whatsapp-alert/status");
    if (status.whatsappReady) return status;
    if (status.qr?.hasQr) printQrFromFile();
    process.stdout.write(".");
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error(`WhatsApp not ready after ${maxSec}s — scan QR and retry`);
}

async function main() {
  console.log("WhatsApp local test (.env)");
  console.log("  WHATSAPP_ALERTS_ENABLED:", process.env.WHATSAPP_ALERTS_ENABLED);
  console.log("  WHATSAPP_ADMIN_NUMBERS:", process.env.WHATSAPP_ADMIN_NUMBERS);
  console.log("  WHATSAPP_SESSION_PATH:", process.env.WHATSAPP_SESSION_PATH);
  console.log("");

  if (mode === "qr") {
    printQrFromFile();
    return;
  }

  const token = await resolveAuthToken();
  let status = await apiGet(token, "/whatsapp-alert/status");

  if (mode === "status") {
    console.log(JSON.stringify(status, null, 2));
    return;
  }

  if (!status.whatsappReady) {
    console.log("WhatsApp not connected. Showing QR — scan with your phone:\n");
    printQrFromFile();
    if (mode === "full" || mode === "send") {
      console.log("\nWaiting for scan (up to 3 min)...");
      status = await waitForReady(token, 180);
    }
  }

  if (mode === "full" || mode === "send") {
    if (!status?.whatsappReady) {
      console.error("\nStill not ready. Run: node scripts/whatsapp-test-local.mjs --qr");
      process.exit(1);
    }
    console.log("\n✅ WhatsApp ready:", status.linkedBotPhone);
    const testMsg = `🧪 ERP WhatsApp test — ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST`;
    const result = await apiPost(token, "/whatsapp-alert/test", { message: testMsg });
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== "Success") process.exit(1);
  }
}

main().catch((err) => {
  console.error("Error:", err.message || err);
  process.exit(1);
});
