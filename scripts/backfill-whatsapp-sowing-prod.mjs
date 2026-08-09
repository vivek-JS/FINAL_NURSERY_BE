/**
 * PROD WhatsApp sow backfill — NO synthetic orders.
 *
 * Logic:
 * - available day = sowDate + subtype.plantReadyDays (from Plant CMS, per variety)
 * - plants → ready-date slot (create sparse Melody day-slot if missing)
 * - mark real orders only where deliveryDate = available day (FIFO full-cover)
 * - leftover plants → slot.excessiveSowing.plants (still available)
 *
 * Usage:
 *   node scripts/backfill-whatsapp-sowing-prod.mjs              # dry-run (default)
 *   node scripts/backfill-whatsapp-sowing-prod.mjs --dry-run
 *   node scripts/backfill-whatsapp-sowing-prod.mjs --apply      # writes prod
 */
import "dotenv/config";
import mongoose from "mongoose";
import {
  applyPlantsToLinkedSlots,
  markOrdersSowed,
  recordExcessPlantsOnSlot,
  pushEvent,
} from "../controllers/sowingCompleteHelpers.js";
import {
  parseLocalDate,
  findSlotByPlantReadyDate,
  fmtDDMMYYYY,
  addDays,
} from "../controllers/sowingSlotReadyHelpers.js";
import SowingRequest from "../models/sowingRequest.model.js";
import PlantCms from "../models/plantCms.model.js";
import Order from "../models/order.model.js";

const APPLY = process.argv.includes("--apply");
const DRY = !APPLY;
const PLANT_ID = "691054dffba6fb380f8d57b3";
const TAG = "whatsapp-backfill-prod";

