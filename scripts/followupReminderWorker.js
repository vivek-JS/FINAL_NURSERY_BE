#!/usr/bin/env node
/**
 * Simple reminder worker for FollowUps.
 * Run periodically (cron) to notify employees about upcoming follow-ups.
 *
 * Usage:
 *   node scripts/followupReminderWorker.js
 *
 * Cron example (run every 15 minutes):
 *   */15 * * * * cd /path/to/FINAL_NURSERY_BE && /usr/bin/node scripts/followupReminderWorker.js >> /var/log/followup-reminder.log 2>&1
 */
import mongoose from "mongoose";
import FollowUp from "../models/followUp.model.js";
import User from "../models/user.model.js";
import { sendCustomNotification } from "../utility/pushNotification.js";
import dotenv from "dotenv";
dotenv.config();

const MONGO = process.env.MONGO_URI || process.env.DATABASE_URL || "mongodb://localhost:27017/nursery";

async function main() {
  await mongoose.connect(MONGO, { useNewUrlParser: true, useUnifiedTopology: true });
  console.log("[followupReminderWorker] connected to DB");

  const now = new Date();
  const windowMs = 60 * 60 * 1000; // 1 hour ahead
  const upper = new Date(now.getTime() + windowMs);

  const due = await FollowUp.find({
    status: "pending",
    reminderSent: { $ne: true },
    scheduledAt: { $lte: upper, $gte: now },
  }).limit(200).lean();

  console.log(`[followupReminderWorker] found ${due.length} follow-ups to remind`);

  for (const fu of due) {
    try {
      if (!fu.assignedBy) continue;
      const user = await User.findById(fu.assignedBy).lean();
      if (!user || !user.expoPushToken) {
        // fallback: could send SMS via Exotel (not implemented)
        console.log(`No push token for user ${fu.assignedBy}, skipping`);
        continue;
      }

      const title = "Upcoming follow-up";
      const message = `You have a follow-up scheduled at ${new Date(fu.scheduledAt).toLocaleString()} for ${fu.phone}`;
      await sendCustomNotification(user.expoPushToken, title, message, { followUpId: fu._id });

      await FollowUp.updateOne({ _id: fu._id }, { $set: { reminderSent: true } });
      console.log(`Notified ${user.name} (${user._id}) for follow-up ${fu._id}`);
    } catch (err) {
      console.error("Reminder error for follow-up", fu._id, err);
    }
  }

  await mongoose.disconnect();
  console.log("[followupReminderWorker] done");
}

main().catch((err) => {
  console.error("Worker failed:", err);
  process.exit(1);
});

