import Queue from "bull";
import mongoose from "mongoose";
import AutomationJob from "../../models/automationJob.model.js";
import SendEvent from "../../models/sendEvent.model.js";
import Farmer from "../../models/farmer.model.js";
import AutomationReport from "../../models/automationReport.model.js";
import { initDriver, sendToNumber, sendMediaAndMessage, closeDriver } from "../whatsapp-selenium.js";

const REDIS = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const queue = new Queue("automation-targets", REDIS);

const MONGO = process.env.MONGO_URI || "mongodb://localhost:27017/final_nursery";

async function connect() {
  await mongoose.connect(MONGO, { dbName: process.env.DB_NAME || undefined });
}

const MAX_ATTEMPTS = 5;
const BASE_DELAY_SEC = Number(process.env.RETRY_BASE_SEC || 10);

queue.process(2, async (job) => {
  await connect();
  const { jobId, targetIndex } = job.data;
  const jobDoc = await AutomationJob.findById(jobId).lean();
  if (!jobDoc) throw new Error("Job not found: " + jobId);
  const target = jobDoc.targets[targetIndex];
  if (!target) throw new Error("Target not found at index: " + targetIndex);

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
  try {
    // check campaign status if present
    if (jobDoc.campaignId) {
      try {
        const Campaign = (await import("../../models/campaign.model.js")).default;
        const campaign = await Campaign.findById(jobDoc.campaignId).lean();
        if (campaign) {
          if (campaign.status === "paused") {
            // requeue this target after a delay
            await queue.add({ jobId, targetIndex }, { delay: 60 * 1000, attempts: 1 });
            await closeDriver(driver);
            return;
          }
          if (campaign.status === "stopped") {
            // mark target as skipped and record SendEvent
            const freshJob = await AutomationJob.findById(jobId);
            const freshTarget = freshJob.targets[targetIndex];
            freshTarget.status = "skipped";
            await freshJob.save();
            await SendEvent.create({
              automationJobId: jobDoc._id,
              campaignId: jobDoc.campaignId || null,
              farmerId: freshTarget.farmerId || null,
              phone: freshTarget.phone,
              name: freshTarget.name || null,
              message: freshTarget.message || jobDoc.message || "",
              status: "skipped",
            });
            await closeDriver(driver);
            return;
          }
        }
      } catch (e) {
        console.warn("Error checking campaign status:", e.message || e);
      }
    }
    // reload fresh target from DB to get latest attempts
    const freshJob = await AutomationJob.findById(jobId);
    const freshTarget = freshJob.targets[targetIndex];
    if (!freshTarget) throw new Error("Target not found on fresh job");
    if (freshTarget.status === "sent") {
      return Promise.resolve();
    }
    if (freshTarget.attempts >= MAX_ATTEMPTS) {
      // mark failed
      freshTarget.status = "error";
      await freshJob.save();
      await SendEvent.create({
        automationJobId: jobDoc._id,
        campaignId: jobDoc.campaignId || null,
        farmerId: freshTarget.farmerId || null,
        phone: freshTarget.phone,
        name: freshTarget.name || null,
        message: freshTarget.message || jobDoc.message || "",
        status: "failed",
        error: "Max attempts reached",
      });
      return;
    }

    try {
      // prepare media paths
      let mediaFilePaths = [];
      if (jobDoc.mediaIds && jobDoc.mediaIds.length > 0) {
        const CampaignMedia = (await import("../../models/campaignMedia.model.js")).default;
        const mediaDocs = await CampaignMedia.find({ _id: { $in: jobDoc.mediaIds } }).lean();
        mediaFilePaths = mediaDocs.map((m) => m.storagePath).filter(Boolean);
      }

      if (mediaFilePaths.length > 0) {
        await sendMediaAndMessage(driver, freshTarget.phone, freshTarget.message || jobDoc.message || "", mediaFilePaths);
      } else {
        await sendToNumber(driver, freshTarget.phone, freshTarget.message || jobDoc.message || "");
      }

      // success
      freshTarget.status = "sent";
      freshTarget.attempts = (freshTarget.attempts || 0) + 1;
      freshTarget.lastAttemptAt = new Date();
      await freshJob.save();

      const sendEvent = await SendEvent.create({
        automationJobId: jobDoc._id,
        campaignId: jobDoc.campaignId || null,
        farmerId: freshTarget.farmerId || null,
        phone: freshTarget.phone,
        name: freshTarget.name || null,
        message: freshTarget.message || jobDoc.message || "",
        status: "sent",
      });
      if (freshTarget.farmerId) {
        await Farmer.updateOne({ _id: freshTarget.farmerId }, { $push: { whatsappAutomationActivities: {
          automationJobId: jobDoc._id,
          sendEventId: sendEvent._id,
          phone: freshTarget.phone,
          message: freshTarget.message || jobDoc.message || "",
          status: "sent",
          timestamp: new Date()
        } } });
      }
    } catch (err) {
      // update attempts and requeue if attempts < MAX
      freshTarget.attempts = (freshTarget.attempts || 0) + 1;
      freshTarget.lastAttemptAt = new Date();
      freshTarget.lastError = String(err.message || err);
      await freshJob.save();

      if (freshTarget.attempts < MAX_ATTEMPTS) {
        const delayMs = (BASE_DELAY_SEC * Math.pow(2, freshTarget.attempts - 1)) * 1000;
        await queue.add({ jobId, targetIndex }, { delay: delayMs, attempts: 1 });
      } else {
        // mark failed
        freshTarget.status = "error";
        await freshJob.save();
        await SendEvent.create({
          automationJobId: jobDoc._id,
          campaignId: jobDoc.campaignId || null,
          farmerId: freshTarget.farmerId || null,
          phone: freshTarget.phone,
          name: freshTarget.name || null,
          message: freshTarget.message || jobDoc.message || "",
          status: "failed",
          error: freshTarget.lastError,
        });
      }
    }
  } finally {
    await closeDriver(driver);
  }
});

console.log("Automation target processor started. Listening for target jobs...");

