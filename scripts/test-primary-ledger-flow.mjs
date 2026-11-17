/**
 * Creates one throwaway batch, walks lab outward → receive → sow → send,
 * checks Secondary can see that send, then deletes the rows.
 * Does not send WhatsApp. Does not print phone numbers.
 */
import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();
process.env.NODE_ENV = "production";
process.env.PRIMARY_SHED_NOTICE = "false";
process.env.WHATSAPP_ALERTS_ENABLED = "false";

const { default: DispatchBatch } = await import("../models/dispatchBatch.model.js");
const { default: PlantOutward } = await import("../models/plantOutward.model.js");
const { default: PrimaryBatchLedger } = await import("../models/primaryBatchLedger.model.js");
const { default: User } = await import("../models/user.model.js");
const { receiveLabLine, sowBottles, sendPlants } = await import("../services/primaryBatchLedger.service.js");
const {
  formatPrimaryShedNotice,
  isPrimaryStaff,
  isSecondaryStaff,
  secondaryCanReceive,
} = await import("../utility/primaryShedNotice.js");

function mongoUrl() {
  return process.env.PROD_MONGO_URL || process.env.MONGO_URL || process.env.MONGODB_URI || "";
}

const batchNumber = `PTEST-${Date.now()}`;
let batchId = null;

try {
  const url = mongoUrl();
  if (!url) throw new Error("Missing Mongo URL");
  await mongoose.connect(url, { serverSelectionTimeoutMS: 10000 });

  const batch = await DispatchBatch.create({
    batchNumber,
    dateAdded: new Date("2026-11-04"),
    primaryPlantReadyDays: 21,
    secondaryPlantReadyDays: 40,
  });
  batchId = batch._id;

  const outward = await PlantOutward.create({ batchId, dateAdded: batch.dateAdded });
  outward.outward.push({
    outwardDate: new Date("2026-11-04"),
    size: "R1",
    bottles: 40,
    plants: 400,
    rootingDate: new Date("2026-10-20"),
    primaryReviewStatus: "pending",
  });
  await outward.save();
  const labId = outward.outward[outward.outward.length - 1]._id;

  const received = await receiveLabLine({ batchId, labOutwardId: labId });
  if (received.bottlesLeft !== 40) throw new Error(`receive bottles ${received.bottlesLeft}`);

  let refused = false;
  try {
    await sowBottles({ batchId, bottles: 5, expectedPlants: 10, size: "R2" });
  } catch (err) {
    refused = /R2/.test(err.message);
  }
  if (!refused) throw new Error("R2 sow should have been refused");

  const sown = await sowBottles({
    batchId,
    bottles: 10,
    expectedPlants: 10000,
    sowDate: "2026-11-10",
  });
  if (sown.sows[0].size !== "R1") throw new Error(`default size ${sown.sows[0].size}`);
  if (sown.bottlesLeft !== 30) throw new Error(`bottles left ${sown.bottlesLeft}`);
  if (sown.sows[0].mortalityExpectedPlants !== 9000) throw new Error("mortality");
  if (new Date(sown.sows[0].readyDate).toISOString().slice(0, 10) !== "2026-12-01") {
    throw new Error(`ready date ${sown.sows[0].readyDate}`);
  }

  const sent = await sendPlants({ batchId, sowId: sown.sows[0].id, plants: 4000 });
  if (sent.plantsNotSent !== 5000) throw new Error(`not sent ${sent.plantsNotSent}`);
  if (sent.bottlesLeft !== 30) throw new Error("send changed bottles");

  const saved = await PlantOutward.findOne({ batchId }).lean();
  const line = saved.primaryOutward[saved.primaryOutward.length - 1];
  if (!secondaryCanReceive(line)) throw new Error("secondary cannot receive the send");
  if (line.secondaryAcknowledgedAt) throw new Error("send was already acknowledged");
  if (line.size !== "R1" || line.numberOfPlants !== 4000) throw new Error("send line mismatch");
  if ((saved.primaryInward || []).length !== 0) throw new Error("send wrote primaryInward");

  const notice = formatPrimaryShedNotice({
    toReceive: [],
    batches: [sent],
  });
  if (!notice.includes("Ready date") || !notice.includes("30 bottles not sown") || !notice.includes("5000")) {
    throw new Error("combined notice missing a section");
  }
  if (notice.includes("Lab outward\n•")) throw new Error("received line still looks incoming");

  const people = await User.find({ isDisabled: { $ne: true } }).select("jobTitle role").lean();
  const primaryIds = new Set(people.filter(isPrimaryStaff).map((user) => String(user._id)));
  const secondaryIds = people.filter(isSecondaryStaff).map((user) => String(user._id));
  if (secondaryIds.some((id) => primaryIds.has(id))) throw new Error("a secondary user is in the primary audience");
  const primaryJobs = people.filter(isPrimaryStaff).map((user) => user.jobTitle);
  if (primaryJobs.some((job) => job !== "PRIMARY")) throw new Error(`primary audience has ${primaryJobs.join(",")}`);

  console.log(
    `ok ${batchNumber} receive 40 → sow R1 10 → send 4000; secondary can receive; primary audience ${primaryIds.size}; secondary audience ${secondaryIds.length}`
  );
} finally {
  if (batchId) {
    await PlantOutward.deleteOne({ batchId });
    await PrimaryBatchLedger.deleteOne({ batchId });
    await DispatchBatch.deleteOne({ _id: batchId });
  }
  await mongoose.disconnect();
}
