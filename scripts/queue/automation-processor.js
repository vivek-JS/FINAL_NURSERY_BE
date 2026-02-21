import Queue from "bull";
import mongoose from "mongoose";
import AutomationJob from "../../models/automationJob.model.js";
import SendEvent from "../../models/sendEvent.model.js";
import Farmer from "../../models/farmer.model.js";
import AutomationReport from "../../models/automationReport.model.js";
import { initDriver, sendToNumber, closeDriver } from "../whatsapp-selenium.js";

const REDIS = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const queue = new Queue("automation-jobs", REDIS);

const MONGO = process.env.MONGO_URI || "mongodb://localhost:27017/final_nursery";

async function connect() {
  await mongoose.connect(MONGO, { dbName: process.env.DB_NAME || undefined });
}

// process one job at a time to avoid multiple browsers launching concurrently
queue.process(1, async (job) => {
  await connect();
  const jobId = job.data.jobId;
  const jobDoc = await AutomationJob.findById(jobId).lean();
  if (!jobDoc) throw new Error("Job not found: " + jobId);
  console.log("Processing queued automation job:", jobId, jobDoc.name);

  // determine profile user-data-dir
  let profileUserDataDir = process.env.WHATSAPP_PROFILE || "./whatsapp-profile";
  if (jobDoc.profileId) {
    try {
      const WhatsAppProfile = (await import("../../models/whatsappProfile.model.js")).default;
      const profile = await WhatsAppProfile.findById(jobDoc.profileId).lean();
      if (profile && profile.userDataDir) profileUserDataDir = profile.userDataDir;
    } catch (e) {
      console.warn("Could not load profile for job:", e.message || e);
    }
  }
  const driver = await initDriver({ userDataDir: profileUserDataDir, headless: false });
  const pending = jobDoc.targets.filter((t) => !t.status || t.status === "pending");
  const startTs = Date.now();
  try {
    // Prepare media file paths if job has mediaIds
    let mediaFilePaths = [];
    if (jobDoc.mediaIds && jobDoc.mediaIds.length > 0) {
      try {
        const CampaignMedia = (await import("../../models/campaignMedia.model.js")).default;
        const mediaDocs = await CampaignMedia.find({ _id: { $in: jobDoc.mediaIds } }).lean();
        mediaFilePaths = mediaDocs.map((m) => m.storagePath).filter(Boolean);
      } catch (e) {
        console.warn("Failed to load media docs:", e.message || e);
      }
    }

    for (let i = 0; i < pending.length; i++) {
      const t = pending[i];
      try {
        if (mediaFilePaths && mediaFilePaths.length > 0) {
          await sendToNumber(driver, t.phone, t.message || jobDoc.message || "");
          // send media with caption if provided
          await sendToNumber(driver, t.phone, t.message || jobDoc.message || "");
          // Use sendMediaAndMessage to attach files
          const { sendMediaAndMessage } = await import("../whatsapp-selenium.js");
          await sendMediaAndMessage(driver, t.phone, t.message || jobDoc.message || "", mediaFilePaths);
        } else {
          await sendToNumber(driver, t.phone, t.message || jobDoc.message || "");
        }
        const sendEvent = await SendEvent.create({
          automationJobId: jobDoc._id,
          farmerId: t.farmerId || null,
          phone: t.phone,
          name: t.name || null,
          message: t.message || jobDoc.message || "",
          status: "sent",
        });
        if (t.farmerId) {
          await Farmer.updateOne({ _id: t.farmerId }, { $push: { whatsappAutomationActivities: {
            automationJobId: jobDoc._id,
            sendEventId: sendEvent._id,
            phone: t.phone,
            message: t.message || jobDoc.message || "",
            status: "sent",
            timestamp: new Date()
          } } });
        }
        await AutomationJob.updateOne({ _id: jobDoc._id, "targets.phone": t.phone }, { $set: { "targets.$.status": "sent" } });
      } catch (err) {
        const sendEvent = await SendEvent.create({
          automationJobId: jobDoc._id,
          farmerId: t.farmerId || null,
          phone: t.phone,
          name: t.name || null,
          message: t.message || jobDoc.message || "",
          status: "failed",
          error: String(err.message || err),
        });
        if (t.farmerId) {
          await Farmer.updateOne({ _id: t.farmerId }, { $push: { whatsappAutomationActivities: {
            automationJobId: jobDoc._id,
            sendEventId: sendEvent._id,
            phone: t.phone,
            message: t.message || jobDoc.message || "",
            status: "failed",
            timestamp: new Date()
          } } });
        }
        await AutomationJob.updateOne({ _id: jobDoc._id, "targets.phone": t.phone }, { $set: { "targets.$.status": "error" } });
      }
      // throttle based on ratePerHour or environment DELAY_SEC
      const per = jobDoc.mode === "rate" && jobDoc.ratePerHour ? Math.max(1, Math.floor(3600 / jobDoc.ratePerHour)) : Number(process.env.DELAY_SEC || 8);
      const jitter = Math.floor(Math.random() * 5);
      await new Promise((r) => setTimeout(r, (per + jitter) * 1000));
    }

    await AutomationJob.findByIdAndUpdate(jobDoc._id, { status: "completed" });

    // create/create report
    try {
      const total = pending.length;
      const sent = await SendEvent.countDocuments({ automationJobId: jobDoc._id, status: "sent" });
      const failed = await SendEvent.countDocuments({ automationJobId: jobDoc._id, status: "failed" });
      const skipped = total - sent - failed;
      await AutomationReport.create({
        automationJobId: jobDoc._id,
        total,
        sent,
        failed,
        skipped,
        startedAt: new Date(startTs),
        finishedAt: new Date(),
        createdBy: jobDoc.createdBy || null,
      });
    } catch (e) {
      console.warn("Report create failed:", e.message || e);
    }
  } finally {
    await closeDriver(driver);
  }
});

console.log("Automation queue processor started. Listening for jobs...");

