#!/usr/bin/env node
import mongoose from "mongoose";
import AutomationJob from "../models/automationJob.model.js";
import SendEvent from "../models/sendEvent.model.js";
import Farmer from "../models/farmer.model.js";
import AutomationReport from "../models/automationReport.model.js";
import { initDriver, sendToNumber, closeDriver } from "./whatsapp-selenium.js";

const MONGO = process.env.MONGO_URI || "mongodb://localhost:27017/final_nursery";

async function connect() {
  await mongoose.connect(MONGO, { dbName: process.env.DB_NAME || undefined });
}

async function processJob(job) {
  console.log(`Processing job ${job._id} - ${job.name}`);
  const driver = await initDriver({ userDataDir: process.env.WHATSAPP_PROFILE || "./whatsapp-profile", headless: false });
  try {
    const pending = job.targets.filter((t) => !t.status || t.status === "pending");
    for (let i = 0; i < pending.length; i++) {
      const t = pending[i];
      try {
        if (job.mediaIds && job.mediaIds.length > 0) {
          // load media paths
          const CampaignMedia = (await import("../models/campaignMedia.model.js")).default;
          const mediaDocs = await CampaignMedia.find({ _id: { $in: job.mediaIds || [] } }).lean();
          const mediaFilePaths = mediaDocs.map((m) => m.storagePath).filter(Boolean);
          const { sendMediaAndMessage } = await import("./whatsapp-selenium.js");
          await sendMediaAndMessage(driver, t.phone, t.message || job.message || "", mediaFilePaths);
        } else {
          const result = await sendToNumber(driver, t.phone, t.message || job.message || "");
        }
        const sendEvent = await SendEvent.create({
          automationJobId: job._id,
          farmerId: t.farmerId || null,
          phone: t.phone,
          name: t.name || null,
          message: t.message || job.message || "",
          status: "sent",
        });
        // update farmer activity log
        if (t.farmerId) {
          await Farmer.updateOne(
            { _id: t.farmerId },
            {
              $push: {
                whatsappAutomationActivities: {
                  automationJobId: job._id,
                  sendEventId: sendEvent._id,
                  phone: t.phone,
                  message: t.message || job.message || "",
                  status: "sent",
                  timestamp: new Date(),
                },
              },
            }
          );
        }
        // mark in job.targets
        await AutomationJob.updateOne({ _id: job._id, "targets.phone": t.phone }, { $set: { "targets.$.status": "sent" } });
      } catch (err) {
        const sendEvent = await SendEvent.create({
          automationJobId: job._id,
          farmerId: t.farmerId || null,
          phone: t.phone,
          name: t.name || null,
          message: t.message || job.message || "",
          status: "failed",
          error: String(err.message || err),
        });
        if (t.farmerId) {
          await Farmer.updateOne(
            { _id: t.farmerId },
            {
              $push: {
                whatsappAutomationActivities: {
                  automationJobId: job._id,
                  sendEventId: sendEvent._id,
                  phone: t.phone,
                  message: t.message || job.message || "",
                  status: "failed",
                  timestamp: new Date(),
                },
              },
            }
          );
        }
        await AutomationJob.updateOne({ _id: job._id, "targets.phone": t.phone }, { $set: { "targets.$.status": "error" } });
      }
      // simple delay between sends
      await new Promise((r) => setTimeout(r, (Number(process.env.DELAY_SEC || 8) + Math.floor(Math.random() * 5)) * 1000));
    }
    // mark job completed
    await AutomationJob.findByIdAndUpdate(job._id, { status: "completed" });

    // create automation report summary
    try {
      const total = pending.length;
      const sent = await SendEvent.countDocuments({ automationJobId: job._id, status: "sent" });
      const failed = await SendEvent.countDocuments({ automationJobId: job._id, status: "failed" });
      const skipped = total - sent - failed;
      await AutomationReport.create({
        automationJobId: job._id,
        total,
        sent,
        failed,
        skipped,
        startedAt: new Date(), // approximate
        finishedAt: new Date(),
        createdBy: job.createdBy || null,
      });
    } catch (e) {
      console.warn("Failed to create automation report:", e.message || e);
    }
  } finally {
    await closeDriver(driver);
  }
}

async function run() {
  await connect();
  console.log("Worker connected to DB");
  // fetch active or created jobs
  const job = await AutomationJob.findOne({ status: { $in: ["active", "created"] } }).lean();
  if (!job) {
    console.log("No active jobs found. Exiting.");
    process.exit(0);
  }
  // ensure job is marked active
  await AutomationJob.findByIdAndUpdate(job._id, { status: "active" });
  await processJob(job);
  console.log("Worker finished.");
  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

