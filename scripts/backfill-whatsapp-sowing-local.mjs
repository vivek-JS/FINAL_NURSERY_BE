/**
 * Local-only: backfill WhatsApp sow totals as completed sowing entries
 * (slots + sowingBatches + SOW_COMPLETED slotHistory + FIFO sowingDone).
 *
 * Usage:
 *   node scripts/backfill-whatsapp-sowing-local.mjs
 *   node scripts/backfill-whatsapp-sowing-local.mjs --dry-run
 */
import "dotenv/config";
import mongoose from "mongoose";
import {
  applyPlantsToLinkedSlots,
  markOrdersSowed,
  recordExcessPlantsOnSlot,
  pushEvent,
} from "../controllers/sowingCompleteHelpers.js";
import { parseLocalDate, findSlotByPlantReadyDate, fmtDDMMYYYY, addDays } from "../controllers/sowingSlotReadyHelpers.js";
import SowingRequest from "../models/sowingRequest.model.js";
import PlantCms from "../models/plantCms.model.js";

const DRY = process.argv.includes("--dry-run");
const PLANT_ID = "691054dffba6fb380f8d57b3"; // Watermelon
const READY_DAYS = 18;
const TAG = "whatsapp-backfill-local";

/** Deduped from Pushkraj + Akash office messages (22/7 listed twice → once). */
const ENTRIES = [
  { date: "2026-07-19", variety: "SImbha", plants: 63378 },
  { date: "2026-07-20", variety: "SImbha", plants: 7938 },
  { date: "2026-07-20", variety: "Singham", plants: 24318 },
  { date: "2026-07-21", variety: "Melody", plants: 20412 },
  { date: "2026-07-21", variety: "Impact", plants: 21546 },
  { date: "2026-07-22", variety: "Melody", plants: 20286 },
  { date: "2026-07-22", variety: "Vijay", plants: 20412 },
  { date: "2026-07-24", variety: "Melody", plants: 10080 },
  { date: "2026-07-24", variety: "Vijay", plants: 29106 },
  { date: "2026-07-25", variety: "Impact", plants: 22932 },
  { date: "2026-07-25", variety: "SImbha", plants: 40068 },
];

function localUri() {
  const url =
    process.env.MONGO_URL ||
    process.env.STAGE_MONGO_URL ||
    process.env.MONGODB_URI;
  if (!url) throw new Error("Set MONGO_URL for local");
  if (process.env.NODE_ENV === "production") {
    throw new Error("Refusing to run: NODE_ENV=production");
  }
  return url;
}

async function ensureMelodySubtype(localDb, prodUrl) {
  const plant = await localDb.collection("plantcms").findOne({
    _id: new mongoose.Types.ObjectId(PLANT_ID),
  });
  if (!plant) throw new Error("Watermelon PlantCms missing on local");
  const has = (plant.subtypes || []).some((s) => /melody/i.test(s.name || ""));
  if (has) return;
  if (!prodUrl) throw new Error("PROD_MONGO_URL needed to copy Melody subtype");
  const prod = await mongoose.createConnection(prodUrl).asPromise();
  const prodPlant = await prod.collection("plantcms").findOne(
    { _id: new mongoose.Types.ObjectId(PLANT_ID) },
    { projection: { subtypes: 1 } }
  );
  const melody = (prodPlant?.subtypes || []).find((s) =>
    /melody/i.test(s.name || "")
  );
  await prod.close();
  if (!melody) throw new Error("Melody not found on prod PlantCms");
  await localDb.collection("plantcms").updateOne(
    { _id: plant._id },
    { $push: { subtypes: melody } }
  );
  console.log("Added Melody subtype to local CMS", String(melody._id));
}

function monthName(d) {
  return d.toLocaleString("en-US", { month: "long" });
}

