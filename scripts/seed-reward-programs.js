/**
 * Seed sample reward programs for dealers and sales.
 * Run: node scripts/seed-reward-programs.js
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
import RewardProgram from "../models/rewardProgram.model.js";

dotenv.config();

const samples = [
  {
    name: "Dealer Growth Quest",
    audienceLabel: "Dealers",
    targetRoles: ["DEALER"],
    theme: "joy",
    unit: "orders",
    progressMetric: "order_count",
    isActive: true,
    milestones: [
      { title: "First Steps", description: "Complete your first 10 orders", target: 10, reward: "₹500 bonus", imageKey: "medal" },
      { title: "Rising Star", description: "Reach 50 orders", target: 50, reward: "Priority slot booking", imageKey: "star" },
      { title: "Champion", description: "Hit 100 orders", target: 100, reward: "Annual dealer gift", imageKey: "trophy" },
    ],
  },
  {
    name: "Sales Sprint",
    audienceLabel: "Sales team",
    targetRoles: ["SALES"],
    theme: "cool",
    unit: "plants",
    progressMetric: "plants_sold",
    isActive: true,
    milestones: [
      { title: "Closer", description: "Sell 5,000 plants", target: 5000, reward: "₹1,000 bonus", imageKey: "star" },
      { title: "Top Performer", description: "Sell 15,000 plants", target: 15000, reward: "Weekend trip voucher", imageKey: "trophy" },
      { title: "Legend", description: "Sell 30,000 plants", target: 30000, reward: "Promotion fast-track", imageKey: "rocket" },
    ],
  },
  {
    name: "Ram Agri Stars",
    audienceLabel: "Ram Agri sales",
    targetRoles: ["RAM_AGRI_SALES"],
    theme: "sunrise",
    unit: "orders",
    progressMetric: "order_count",
    isActive: true,
    milestones: [
      { title: "Bronze", description: "25 agri orders", target: 25, reward: "Early product access", imageKey: "medal" },
      { title: "Silver", description: "75 agri orders", target: 75, reward: "₹2,000 incentive", imageKey: "star" },
      { title: "Gold", description: "150 agri orders", target: 150, reward: "Quarterly award", imageKey: "rocket" },
    ],
  },
];

async function main() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    console.error("Set MONGODB_URI or MONGO_URI");
    process.exit(1);
  }
  await mongoose.connect(uri);
  for (const doc of samples) {
    const exists = await RewardProgram.findOne({ name: doc.name });
    if (exists) {
      console.log(`Skip (exists): ${doc.name}`);
      continue;
    }
    await RewardProgram.create(doc);
    console.log(`Created: ${doc.name}`);
  }
  await mongoose.disconnect();
  console.log("Done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
