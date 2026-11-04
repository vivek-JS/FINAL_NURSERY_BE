import mongoose from "mongoose";
import AppError from "../utility/appError.js";
import DispatchBatch from "../models/dispatchBatch.model.js";
import PlantCms from "../models/plantCms.model.js";
import PlantOutward from "../models/plantOutward.model.js";
import PrimaryBatchLedger from "../models/primaryBatchLedger.model.js";
import {
  BOTTLES_PER_TRAY,
  applySend,
  applySow,
  plantsNotSent,
  stockBySize,
  traySplit,
} from "../utility/primaryLedgerMath.js";
import { notifyPrimaryShed, notifySecondaryReceive } from "./primaryShedNotice.service.js";

function presentSow(sow) {
  const raw = typeof sow.toObject === "function" ? sow.toObject() : sow;
  const sent = Math.floor(Number(raw.plantsSent) || 0);
  return {
    id: String(raw._id),
    sowDate: raw.sowDate,
    bottlesUsed: raw.bottlesUsed,
    notFullTrays: raw.bottlesUsed % BOTTLES_PER_TRAY !== 0,
    size: raw.size,
    expectedPlants: raw.expectedPlants,
    mortalityExpectedPlants: raw.mortalityExpectedPlants,
    readyDate: raw.readyDate,
    plantsSent: sent,
    plantsNotSent: plantsNotSent(raw.mortalityExpectedPlants, sent),
  };
}

function presentLedger(doc, label = {}) {
  const split = traySplit(doc.bottlesLeft);
  const sows = [...(doc.sows || [])]
    .map(presentSow)
    .sort((a, b) => new Date(b.sowDate) - new Date(a.sowDate));
  return {
    batchId: String(doc.batchId),
    batchNumber: label.batchNumber || "",
    plant: label.plant || "",
    subtype: label.subtype || "",
    primaryPlantReadyDays: label.primaryPlantReadyDays || 0,
    bottlesReceived: doc.bottlesReceived || 0,
    bottlesSown: doc.bottlesSown || 0,
    bottlesLeft: split.bottles,
    completeTrays: split.completeTrays,
    incompleteBottles: split.incompleteBottles,
    expectedPlants: doc.expectedPlants || 0,
    mortalityExpectedPlants: doc.mortalityExpectedPlants || 0,
    plantsSent: doc.plantsSent || 0,
    plantsNotSent: plantsNotSent(doc.mortalityExpectedPlants, doc.plantsSent),
    sizes: stockBySize(doc.receipts, doc.sows),
    sows,
  };
}

async function labelsFor(batchIds) {
  const ids = [...new Set(batchIds.map(String).filter(Boolean))];
  if (!ids.length) return new Map();
  const batches = await DispatchBatch.find({ _id: { $in: ids } })
    .select("batchNumber primaryPlantReadyDays plantCmsId plantSubtypeId")
    .lean();
  const plantIds = [...new Set(batches.map((b) => b.plantCmsId).filter(Boolean).map(String))];
  const plants = plantIds.length
    ? await PlantCms.find({ _id: { $in: plantIds } }).select("name subtypes._id subtypes.name").lean()
    : [];
  const plantById = new Map(plants.map((plant) => [String(plant._id), plant]));
  const map = new Map();
  for (const batch of batches) {
    const plant = plantById.get(String(batch.plantCmsId || ""));
    const subtype = plant?.subtypes?.find((row) => String(row._id) === String(batch.plantSubtypeId));
    map.set(String(batch._id), {
      batchNumber: batch.batchNumber || "",
      plant: plant?.name || "",
      subtype: subtype?.name || "",
      primaryPlantReadyDays: batch.primaryPlantReadyDays || 0,
    });
  }
  return map;
}

async function labelFor(batchId) {
  const map = await labelsFor([batchId]);
  return map.get(String(batchId)) || {};
}

function assertId(value, name) {
  if (!mongoose.isValidObjectId(value)) throw new AppError(`${name} is required`, 400);
}

async function saveLedger(ledger) {
  try {
    await ledger.save();
  } catch (err) {
    if (err?.name === "VersionError") {
      throw new AppError("Stock changed. Refresh and try again.", 409);
    }
    throw err;
  }
}

export async function listPrimaryBoard() {
  const [ledgers, outwards] = await Promise.all([
    PrimaryBatchLedger.find().lean(),
    PlantOutward.find({ "outward.0": { $exists: true } })
      .select(
        "batchId outward._id outward.outwardDate outward.size outward.bottles outward.plants outward.rootingDate outward.primaryReviewStatus outward.transferStatus"
      )
      .lean(),
  ]);

  const received = new Set();
  for (const ledger of ledgers) {
    for (const receipt of ledger.receipts || []) received.add(String(receipt.labOutwardId));
  }

  const toReceive = [];
  const batchIds = ledgers.map((row) => row.batchId);
  for (const doc of outwards) {
    batchIds.push(doc.batchId);
    for (const lab of doc.outward || []) {
      if (lab.primaryReviewStatus === "rejected") continue;
      if (lab.transferStatus && lab.transferStatus !== "available") continue;
      if (received.has(String(lab._id))) continue;
      const bottles = Math.floor(Number(lab.bottles) || 0);
      if (bottles < 1) continue;
      const split = traySplit(bottles);
      toReceive.push({
        batchId: String(doc.batchId),
        labOutwardId: String(lab._id),
        outwardDate: lab.outwardDate,
        rootingDate: lab.rootingDate,
        size: lab.size,
        bottles,
        plants: Math.floor(Number(lab.plants) || 0),
        completeTrays: split.completeTrays,
        incompleteBottles: split.incompleteBottles,
      });
    }
  }

  const labels = await labelsFor(batchIds);
  for (const line of toReceive) Object.assign(line, labels.get(line.batchId) || {});
  toReceive.sort((a, b) => new Date(b.outwardDate || 0) - new Date(a.outwardDate || 0));

  const batches = ledgers
    .map((row) => presentLedger(row, labels.get(String(row.batchId))))
    .sort((a, b) => String(a.batchNumber).localeCompare(String(b.batchNumber)));

  return { toReceive, batches };
}

async function loadOrCreateLedger(batchId) {
  let ledger = await PrimaryBatchLedger.findOne({ batchId });
  if (ledger) return ledger;
  try {
    return await PrimaryBatchLedger.create({ batchId });
  } catch (err) {
    if (err?.code !== 11000) throw err;
    return PrimaryBatchLedger.findOne({ batchId });
  }
}

export async function receiveLabLine({ batchId, labOutwardId }) {
  assertId(batchId, "Batch");
  assertId(labOutwardId, "Lab line");
  const plantOutward = await PlantOutward.findOne({ batchId }).select("outward");
  if (!plantOutward) throw new AppError("No lab outward for this batch", 404);
  const lab = plantOutward.outward.id(labOutwardId);
  if (!lab) throw new AppError("Lab line not found", 404);
  if (lab.primaryReviewStatus === "rejected") throw new AppError("This lab line was rejected", 400);
  if (lab.transferStatus && lab.transferStatus !== "available") {
    throw new AppError("This lab line is already transferred", 400);
  }
  const bottles = Math.floor(Number(lab.bottles) || 0);
  if (bottles < 1) throw new AppError("Lab line has no bottles", 400);

  const ledger = await loadOrCreateLedger(batchId);
  if (ledger.receipts.some((row) => String(row.labOutwardId) === String(lab._id))) {
    throw new AppError("This lab line is already received", 400);
  }
  ledger.receipts.push({
    labOutwardId: lab._id,
    bottles,
    bottlesLeft: bottles,
    plants: Math.max(0, Math.floor(Number(lab.plants) || 0)),
    size: lab.size,
    outwardDate: lab.outwardDate,
    rootingDate: lab.rootingDate,
    receivedAt: new Date(),
  });
  ledger.bottlesReceived += bottles;
  ledger.bottlesLeft += bottles;
  await saveLedger(ledger);
  notifyPrimaryShed("receive").catch(() => {});
  return presentLedger(ledger, await labelFor(batchId));
}

