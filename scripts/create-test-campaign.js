import mongoose from "mongoose";
import dotenv from "dotenv";
dotenv.config();

import Farmer from "../models/farmer.model.js";
import Campaign from "../models/campaign.model.js";

async function main() {
  await mongoose.connect(process.env.MONGO_URL || process.env.MONGO_URI || process.env.MONGO_URL);
  console.log("Connected to DB");

  const farmer = await Farmer.findOne({ mobileNumber: 7588686452 });
  if (!farmer) {
    console.error("Farmer not found for mobile 7588686452");
    process.exit(1);
  }

  const campaign = await Campaign.create({
    name: `TestCampaign_${Date.now()}`,
    description: "Created by script",
    message: "Test campaign message",
    mediaIds: [],
    profileId: null,
    ratePerHour: 100,
    batchSize: 50,
    targets: [{
      farmerId: farmer._id,
      name: farmer.name,
      phone: String(farmer.mobileNumber),
      village: farmer.village || "",
      taluka: farmer.taluka || "",
      district: farmer.district || "",
      stateName: farmer.stateName || "",
      status: "pending",
      attempts: 0
    }],
    recipientsCount: 1,
    duplicatesCount: 0,
    createdBy: null
  });

  console.log("Created campaign:", campaign._id.toString());
  mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });

