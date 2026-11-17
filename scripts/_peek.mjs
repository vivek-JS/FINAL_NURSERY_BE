import "dotenv/config";
import mongoose from "mongoose";
import DispatchBatch from "../models/dispatchBatch.model.js";
import PlantOutward from "../models/plantOutward.model.js";

await mongoose.connect(process.env.PROD_MONGO_URL, { serverSelectionTimeoutMS: 15000 });
const show = async (bn) => {
  const b = await DispatchBatch.findOne({ batchNumber: bn }).lean();
  console.log("\n=== BATCH", bn, JSON.stringify(b));
  const po = await PlantOutward.find({ batchId: b._id }).lean();
  console.log("PlantOutward docs:", po.length);
  for (const d of po) {
    const { secondaryInward, secondaryOutward, outward, primaryInward, primaryOutward, summary, ...rest } = d;
    console.log("TOP", JSON.stringify(rest));
    console.log("counts outward/pIn/pOut/sIn/sOut", outward?.length, primaryInward?.length, primaryOutward?.length, secondaryInward?.length, secondaryOutward?.length);
    console.log("sIn[0]", JSON.stringify(secondaryInward?.[0]));
    const withHist = (secondaryInward || []).find((x) => x.transferHistory?.length);
    if (withHist) console.log("sIn with history", JSON.stringify(withHist));
    console.log("sOut[0]", JSON.stringify(secondaryOutward?.[0]));
  }
};
await show("SB-D-RAJGAD-19");
await show("SB-179");
await show("RB_1811").catch((e) => console.log("err", e.message));
await mongoose.disconnect();