/** Per-subtype ready days from CMS (never hardcode crop-wide). */
function subtypeReadyDays(subtype) {
  const n = Number(subtype?.plantReadyDays);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

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

function prodUri() {
  const url = process.env.PROD_MONGO_URL;
  if (!url) throw new Error("PROD_MONGO_URL required");
  return url;
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
  return (
    (plant.subtypes || []).find((s) =>
      keys.some((k) => String(s.name || "").toLowerCase() === k)
    ) ||
    (plant.subtypes || []).find((s) =>
      keys.some((k) => String(s.name || "").toLowerCase().includes(k))
    )
  );
}

/**
 * Ensure subtype has the same day-calendar as a full template subtype
 * (e.g. SImbha = 365 day slots). Only adds missing startDay keys; never
 * overwrites existing slots / stock.
 */
async function ensureSubtypeCalendarLikeTemplate(
  db,
  subtype,
  templateSubtypeId
) {
  const plantId = new mongoose.Types.ObjectId(PLANT_ID);
  const subtypeId = subtype._id;
  const readyDays = subtypeReadyDays(subtype);
  const doc = await db.collection("plantslots").findOne({ plantId, year: 2026 });
  if (!doc) throw new Error("prod watermelon 2026 plantslots missing");

  const tmplSt = (doc.subtypeSlots || []).find(
    (s) => String(s.subtypeId) === String(templateSubtypeId)
  );
  if (!tmplSt?.slots?.length) {
    throw new Error("template subtype has no slots to clone from");
  }

  let targetSt = (doc.subtypeSlots || []).find(
    (s) => String(s.subtypeId) === String(subtypeId)
  );
  if (!targetSt) {
    if (!DRY) {
      await db.collection("plantslots").updateOne(
        { _id: doc._id },
        {
          $push: {
            subtypeSlots: {
              subtypeId: new mongoose.Types.ObjectId(subtypeId),
              slots: [],
            },
          },
        }
      );
    }
    targetSt = { subtypeId, slots: [] };
  }

  const have = new Set(
    (targetSt.slots || []).map((s) => String(s.startDay || ""))
  );
  const toAdd = [];
  for (const src of tmplSt.slots) {
    const day = String(src.startDay || "");
    if (!day || have.has(day)) continue;
    toAdd.push({
      _id: new mongoose.Types.ObjectId(),
      startDay: src.startDay,
      endDay: src.endDay || src.startDay,
      month: src.month || "",
      year: src.year || 2026,
      totalPlants: 0,
      totalBookedPlants: 0,
      availablePlants: 0,
      buffer: Number(src.buffer) || 0,
      effectiveBuffer: Number(src.effectiveBuffer) || 0,
      bufferAdjustedCapacity: Number(src.bufferAdjustedCapacity) || 0,
      bufferAmount: Number(src.bufferAmount) || 0,
      originalTotalPlants: 0,
      isOverflow: false,
      orders: [],
      allowedSalesmen: [],
      restrictToSalesmen: false,
      overflow: [],
      status: src.status || "active",
      isManual: true,
      plantReadyDays: readyDays || Number(src.plantReadyDays) || 0,
      plantsSowed: 0,
      primarySowed: 0,
      officeSowed: 0,
      sowingDate: "",
      plantReadyDate: "",
      reminderBeforePlantReadyDays:
        Number(src.reminderBeforePlantReadyDays) || 0,
      sowingBatches: [],
      linkedSowingRequests: [],
      sowingInProgress: [],
      excessiveSowing: { packets: 0, plants: 0 },
    });
    have.add(day);
  }

  if (!toAdd.length) {
    return { added: 0, totalAfter: (targetSt.slots || []).length };
  }

  if (DRY) {
    console.log(
      `DRY calendar sync ${subtype.name}: would add ${toAdd.length} day-slots (have ${(targetSt.slots || []).length}, template ${tmplSt.slots.length})`
    );
    return {
      added: toAdd.length,
      totalAfter: (targetSt.slots || []).length + toAdd.length,
      dryRun: true,
    };
  }

  await db.collection("plantslots").updateOne(
    {
      _id: doc._id,
      "subtypeSlots.subtypeId": new mongoose.Types.ObjectId(subtypeId),
    },
    { $push: { "subtypeSlots.$.slots": { $each: toAdd } } }
  );
  console.log(
    `Calendar sync ${subtype.name}: added ${toAdd.length} day-slots (now ~${(targetSt.slots || []).length + toAdd.length})`
  );
  return {
    added: toAdd.length,
    totalAfter: (targetSt.slots || []).length + toAdd.length,
  };
}

async function previewCover(plantId, subtypeId, plantsNeeded, sowedAt, readyDays) {
  const readyDate = addDays(sowedAt, readyDays);
  const dayStart = new Date(readyDate);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(readyDate);
  dayEnd.setHours(23, 59, 59, 999);

  const orders = await Order.find({
    plantName: plantId,
    plantSubtype: subtypeId,
    sowingDone: { $ne: true },
    deliveryDate: { $gte: dayStart, $lte: dayEnd },
    orderStatus: {
      $nin: ["CANCELLED", "TEMPORARY_CANCELLED", "REJECTED", "DELETED"],
    },
  })
    .select("_id numberOfPlants additionalPlants orderId deliveryDate")
    .sort({ deliveryDate: 1, createdAt: 1, orderId: 1 })
    .lean();

  let rem = plantsNeeded;
  let covered = 0;
  const markIds = [];
  for (const o of orders) {
    const need =
      (Number(o.numberOfPlants) || 0) + (Number(o.additionalPlants) || 0);
    if (need <= 0) continue;
    if (rem < need) break;
    markIds.push(o._id);
    covered += need;
    rem -= need;
  }
  return {
    eligibleOrders: orders.length,
    eligiblePlants: orders.reduce(
      (s, o) =>
        s + (Number(o.numberOfPlants) || 0) + (Number(o.additionalPlants) || 0),
      0
    ),
    wouldMarkOrders: markIds.length,
    orderCovered: covered,
    excessToSlot: rem,
    sampleOrderIds: markIds.slice(0, 5).map(String),
  };
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
  const url = prodUri();
  await mongoose.connect(url);
  console.log(
    "PROD DB",
    mongoose.connection.name,
    DRY ? "DRY-RUN (no writes)" : "APPLY — WRITING"
  );
  if (!DRY) {
    console.log("Waiting 3s… Ctrl+C to abort");
    await new Promise((r) => setTimeout(r, 3000));
  }

  const plant = await PlantCms.findById(PLANT_ID)
    .select("name subtypes sowingAllowed")
    .lean();
  if (!plant?.sowingAllowed) throw new Error("Watermelon not sowingAllowed");

  const admin = await mongoose.connection.collection("users").findOne({
    role: "SUPER_ADMIN",
  });
  if (!admin && !DRY) throw new Error("No SUPER_ADMIN user");

  const simbha = resolveSubtype(plant, "SImbha");
  if (!simbha?._id) throw new Error("SImbha template subtype missing");

  // Sync day-calendars for every variety used (Melody etc. may be sparse)
  const subtypesNeeded = new Map();
  for (const entry of ENTRIES) {
    const st = resolveSubtype(plant, entry.variety);
    if (st) subtypesNeeded.set(String(st._id), st);
  }
  console.log(
    `\nEnsuring day-slot calendars like SImbha for ${subtypesNeeded.size} subtype(s)…`
  );
  for (const st of subtypesNeeded.values()) {
    await ensureSubtypeCalendarLikeTemplate(
      mongoose.connection,
      st,
      simbha._id
    );
  }
  console.log("");

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
    const readyDays = subtypeReadyDays(subtype);
    if (readyDays <= 0) {
      summary.push({
        ...entry,
        subtype: subtype.name,
        ok: false,
        error: "subtype.plantReadyDays missing in CMS",
      });
      continue;
    }
    const readyStr = fmtDDMMYYYY(addDays(sowedAt, readyDays));

    let readySlot = await findSlotByPlantReadyDate(
      PLANT_ID,
      subtype._id,
      readyStr
    );
    // In dry-run, calendar sync has not written yet — ready day will exist after apply
    if (!readySlot?.slotId && DRY) {
      readySlot = {
        slotId: `(pending-sync:${readyStr})`,
        startDay: readyStr,
        endDay: readyStr,
        pendingCalendarSync: true,
      };
    }

    const dup = await alreadyDone(subtype._id, sowedAt, entry.plants);
    const cover = await previewCover(
      plant._id,
      subtype._id,
      entry.plants,
      sowedAt,
      readyDays
    );

    const row = {
      date: entry.date,
      variety: entry.variety,
      subtype: subtype.name,
      plants: entry.plants,
      plantReadyDays: readyDays,
      readyDate: readyStr,
      slotId: readySlot?.slotId ? String(readySlot.slotId) : null,
      pendingCalendarSync: Boolean(readySlot?.pendingCalendarSync),
      ...cover,
      alreadyBackfilled: Boolean(dup),
      requestNumber: dup?.requestNumber || null,
    };

    if (dup) {
      summary.push({ ...row, ok: true, skipped: true });
      console.log("SKIP", entry.date, subtype.name, dup.requestNumber);
      continue;
    }

    if (DRY) {
      summary.push({ ...row, ok: true, dryRun: true });
      console.log(
        "DRY",
        entry.date,
        subtype.name,
        `readyDays=${readyDays}`,
        "→",
        readyStr,
        "plants",
        entry.plants,
        "cover",
        cover.orderCovered,
        "excess",
        cover.excessToSlot,
        "markOrders",
        cover.wouldMarkOrders,
        readySlot?.slotId ? "" : "MISSING SLOT"
      );
      continue;
    }

    if (!readySlot?.slotId) {
      summary.push({ ...row, ok: false, error: "no slot" });
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
      completionNotes: `Prod backfill from WhatsApp · ${entry.date}`,
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
      plantReadyDays: readyDays,
      resolveByReadyDate: true,
      userId: admin._id,
    });

    const orderResult = await markOrdersSowed(request, {
      sowedAt,
      plantsSowed: entry.plants,
      plantReadyDays: readyDays,
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
      message: `WhatsApp prod backfill: ${entry.plants} plants`,
      meta: {
        tag: TAG,
        sowDate: entry.date,
        plantReadyDays: readyDays,
        readyDate: readyStr,
        appliedSlotId: slotResult.appliedSlotId
          ? String(slotResult.appliedSlotId)
          : null,
        orderCoveredPlants,
        excessPlants,
        ordersMarked: orderResult.marked,
        noSynthetic: true,
      },
    });
    pushEvent(request, {
      type: "ORDERS_MARKED_SOWED",
      by: admin._id,
      quantity: orderResult.marked,
      unit: "orders",
      message: `${orderResult.marked} real orders; excess ${excessPlants} on slot`,
      meta: { orderCoveredPlants, excessPlants, readyDate: orderResult.readyDate },
    });
    await request.save();

    summary.push({
      ...row,
      ok: true,
      requestNumber,
      appliedSlotId: slotResult.appliedSlotId
        ? String(slotResult.appliedSlotId)
        : null,
      ordersMarked: orderResult.marked,
      orderCoveredPlants,
      excessPlants,
    });
    console.log(
      "OK",
      entry.date,
      subtype.name,
      requestNumber,
      "orders",
      orderResult.marked,
      "excess",
      excessPlants
    );
  }

  console.log("\n=== SUMMARY ===");
  console.log(JSON.stringify(summary, null, 2));
  if (DRY) {
    console.log(
      "\nDry-run only. To write prod: node scripts/backfill-whatsapp-sowing-prod.mjs --apply"
    );
  }
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