/** Create missing day-slots for a subtype (Melody calendar is sparse). */
async function ensureDaySlot(localDb, subtypeId, readyDateStr, templateSubtypeId) {
  const plantId = new mongoose.Types.ObjectId(PLANT_ID);
  const existing = await findSlotByPlantReadyDate(PLANT_ID, subtypeId, readyDateStr);
  if (existing?.slotId) return existing;

  const doc = await localDb.collection("plantslots").findOne({ plantId, year: 2026 });
  if (!doc) throw new Error("watermelon 2026 plantslots missing");

  const stIdx = (doc.subtypeSlots || []).findIndex(
    (s) => String(s.subtypeId) === String(subtypeId)
  );
  let st = stIdx >= 0 ? doc.subtypeSlots[stIdx] : null;

  // Clone structure from template subtype if Melody subtypeSlots missing/empty
  if (!st) {
    const tmpl = (doc.subtypeSlots || []).find(
      (s) => String(s.subtypeId) === String(templateSubtypeId)
    );
    st = {
      subtypeId: new mongoose.Types.ObjectId(subtypeId),
      slots: [],
    };
    if (tmpl) {
      // keep empty; we'll push one day
    }
    await localDb.collection("plantslots").updateOne(
      { _id: doc._id },
      { $push: { subtypeSlots: st } }
    );
  }

  const [dd, mm, yyyy] = readyDateStr.split("-").map(Number);
  const readyDate = new Date(yyyy, mm - 1, dd, 12, 0, 0, 0);
  const tmplSlot =
    (st.slots || []).find((s) => s.startDay && s.endDay) ||
    (
      (doc.subtypeSlots || []).find(
        (s) => String(s.subtypeId) === String(templateSubtypeId)
      )?.slots || []
    ).find((s) => s.startDay);

  const newSlot = {
    _id: new mongoose.Types.ObjectId(),
    startDay: readyDateStr,
    endDay: readyDateStr,
    month: monthName(readyDate),
    year: yyyy,
    totalPlants: 0,
    totalBookedPlants: 0,
    availablePlants: 0,
    buffer: 0,
    plantReadyDays: READY_DAYS,
    plantsSowed: 0,
    primarySowed: 0,
    officeSowed: 0,
    sowingBatches: [],
    linkedSowingRequests: [],
    sowingInProgress: [],
    status: "active",
    isManual: true,
    ...(tmplSlot
      ? {
          buffer: tmplSlot.buffer || 0,
          plantReadyDays: tmplSlot.plantReadyDays || READY_DAYS,
        }
      : {}),
  };

  await localDb.collection("plantslots").updateOne(
    { _id: doc._id, "subtypeSlots.subtypeId": new mongoose.Types.ObjectId(subtypeId) },
    { $push: { "subtypeSlots.$.slots": newSlot } }
  );
  console.log("Created day slot", readyDateStr, "subtype", String(subtypeId));
  return {
    slotId: newSlot._id,
    startDay: readyDateStr,
    endDay: readyDateStr,
    plantReadyDate: readyDateStr,
  };
}

async function ensureWatermelonSlots2026(localDb, prodUrl) {
  const plantId = new mongoose.Types.ObjectId(PLANT_ID);
  const existing = await localDb.collection("plantslots").findOne({
    plantId,
    year: 2026,
  });
  if (existing) {
    console.log("Local watermelon 2026 slots already present");
    return;
  }
  if (!prodUrl) throw new Error("PROD_MONGO_URL needed to copy plantslots");
  const prod = await mongoose.createConnection(prodUrl).asPromise();
  const docs = await prod
    .collection("plantslots")
    .find({ plantId, year: 2026 })
    .toArray();
  await prod.close();
  if (!docs.length) throw new Error("No prod watermelon 2026 plantslots");
  // Reset sow counters so backfill starts clean on local copy
  for (const doc of docs) {
    for (const st of doc.subtypeSlots || []) {
      for (const slot of st.slots || []) {
        slot.primarySowed = 0;
        slot.officeSowed = 0;
        slot.plantsSowed = 0;
        slot.availablePlants = Number(slot.availablePlants) || 0;
        slot.sowingBatches = [];
        slot.linkedSowingRequests = [];
        slot.sowingInProgress = [];
      }
    }
    delete doc.__v;
  }
  await localDb.collection("plantslots").insertMany(docs);
  console.log(`Copied ${docs.length} watermelon 2026 plantslot doc(s) to local`);
}

