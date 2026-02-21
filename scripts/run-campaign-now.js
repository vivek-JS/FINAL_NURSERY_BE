#!/usr/bin/env node
/**
 * Run a campaign directly without Redis.
 * Usage: node scripts/run-campaign-now.js --campaignId=xxx [--delaySeconds=10]
 *
 * Requires: MongoDB, Chrome, WhatsApp Web logged in (profile at WHATSAPP_PROFILE or ./whatsapp-profile)
 */

import path from "path";
import fs from "fs";
import mongoose from "mongoose";
import dotenv from "dotenv";
dotenv.config();

function cleanupPidFile() {
  const pidFile = process.env.CAMPAIGN_PID_FILE;
  if (pidFile && fs.existsSync(pidFile)) {
    try {
      fs.unlinkSync(pidFile);
    } catch (e) {}
  }
}

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled rejection (continuing):", reason);
});

const argv = process.argv.slice(2);
const args = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith("--")) {
    const eq = a.indexOf("=");
    const k = eq > 0 ? a.slice(2, eq) : a.slice(2);
    const v = eq > 0 ? a.slice(eq + 1) : (argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true);
    args[k] = v;
  }
}

const MONGO = process.env.MONGO_URL || process.env.MONGO_URI || "mongodb://localhost:27017/final_nursery";
const campaignId = args.campaignId;
const delaySec = Math.max(1, Math.min(300, Number(args.delaySeconds) || 10));

if (!campaignId) {
  console.error("Usage: node scripts/run-campaign-now.js --campaignId=YOUR_CAMPAIGN_ID [--delaySeconds=10]");
  process.exit(2);
}