export async function sowBottles({ batchId, bottles, expectedPlants, sowDate, size }) {
  assertId(batchId, "Batch");
  const batch = await DispatchBatch.findById(batchId).select("primaryPlantReadyDays");
  if (!batch) throw new AppError("Batch not found", 404);
  const ledger = await PrimaryBatchLedger.findOne({ batchId });
  if (!ledger) throw new AppError("Not enough bottles on hand", 400);

  const applied = applySow(
    {
      receipts: ledger.receipts.map((row) => (typeof row.toObject === "function" ? row.toObject() : { ...row })),
      bottlesLeft: ledger.bottlesLeft,
      bottlesSown: ledger.bottlesSown,
      expectedPlants: ledger.expectedPlants,
      mortalityExpectedPlants: ledger.mortalityExpectedPlants,
    },
    {
      bottles,
      expectedPlants,
      size,
      sowDate: sowDate || undefined,
      readyDays: batch.primaryPlantReadyDays,
    }
  );
  if (applied.error) throw new AppError(applied.error, 400);

  ledger.receipts = applied.receipts;
  ledger.bottlesLeft = applied.bottlesLeft;
  ledger.bottlesSown = applied.bottlesSown;
  ledger.expectedPlants = applied.expectedPlants;
  ledger.mortalityExpectedPlants = applied.mortalityExpectedPlants;
  ledger.sows.push(applied.sow);
  await saveLedger(ledger);
  notifyPrimaryShed("sow").catch(() => {});
  return presentLedger(ledger, await labelFor(batchId));
}

export async function sendPlants({ batchId, sowId, plants }) {
  assertId(batchId, "Batch");
  assertId(sowId, "Sowing row");
  const count = Math.floor(Number(plants) || 0);
  if (count < 1) throw new AppError("Enter plants to send", 400);

  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const ledger = await PrimaryBatchLedger.findOne({ batchId }).session(session);
    if (!ledger) throw new AppError("Nothing received for this batch", 404);
    const sow = ledger.sows.id(sowId);
    if (!sow) throw new AppError("Sowing row not found", 404);
    const applied = applySend(sow, count);
    if (applied.error) throw new AppError(applied.error, 400);

    let outward = await PlantOutward.findOne({ batchId }).session(session).select("_id");
    if (!outward) {
      const batch = await DispatchBatch.findById(batchId).session(session).select("dateAdded");
      if (!batch) throw new AppError("Batch not found", 404);
      const created = await PlantOutward.create(
        [{ batchId, dateAdded: batch.dateAdded || new Date() }],
        { session }
      );
      outward = created[0];
    }

    const pushed = await PlantOutward.findOneAndUpdate(
      { _id: outward._id },
      {
        $push: {
          primaryOutward: {
            primaryOutwardDate: new Date(),
            numberOfBottles: 0,
            size: sow.size,
            cavity: 1,
            numberOfTrays: 0,
            totalQuantity: count,
            numberOfPlants: count,
            availableQuantity: count,
            pollyhouse: "Primary",
            laboursEngaged: 1,
            transferStatus: "available",
            remarks: "Primary ledger send",
            qualityOfDispatch: "Primary ledger",
            isReceived: false,
            dateOfPlantation: new Date(),
            numberOfDaysTaken: 0,
            ledgerSowId: sow._id,
          },
        },
      },
      { new: true, session, runValidators: true }
    );
    if (!pushed) throw new AppError("Could not send plants", 400);

    sow.plantsSent = applied.plantsSent;
    ledger.plantsSent += count;
    await ledger.save({ session });
    await session.commitTransaction();
    const sentLine = pushed.primaryOutward[pushed.primaryOutward.length - 1];
    const presented = presentLedger(ledger, await labelFor(batchId));
    notifySecondaryReceive({
      batchId,
      batchNumber: presented.batchNumber,
      plant: presented.plant,
      size: sow.size,
      plants: count,
      primaryOutwardId: sentLine?._id,
    }).catch(() => {});
    return presented;
  } catch (err) {
    await session.abortTransaction();
    if (err?.name === "VersionError") {
      throw new AppError("Stock changed. Refresh and try again.", 409);
    }
    throw err;
  } finally {
    session.endSession();
  }
}