function resolveSubtype(plant, variety) {
  const want = String(variety).toLowerCase();
  const aliases = {
    simbha: ["simbha", "simba"],
    singham: ["singham"],
    melody: ["melody"],
    impact: ["impact", "impcat", "ipmcet"],
    vijay: ["vijay"],
  };
  const keys = aliases[want] || [want];
  const st = (plant.subtypes || []).find((s) =>
    keys.some((k) => String(s.name || "").toLowerCase() === k)
  );
  if (!st) {
    // fuzzy contains
    return (plant.subtypes || []).find((s) =>
      keys.some((k) => String(s.name || "").toLowerCase().includes(k))
    );
  }
  return st;
}

async function alreadyDone(subtypeId, sowedAt, plants) {
  const dayStart = new Date(sowedAt);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(sowedAt);
  dayEnd.setHours(23, 59, 59, 999);
  return SowingRequest.findOne({
    subtypeId,
    sowingCompleted: true,
    sowedQuantity: plants,
    sowingCompletedDate: { $gte: dayStart, $lte: dayEnd },
    notes: new RegExp(TAG, "i"),
  })
    .select("requestNumber")
    .lean();
}

async function main() {
  const url = localUri();
  await mongoose.connect(url);
  console.log("DB", mongoose.connection.name, DRY ? "(dry-run)" : "(apply)");

  const prodUrl = process.env.PROD_MONGO_URL;
  await ensureMelodySubtype(mongoose.connection, prodUrl);
  await ensureWatermelonSlots2026(mongoose.connection, prodUrl);

  const plant = await PlantCms.findById(PLANT_ID)
    .select("name subtypes sowingAllowed")
    .lean();
  if (!plant?.sowingAllowed) throw new Error("Watermelon not sowingAllowed");

  const admin =
    (await mongoose.connection.collection("users").findOne({
      role: "SUPER_ADMIN",
    })) || (await mongoose.connection.collection("users").findOne({}));
  if (!admin) throw new Error("No user for completedBy");

  const summary = [];

  for (const entry of ENTRIES) {
    const subtype = resolveSubtype(plant, entry.variety);
    if (!subtype) {
      summary.push({ ...entry, ok: false, error: "subtype not found" });
      continue;
    }
    const sowedAt = parseLocalDate(entry.date);
    if (!sowedAt) {
      summary.push({ ...entry, ok: false, error: "bad date" });
      continue;
    }
    const readyStr = fmtDDMMYYYY(addDays(sowedAt, READY_DAYS));
    const simbha = resolveSubtype(plant, "SImbha");
    let readySlot = await findSlotByPlantReadyDate(
      PLANT_ID,
      subtype._id,
      readyStr
    );
    if (!readySlot?.slotId) {
      readySlot = await ensureDaySlot(
        mongoose.connection,
        subtype._id,
        readyStr,
        simbha?._id
      );
    }
    if (!readySlot?.slotId) {
      summary.push({
        ...entry,
        subtype: subtype.name,
        ok: false,
        error: `no ready slot for ${readyStr}`,
      });
      continue;
    }

    const dup = await alreadyDone(subtype._id, sowedAt, entry.plants);
    if (dup) {
      summary.push({
        ...entry,
        subtype: subtype.name,
        ok: true,
        skipped: true,
        requestNumber: dup.requestNumber,
      });
      continue;
    }

    if (DRY) {
      summary.push({
        ...entry,
        subtype: subtype.name,
        ok: true,
        dryRun: true,
        readyDate: readyStr,
        slotId: String(readySlot.slotId),
      });
      continue;
    }

    const requestNumber = await SowingRequest.generateRequestNumber();
    const request = new SowingRequest({
      requestNumber,
      plantId: new mongoose.Types.ObjectId(PLANT_ID),
      plantName: plant.name,
      subtypeId: subtype._id,
      subtypeName: subtype.name,
      packetsNeeded: 0,
      packetsRequested: 0,
      excessPackets: 0,
      conversionFactor: 1,
      unitName: "packets",
      status: "issued",
      requestedBy: admin._id,
      issuedBy: admin._id,
      issuedDate: sowedAt,
      notes: `${TAG} · ${entry.date} · ${subtype.name} · ${entry.plants}`,
      linkedSlotIds: [readySlot.slotId],
      linkedOrderIds: [],
      isExcessiveSowing: false,
      seedSource: "COMPANY",
      packetsFromCompany: 0,
      packetsFromRaising: 0,
      packetsIssued: 0,
      packetsUsed: 0,
      packetsReturned: 0,
      sowedQuantity: entry.plants,
      laboursLadies: 0,
      laboursGents: 0,
      shedName: "Office WhatsApp",
      completionNotes: `Backfill from WhatsApp sow sheet · ${entry.date}`,
      completedBy: admin._id,
      sowingCompleted: true,
      sowingCompletedDate: sowedAt,
      sowingInProgress: false,
      remainingSowingNeeded: 0,
      completionEvents: [],
    });

    const slotResult = await applyPlantsToLinkedSlots(request, entry.plants, {
      packetsUsed: 0,
      requestNumber,
      linkedOrderIds: [],
      isExcessiveSowing: false,
      shedName: "Office WhatsApp",
      sowedAt,
      plantReadyDays: READY_DAYS,
      resolveByReadyDate: true,
      userId: admin._id,
    });

    // Real orders only (delivery = sow+readyDays). Leftover → slot excess.
    const orderResult = await markOrdersSowed(request, {
      sowedAt,
      plantsSowed: entry.plants,
      plantReadyDays: READY_DAYS,
    });
    const excessPlants = Math.max(
      0,
      Number(orderResult.remainingUncovered) || 0
    );
    const orderCoveredPlants = Math.max(0, entry.plants - excessPlants);
    if (slotResult.appliedSlotId) {
      await recordExcessPlantsOnSlot(
        slotResult.appliedSlotId,
        request._id,
        excessPlants,
        orderCoveredPlants
      );
    }

    pushEvent(request, {
      type: "SOW_COMPLETED",
      by: admin._id,
      quantity: entry.plants,
      unit: "plants",
      message: `WhatsApp backfill: ${entry.plants} plants`,
      meta: {
        tag: TAG,
        sowDate: entry.date,
        plantReadyDays: READY_DAYS,
        readyDate: readyStr,
        appliedSlotId: slotResult.appliedSlotId
          ? String(slotResult.appliedSlotId)
          : null,
        orderCoveredPlants,
        excessPlants,
        ordersMarked: orderResult.marked,
      },
    });
    pushEvent(request, {
      type: "ORDERS_MARKED_SOWED",
      by: admin._id,
      quantity: orderResult.marked,
      unit: "orders",
      message: `${orderResult.marked} real orders; excess ${excessPlants} on slot`,
      meta: { orderCoveredPlants, excessPlants },
    });
    await request.save();

    summary.push({
      ...entry,
      subtype: subtype.name,
      ok: true,
      requestNumber,
      appliedSlotId: slotResult.appliedSlotId
        ? String(slotResult.appliedSlotId)
        : null,
      readyDate: slotResult.plantReadyDate,
      ordersMarked: orderResult.marked,
      orderCoveredPlants,
      excessPlants,
    });
    console.log(
      "OK",
      entry.date,
      subtype.name,
      entry.plants,
      requestNumber,
      "orders",
      orderResult.marked,
      "excess",
      excessPlants
    );
  }

  console.log("\n=== SUMMARY ===");
  console.log(JSON.stringify(summary, null, 2));
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