async function main() {
  await mongoose.connect(MONGO, { dbName: process.env.DB_NAME });
  const Campaign = (await import("../models/campaign.model.js")).default;
  const CampaignMedia = (await import("../models/campaignMedia.model.js")).default;
  const SendEvent = (await import("../models/sendEvent.model.js")).default;
  const Farmer = (await import("../models/farmer.model.js")).default;
  const FarmerLead = (await import("../models/farmerLead.model.js")).default;
  const { initDriver, openWhatsAppWeb, waitForLoggedIn, sendToNumber, sendMediaAndMessage, closeDriver } = await import("./whatsapp-selenium.js");

  const campaign = await Campaign.findById(campaignId).lean();
  if (!campaign) {
    console.error("Campaign not found:", campaignId);
    process.exit(1);
  }

  const pending = (campaign.targets || []).filter((t) => !t.status || t.status === "pending");
  if (pending.length === 0) {
    console.log("No pending targets. Campaign may already be sent.");
    cleanupPidFile();
    process.exit(0);
  }

  console.log(`Campaign: ${campaign.name}`);
  console.log(`Pending targets: ${pending.length}`);
  console.log(`Delay: ${delaySec}s between messages\n`);

  const profileDir = path.resolve(process.cwd(), process.env.WHATSAPP_PROFILE || "whatsapp-profile");
  console.log("Opening Chrome...");
  console.log("Profile:", profileDir);
  console.log("(Close any other Chrome using this profile before running. If not logged in, scan QR code.)\n");

  let driver;
  try {
    driver = await initDriver({ userDataDir: profileDir, headless: false });
  } catch (err) {
    console.error("Failed to start Chrome:", err.message);
    if (String(err.message || "").includes("user data directory") || String(err.message || "").includes("already in use")) {
      console.error("\nTip: Close all Chrome windows, or use a different profile. Then run again.");
    }
    cleanupPidFile();
    process.exit(1);
  }

  try {
    console.log("Navigating to WhatsApp Web...");
    await openWhatsAppWeb(driver);
    console.log("Waiting for WhatsApp to load (scan QR if needed, up to 90s)...\n");
    const loggedIn = await waitForLoggedIn(driver, 90000);
    if (!loggedIn) {
      console.error("WhatsApp Web did not load in time. Please ensure you're logged in and try again.");
      console.log("Keeping browser open for 60s, then stay open. Press Ctrl+C when done.");
      await new Promise((r) => setTimeout(r, 60000));
      await new Promise(() => {});
      return;
    }
  console.log("WhatsApp Web ready. Starting sends...\n");

  let mediaPaths = [];
  if (campaign.mediaIds?.length) {
    const media = await CampaignMedia.find({ _id: { $in: campaign.mediaIds } }).lean();
    mediaPaths = media.map((m) => m.storagePath).filter(Boolean);
  }

  function normalizePhone(phone) {
    const digits = String(phone || "").replace(/\D/g, "");
    if (digits.length === 0) return null;
    let ten = digits;
    if (digits.length === 12 && digits.startsWith("91")) ten = digits.slice(2);
    else if (digits.length === 11 && digits.startsWith("0")) ten = digits.slice(1);
    if (ten.length !== 10 || !/^\d{10}$/.test(ten)) return null;
    return "91" + ten;
  }

  const PER_CONTACT_TIMEOUT_MS = 60000;
  const MAX_RETRIES = 3;
  const RETRY_DELAY_MS = 4000;
  let sent = 0;
  for (let i = 0; i < pending.length; i++) {
    const fresh = await Campaign.findById(campaignId).lean();
    if (fresh && fresh.status === "stopped") {
      console.log("\nCampaign stopped by user. Exiting.");
      break;
    }
    const t = pending[i];
    const fullPhone = normalizePhone(t.phone) || t.phone;
    const msg = t.message || campaign.message || "";

    let sendOk = false;
    let sendErr = null;
    try {
      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          const sendPromise = mediaPaths.length > 0
            ? sendMediaAndMessage(driver, fullPhone, msg, mediaPaths)
            : sendToNumber(driver, fullPhone, msg);
          const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error("Timeout (1 min) - moving to next")), PER_CONTACT_TIMEOUT_MS)
          );
          await Promise.race([sendPromise, timeoutPromise]);
          sendOk = true;
          break;
        } catch (e) {
          sendErr = e;
          const msgStr = String(e?.message || e || "").toLowerCase();
          if (msgStr.includes("not on whatsapp")) break;
          const isRetryable = msgStr.includes("stale") || msgStr.includes("timeout") || msgStr.includes("session") || msgStr.includes("element") || msgStr.includes("compose") || msgStr.includes("not found");
          if (attempt < MAX_RETRIES && isRetryable) {
            console.log(`  Retry ${attempt}/${MAX_RETRIES} for ${t.phone} in ${RETRY_DELAY_MS / 1000}s...`);
            await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
          } else {
            break;
          }
        }
      }
    } catch (e) {
      sendErr = e;
    }

    if (sendOk) {
      sent++;
      console.log(`  [${i + 1}/${pending.length}] Sent to ${t.phone || fullPhone}`);
      try {
        await Campaign.updateOne(
          { _id: campaignId },
          { $set: { "targets.$[elem].status": "sent" } },
          { arrayFilters: [{ "elem.phone": t.phone }] }
        );
        const sendEvent = await SendEvent.create({
          automationJobId: null,
          campaignId,
          farmerId: t.farmerId || null,
          phone: t.phone,
          name: t.name || null,
          message: msg,
          status: "sent",
        });
        if (t.farmerId) {
          const activity = {
            automationJobId: null,
            sendEventId: sendEvent._id,
            phone: t.phone,
            message: msg,
            status: "sent",
            timestamp: new Date(),
            source: "farmer",
          };
          await Farmer.updateOne({ _id: t.farmerId }, { $push: { whatsappAutomationActivities: activity } }).catch(() => {});
          await FarmerLead.updateOne({ _id: t.farmerId }, { $push: { whatsappAutomationActivities: { ...activity, source: "lead" } } }).catch(() => {});
        }
      } catch (dbErr) {
        console.warn("  DB update failed (message was sent):", dbErr?.message || dbErr);
      }
      await new Promise((r) => setTimeout(r, 2000));
    } else {
      console.error(`  [${i + 1}] Failed ${t.phone}:`, sendErr?.message || sendErr);
      if (sendErr?.message?.includes("Timeout")) {
        console.log(`  Skipping - moving to next contact`);
      }
      try {
        await Campaign.updateOne(
          { _id: campaignId },
          { $set: { "targets.$[elem].status": "error", "targets.$[elem].lastError": sendErr?.message } },
          { arrayFilters: [{ "elem.phone": t.phone }] }
        );
        const sendEvent = await SendEvent.create({
          automationJobId: null,
          campaignId,
          farmerId: t.farmerId || null,
          phone: t.phone,
          name: t.name || null,
          message: msg,
          status: "failed",
          error: sendErr?.message,
        });
        if (t.farmerId) {
          const activity = {
            automationJobId: null,
            sendEventId: sendEvent._id,
            phone: t.phone,
            message: msg,
            status: "failed",
            timestamp: new Date(),
            failedDetail: sendErr?.message,
            source: "farmer",
          };
          await Farmer.updateOne({ _id: t.farmerId }, { $push: { whatsappAutomationActivities: activity } }).catch(() => {});
          await FarmerLead.updateOne({ _id: t.farmerId }, { $push: { whatsappAutomationActivities: { ...activity, source: "lead" } } }).catch(() => {});
        }
      } catch (dbErr) {
        console.warn("  DB update failed:", dbErr?.message || dbErr);
      }
    }

    if (i < pending.length - 1) {
      console.log(`  Waiting ${delaySec}s before next contact...`);
      await new Promise((r) => setTimeout(r, delaySec * 1000));
    }
  }

    console.log(`\nDone. Sent: ${sent}/${pending.length}`);
    cleanupPidFile();
    console.log("Keeping browser open 60s, then stay open. Close manually or Ctrl+C to exit.");
    await new Promise((r) => setTimeout(r, 60000));
    console.log("Browser stays open. Press Ctrl+C when done.");
    await new Promise(() => {});
  } catch (err) {
    console.error("Error:", err?.message || err);
    cleanupPidFile();
    console.log("Keeping browser open 60s...");
    await new Promise((r) => setTimeout(r, 60000));
    console.log("Press Ctrl+C to exit.");
    await new Promise(() => {});
  }
}

process.on("uncaughtException", (err) => {
  console.error("Uncaught exception (browser stays open):", err?.message || err);
  setInterval(() => {}, 999999);
});

main().catch((e) => {
  console.error("Error:", e?.message || e);
  console.log("Keeping process alive. Press Ctrl+C to exit.");
  return new Promise(() => {});
});
