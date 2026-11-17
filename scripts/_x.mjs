import fs from "fs";
import mongoose from "mongoose";
import dotenv from "dotenv";
dotenv.config();
for (const f of fs.readdirSync("./models").filter((f) => f.endsWith(".js"))) await import(`../models/${f}`);
const svc = await import("../services/sowDispatchBatches.service.js");
await mongoose.connect(process.env.PROD_MONGO_URL);
const D = "6ad31671de321e553a98aa51";
const o = await svc.listSowBatchOptionsForDispatch(D, 0);
const ord = o.orders[0];
const withFree = o.batches.find((b) => b.freePlants >= ord.remainingOnVehicle) || o.batches[0];
const p = await svc.previewSowBatchLoad({
  dispatchId: D,
  plantRowIndex: 0,
  sowBatchSelections: [{ orderId: ord.orderId, batchId: withFree.batchId, slotId: withFree.slotId, plants: ord.remainingOnVehicle }],
});
console.log(JSON.stringify(p.lines.map((l) => ({ bucket: l.bucket, plants: l.plants, fromFree: l.fromFree, sowingDate: l.sowingDate, summary: l.summary, unlinkedTakes: l.unlinkedTakes, warnings: l.warnings })), null, 1));
await mongoose.disconnect();
