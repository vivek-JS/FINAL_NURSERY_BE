/**
 * Banana G9 default rate is 10; monthly overrides were wrongly 19 for
 * Jan/Sep/Oct/Nov/Dec — Add Order used delivery month → showed ₹19.
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
dotenv.config({ path: ".env" });

const PLANT_ID = "68fdf6d45832d541b274acfa";
const SUBTYPE_ID = "6944c7e75845df7093731ba2";

await mongoose.connect(process.env.PROD_MONGO_URL || process.env.MONGODB_URI);
const PlantCms = (await import("../models/plantCms.model.js")).default;

const before = await PlantCms.findOne(
  { _id: PLANT_ID, "subtypes._id": SUBTYPE_ID },
  { "subtypes.$": 1 }
).lean();
const st = before?.subtypes?.[0];
console.log("BEFORE default", st?.rates);
console.log("BEFORE monthly", JSON.stringify(st?.monthlyRates, null, 2));

const r = await PlantCms.updateOne(
  { _id: PLANT_ID, "subtypes._id": SUBTYPE_ID },
  { $set: { "subtypes.$[st].monthlyRates.$[mr].rate": 10 } },
  {
    arrayFilters: [
      { "st._id": new mongoose.Types.ObjectId(SUBTYPE_ID) },
      { "mr.rate": 19 },
    ],
  }
);
console.log("update result", r);

const after = await PlantCms.findOne(
  { _id: PLANT_ID, "subtypes._id": SUBTYPE_ID },
  { "subtypes.$": 1 }
).lean();
console.log("AFTER default", after?.subtypes?.[0]?.rates);
console.log("AFTER monthly", JSON.stringify(after?.subtypes?.[0]?.monthlyRates, null, 2));

await mongoose.disconnect();
