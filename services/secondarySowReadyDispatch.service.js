import mongoose from "mongoose";
import moment from "moment";
import AppError from "../utility/appError.js";
import PlantCms from "../models/plantCms.model.js";
import PlantSlot from "../models/slots.model.js";
import PlantOutward from "../models/plantOutward.model.js";
import DispatchBatch from "../models/dispatchBatch.model.js";
import Dispatch from "../models/dispatch.model.js";
import Order from "../models/order.model.js";
import Tray from "../models/tray.model.js";
import { applyStockFieldUpdates } from "../utility/slotStockTrail.js";
import {
  findDispatchActiveByIdOrTransport,
  resolvePlantRowFromDispatch,
  unionDispatchOrderObjectIds,
  syncDispatchTransportStatusAfterShedChange,
  updateDispatchOrderShedLoaded,
  computeSuggestedFulfillmentSequence,
  DISPATCH_SHED_ALLOWED_STATUSES,
  sumPlantsLoadedOnDispatch,
  normalizeShedLoadInputs,
} from "./secondaryVehicleLoad.service.js";
import {
  finalizeOrderOnShedLineLoaded,
  schedulePostShedLoadAlerts,
} from "./dispatchPostLoadFinalize.service.js";

function parseDdMmYyyy(str) {
  const m = moment(str, ["DD-MM-YYYY", "YYYY-MM-DD"], true);
  return m.isValid() ? m.startOf("day") : null;
}

export async function isPlantSowingAllowed(plantId) {
  if (!plantId || !mongoose.isValidObjectId(String(plantId))) return false;
  const plant = await PlantCms.findById(plantId).select("sowingAllowed name").lean();
  return Boolean(plant?.sowingAllowed);
}

/**
 * Slots with availablePlants > 0 for a sowingAllowed plant/subtype.
 * No ready-date window — anything sellable/dispatchable.
 */
export async function listSowReadyEntries(plantId, subtypeId) {
  if (!plantId || !subtypeId) {
    return { sowingAllowed: false, entries: [], windowDays: null };
  }

  const sowingAllowed = await isPlantSowingAllowed(plantId);
  if (!sowingAllowed) {
    return { sowingAllowed: false, entries: [], windowDays: null };
  }

  const docs = await PlantSlot.find({
    plantId: new mongoose.Types.ObjectId(plantId),
    "subtypeSlots.subtypeId": new mongoose.Types.ObjectId(subtypeId),
  })
    .select("plantId subtypeSlots")
    .lean();

  const entries = [];
  for (const doc of docs || []) {
    const st = (doc.subtypeSlots || []).find(
      (s) => String(s.subtypeId) === String(subtypeId)
    );
    if (!st?.slots?.length) continue;
    for (const slot of st.slots) {
      const avail = Math.max(0, Number(slot.availablePlants) || 0);
      if (avail < 1) continue;
      const readyDate =
        slot.plantReadyDate ||
        (Array.isArray(slot.sowingBatches) && slot.sowingBatches[0]?.plantReadyDate) ||
        "";

      const batches = (slot.sowingBatches || []).slice(0, 10).map((b) => ({
        sowingDate: b.sowingDate || null,
        plantReadyDate: b.plantReadyDate || readyDate,
        plantReadyDays: Number(b.plantReadyDays) || 0,
        plantsSowed: Number(b.plantsSowed) || 0,
        requestNumber: b.requestNumber || null,
        shedName: b.shedName || "",
      }));

      entries.push({
        slotId: String(slot._id),
        startDay: slot.startDay || null,
        endDay: slot.endDay || null,
        plantReadyDate: readyDate,
        plantReadyDays: Number(slot.plantReadyDays) || batches[0]?.plantReadyDays || 0,
        availablePlants: avail,
        primarySowed: Number(slot.primarySowed) || 0,
        sowingBatches: batches,
        shedName: batches[0]?.shedName || "",
      });
    }
  }

  entries.sort((a, b) => {
    const am = parseDdMmYyyy(a.plantReadyDate);
    const bm = parseDdMmYyyy(b.plantReadyDate);
    if (!am && !bm) return 0;
    if (!am) return 1;
    if (!bm) return -1;
    return am.valueOf() - bm.valueOf();
  });

  return {
    sowingAllowed: true,
    windowDays: null,
    windowFrom: null,
    windowTo: null,
    entries,
  };
}

/**
 * All sowingAllowed plant/subtype slots with availablePlants > 0 (sellable),
 * grouped by plantReadyDate (date-wise). No ±N day window.
 */
export async function listAllSowReadyEntriesByDate() {
  const plants = await PlantCms.find({ sowingAllowed: true })
    .select("name subtypes._id subtypes.name")
    .lean();

  if (!plants.length) {
    return {
      sowingAllowed: true,
      windowDays: null,
      windowFrom: null,
      windowTo: null,
      totalAvailable: 0,
      entryCount: 0,
      byDate: [],
      entries: [],
    };
  }

  const meta = new Map();
  const plantIds = [];
  for (const p of plants) {
    plantIds.push(p._id);
    for (const st of p.subtypes || []) {
      meta.set(`${String(p._id)}:${String(st._id)}`, {
        plantId: String(p._id),
        subtypeId: String(st._id),
        plantName: p.name || "Plant",
        subtypeName: st.name || "Subtype",
        label: `${p.name || "Plant"} / ${st.name || "Subtype"}`,
      });
    }
  }

  const docs = await PlantSlot.find({ plantId: { $in: plantIds } })
    .select("plantId subtypeSlots")
    .lean();

  const entries = [];
  for (const doc of docs || []) {
    const plantId = String(doc.plantId);
    for (const st of doc.subtypeSlots || []) {
      const subtypeId = String(st.subtypeId);
      const info = meta.get(`${plantId}:${subtypeId}`);
      if (!info || !st?.slots?.length) continue;

      for (const slot of st.slots) {
        const avail = Math.max(0, Number(slot.availablePlants) || 0);
        if (avail < 1) continue;
        const readyDate =
          slot.plantReadyDate ||
          (Array.isArray(slot.sowingBatches) && slot.sowingBatches[0]?.plantReadyDate) ||
          "";

        const batches = (slot.sowingBatches || []).slice(0, 10).map((b) => ({
          sowingDate: b.sowingDate || null,
          plantReadyDate: b.plantReadyDate || readyDate,
          plantReadyDays: Number(b.plantReadyDays) || 0,
          plantsSowed: Number(b.plantsSowed) || 0,
          requestNumber: b.requestNumber || null,
          shedName: b.shedName || "",
        }));

        entries.push({
          slotId: String(slot._id),
          plantId: info.plantId,
          subtypeId: info.subtypeId,
          plantName: info.plantName,
          subtypeName: info.subtypeName,
          label: info.label,
          startDay: slot.startDay || null,
          endDay: slot.endDay || null,
          plantReadyDate: readyDate,
          plantReadyDays: Number(slot.plantReadyDays) || batches[0]?.plantReadyDays || 0,
          availablePlants: avail,
          primarySowed: Number(slot.primarySowed) || 0,
          sowingBatches: batches,
          shedName: batches[0]?.shedName || "",
        });
      }
    }
  }

  entries.sort((a, b) => {
    const am = parseDdMmYyyy(a.plantReadyDate);
    const bm = parseDdMmYyyy(b.plantReadyDate);
    if (am && bm && am.valueOf() !== bm.valueOf()) return am.valueOf() - bm.valueOf();
    if (!am && bm) return 1;
    if (am && !bm) return -1;
    const labelCmp = String(a.label).localeCompare(String(b.label));
    if (labelCmp) return labelCmp;
    return String(a.startDay || "").localeCompare(String(b.startDay || ""));
  });

  const byDateMap = new Map();
  for (const e of entries) {
    const key = e.plantReadyDate || "—";
    if (!byDateMap.has(key)) {
      byDateMap.set(key, { date: key, total: 0, entries: [] });
    }
    const bucket = byDateMap.get(key);
    bucket.total += e.availablePlants;
    bucket.entries.push(e);
  }

  const byDate = [...byDateMap.values()];
  const totalAvailable = entries.reduce((s, e) => s + e.availablePlants, 0);

  return {
    sowingAllowed: true,
    windowDays: null,
    windowFrom: null,
    windowTo: null,
    totalAvailable,
    entryCount: entries.length,
    byDate,
    entries,
  };
}

export async function listSowReadyEntriesForDispatch(dispatchId, plantRowIndex = 0) {
  const dispatchDoc = await findDispatchActiveByIdOrTransport(dispatchId);
  if (!dispatchDoc) throw new AppError("Vehicle dispatch not found", 404);
  const row = await resolvePlantRowFromDispatch(dispatchDoc, plantRowIndex);
  const result = await listSowReadyEntries(row.plantId, row.subTypeId);
  return {
    ...result,
    plantId: row.plantId,
    subtypeId: row.subTypeId,
    plantRowIndex: Math.max(0, Number(plantRowIndex) || 0),
    plantRowQuantity: Number(row.quantity ?? row.totalPlants ?? 0) || 0,
  };
}

async function loadSlotSubdoc(slotId, session) {
  if (!slotId || !mongoose.isValidObjectId(String(slotId))) return null;
  const plantSlot = await PlantSlot.findOne({
    "subtypeSlots.slots._id": slotId,
  }).session(session || null);
  if (!plantSlot) return null;
  for (const subtype of plantSlot.subtypeSlots || []) {
    const slot = subtype.slots.id(slotId);
    if (slot) return { plantSlot, slot };
  }
  return null;
}

export async function subtractSowReadySlotAvailable({
  session,
  slotId,
  quantity,
  performedBy,
  remark,
}) {
  const qty = Math.max(0, Math.floor(Number(quantity) || 0));
  if (qty < 1) return { subtracted: 0 };
  const loaded = await loadSlotSubdoc(slotId, session);
  if (!loaded) throw new AppError("Sow-ready slot not found", 404);
  const { plantSlot, slot } = loaded;
  const prev = Math.max(0, Number(slot.availablePlants) || 0);
  if (qty > prev) {
    throw new AppError(
      `Not enough available plants on slot (have ${prev}, need ${qty})`,
      400
    );
  }
  const next = prev - qty;
  applyStockFieldUpdates(
    slot,
    { availablePlants: next },
    performedBy,
    remark || `Sow-ready vehicle load (−${qty})`
  );
  if (performedBy && mongoose.isValidObjectId(String(performedBy))) {
    slot.setPerformer?.(performedBy);
  }
  await plantSlot.save({ session: session || undefined, validateBeforeSave: true });
  return { subtracted: qty, availablePlants: next, slotId: String(slotId) };
}

export async function restoreSowReadySlotAvailable({
  session,
  slotId,
  quantity,
  performedBy,
  remark,
}) {
  const qty = Math.max(0, Math.floor(Number(quantity) || 0));
  if (qty < 1 || !slotId) return { restored: 0 };
  const loaded = await loadSlotSubdoc(slotId, session);
  if (!loaded) return { restored: 0, skipped: "slot_not_found" };
  const { plantSlot, slot } = loaded;
  const prev = Math.max(0, Number(slot.availablePlants) || 0);
  const next = prev + qty;
  applyStockFieldUpdates(
    slot,
    { availablePlants: next },
    performedBy,
    remark || `Sow-ready vehicle unload (+${qty})`
  );
  if (performedBy && mongoose.isValidObjectId(String(performedBy))) {
    slot.setPerformer?.(performedBy);
  }
  await plantSlot.save({ session: session || undefined, validateBeforeSave: true });
  return { restored: qty, availablePlants: next, slotId: String(slotId) };
}

/** Find or create a DispatchBatch + PlantOutward holder for sow-ready loads. */
export async function ensureSowReadyPlantOutward(plantId, subtypeId, session) {
  const plant = await PlantCms.findById(plantId).select("name subtypes").lean();
  if (!plant) throw new AppError("Plant not found", 404);
  const st = (plant.subtypes || []).find((s) => String(s._id) === String(subtypeId));
  const readyDays = Math.max(1, Number(st?.plantReadyDays) || 25);
  const batchKey = `SOWREADY-${String(plantId).slice(-6)}-${String(subtypeId).slice(-6)}`;

  let batch = await DispatchBatch.findOne({ batchNumber: batchKey }).session(
    session || null
  );
  if (!batch) {
    const created = await DispatchBatch.create(
      [
        {
          batchNumber: batchKey,
          dateAdded: new Date(),
          primaryPlantReadyDays: readyDays,
          secondaryPlantReadyDays: readyDays,
          plantCmsId: plantId,
          plantSubtypeId: subtypeId,
          isActive: true,
        },
      ],
      { session: session || undefined }
    );
    batch = created[0];
  }

  let po = await PlantOutward.findOne({ batchId: batch._id }).session(session || null);
  if (!po) {
    const created = await PlantOutward.create(
      [
        {
          batchId: batch._id,
          dateAdded: new Date(),
          secondaryInward: [],
          secondaryOutward: [],
          isActive: true,
        },
      ],
      { session: session || undefined }
    );
    po = created[0];
  }
  return { batch, plantOutward: po, plantName: plant.name, subtypeName: st?.name || "" };
}

async function resolveDefaultCavity() {
  const tray = await Tray.findOne({ isActive: { $ne: false } })
    .select("cavity numberPerCrate")
    .sort({ cavity: -1 })
    .lean();
  const cavity = Math.max(1, Math.floor(Number(tray?.cavity) || 104));
  const numberPerCrate = Math.max(1, Math.floor(Number(tray?.numberPerCrate) || 1));
  return { cavity, numberPerCrate };
}

/**
 * FIFO slot picks from a mutable sow-ready pool (oldest ready date first).
 */
export function allocateSowReadyFromPool(poolEntries, plantsWanted) {
  const wanted = Math.max(0, Math.floor(Number(plantsWanted) || 0));
  if (wanted < 1) {
    return { ok: false, error: "Enter plants to load", selections: [] };
  }

  let budget = wanted;
  const selections = [];
  const sorted = [...(poolEntries || [])].sort((a, b) => {
    const da = String(a.plantReadyDate || a.startDay || "");
    const db = String(b.plantReadyDate || b.startDay || "");
    if (da && db && da !== db) return da.localeCompare(db);
    return String(a.slotId).localeCompare(String(b.slotId));
  });

  for (const ent of sorted) {
    if (budget <= 0) break;
    const avail = Math.max(0, Number(ent._remaining ?? ent.availablePlants) || 0);
    if (avail < 1) continue;
    const take = Math.min(budget, avail);
    selections.push({ slotId: String(ent.slotId), plants: take, entry: ent });
    ent._remaining = avail - take;
    budget -= take;
  }

  const allocated = wanted - budget;
  if (allocated < 1) {
    return { ok: false, error: "No sow-ready stock available", selections: [] };
  }
  if (budget > 0) {
    return {
      ok: false,
      error: `Only ${allocated} plants available in sow-ready pool`,
      selections,
      partial: true,
    };
  }
  return { ok: true, selections, allocated };
}

/**
 * Load sow-ready slot plants onto a vehicle (papaya / sowingAllowed).
 * Body: sowReadySelections [{ slotId, plants }] OR shedLoads [{ pollyhouse, plants }].
 */
export async function executeSowReadyVehicleLoad({
  dispatchId,
  plantRowIndex = 0,
  sowReadySelections,
  shedLoads,
  linkedOrderId,
  remarks,
  performedBy,
}) {
  const shedPlan = normalizeShedLoadInputs({ shedLoads });
  const merged = new Map();
  for (const s of Array.isArray(sowReadySelections) ? sowReadySelections : []) {
    const slotId = String(s?.slotId || "").trim();
    const plants = Math.max(0, Math.floor(Number(s?.plants) || 0));
    if (!slotId || plants < 1) continue;
    merged.set(slotId, (merged.get(slotId) || 0) + plants);
  }
  const legacySelections = [...merged.entries()].map(([slotId, plants]) => ({
    slotId,
    plants,
  }));

  if (!shedPlan.length && !legacySelections.length) {
    throw new AppError(
      "shedLoads or sowReadySelections with slotId + plants required",
      400
    );
  }

  const dispatchDoc = await findDispatchActiveByIdOrTransport(dispatchId);
  if (!dispatchDoc) throw new AppError("Vehicle dispatch not found", 404);
  if (!DISPATCH_SHED_ALLOWED_STATUSES.includes(dispatchDoc.transportStatus)) {
    throw new AppError("Vehicle must be PENDING, IN_TRANSIT, or LOADED", 400);
  }

  const dispatchPlantRowIdx = Math.max(0, Number(plantRowIndex) || 0);
  const row = await resolvePlantRowFromDispatch(dispatchDoc, dispatchPlantRowIdx);
  const plantCmsId = row.plantId;
  const plantSubtypeId = row.subTypeId;

  if (!(await isPlantSowingAllowed(plantCmsId))) {
    throw new AppError("Plant is not sowingAllowed — use secondary inward load", 400);
  }

  const { total: alreadyLoaded } = await sumPlantsLoadedOnDispatch(dispatchDoc._id);
  const vehicleNeed = Number(row.quantity ?? row.totalPlants ?? 0) || 0;
  const capPlants = Math.max(0, vehicleNeed - alreadyLoaded);

  const listed = await listSowReadyEntries(plantCmsId, plantSubtypeId);
  const bySlot = new Map(listed.entries.map((e) => [String(e.slotId), e]));

  /** @type {{ pollyhouse: string, slotId: string, plants: number, entry?: object }[]} */
  let loadPlan = [];

  if (shedPlan.length > 0) {
    const pool = listed.entries.map((e) => ({
      ...e,
      _remaining: Number(e.availablePlants) || 0,
    }));
    for (const shed of shedPlan) {
      const fifo = allocateSowReadyFromPool(pool, shed.plants);
      if (!fifo.ok) {
        throw new AppError(
          fifo.error || `Shed ${shed.pollyhouse}: allocation failed`,
          400
        );
      }
      for (const sel of fifo.selections) {
        loadPlan.push({
          pollyhouse: shed.pollyhouse,
          slotId: sel.slotId,
          plants: sel.plants,
          entry: sel.entry,
        });
      }
    }
  } else {
    loadPlan = legacySelections.map((sel) => ({
      pollyhouse: bySlot.get(sel.slotId)?.shedName || "SowReady",
      slotId: sel.slotId,
      plants: sel.plants,
      entry: bySlot.get(sel.slotId),
    }));
  }

  const requested = loadPlan.reduce((s, x) => s + x.plants, 0);
  if (requested > capPlants) {
    throw new AppError(
      `Selection ${requested} exceeds remaining vehicle need ${capPlants}`,
      400
    );
  }

  for (const item of loadPlan) {
    const ent = item.entry || bySlot.get(item.slotId);
    if (!ent) {
      throw new AppError(`Slot ${item.slotId} has no available plants to sell`, 400);
    }
    if (item.plants > ent.availablePlants) {
      throw new AppError(
        `Slot ready ${ent.plantReadyDate}: only ${ent.availablePlants} available`,
        400
      );
    }
  }

  let resolvedOrderId = linkedOrderId;
  if (!resolvedOrderId) {
    const unionIds = unionDispatchOrderObjectIds(dispatchDoc);
    const matching = await Order.find({
      _id: { $in: unionIds },
      plantName: plantCmsId,
      plantSubtype: plantSubtypeId,
      orderStatus: { $in: ["READY_FOR_DISPATCH", "DISPATCH_PROCESS"] },
    })
      .select("_id")
      .sort({ orderId: -1 })
      .limit(1)
      .lean();
    if (matching.length === 1) resolvedOrderId = String(matching[0]._id);
  }

  const { cavity, numberPerCrate } = await resolveDefaultCavity();
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const freshDispatch = await Dispatch.findById(dispatchDoc._id).session(session);
    if (!freshDispatch) throw new AppError("Vehicle dispatch not found", 404);

    const { plantOutward, plantName, subtypeName } = await ensureSowReadyPlantOutward(
      plantCmsId,
      plantSubtypeId,
      session
    );

    let seq = await computeSuggestedFulfillmentSequence(freshDispatch._id);
    const results = [];
    let slotSubtractTotal = 0;
    let totalLoaded = 0;

    for (const item of loadPlan) {
      const ent = item.entry || bySlot.get(item.slotId);
      const plantsMoving = item.plants;
      const fullTrays = Math.floor(plantsMoving / cavity);
      const partialPlants = plantsMoving % cavity;
      const numberOfTrays = Math.max(1, fullTrays + (partialPlants > 0 ? 1 : 0));

      await subtractSowReadySlotAvailable({
        session,
        slotId: item.slotId,
        quantity: plantsMoving,
        performedBy,
        remark: `Sow-ready load · ${plantName}/${subtypeName} · ${item.pollyhouse} · vehicle ${freshDispatch.transportId || ""}`,
      });
      slotSubtractTotal += plantsMoving;

      const secondaryOutwardEntry = {
        secondaryOutwardDate: new Date(),
        numberOfBottles: 1,
        size: "R1",
        cavity,
        numberOfTrays,
        numberOfFullTrays: fullTrays,
        partialTrayPlants: partialPlants,
        totalQuantity: plantsMoving,
        numberOfPlants: plantsMoving,
        availableQuantity: plantsMoving,
        pollyhouse: item.pollyhouse || ent?.shedName || "SowReady",
        laboursEngaged: 1,
        transferStatus: "available",
        stockSource: "SOW_READY",
        sowReadySlotId: new mongoose.Types.ObjectId(item.slotId),
        sowReadyPlantReadyDate: ent?.plantReadyDate || "",
        ...(resolvedOrderId
          ? { linkedOrderId: new mongoose.Types.ObjectId(resolvedOrderId) }
          : {}),
        linkedDispatchId: freshDispatch._id,
        linkedDispatchPlantRowIndex: dispatchPlantRowIdx,
        dispatchFulfillmentSequence: seq,
        dispatchFulfillmentSnapshot: {
          transportId: freshDispatch.transportId,
          driverName: freshDispatch.driverName,
          vehicleName: freshDispatch.vehicleName,
          vehicleNumber: freshDispatch.vehicleNumber,
          stockSource: "SOW_READY",
          sowReadySlotId: item.slotId,
          remarks: remarks || undefined,
        },
      };

      plantOutward.secondaryOutward.push(secondaryOutwardEntry);
      await plantOutward.save({ session });
      const newSo = plantOutward.secondaryOutward[plantOutward.secondaryOutward.length - 1];

      results.push({
        secondaryOutwardId: String(newSo._id),
        slotId: item.slotId,
        pollyhouse: item.pollyhouse,
        plants: plantsMoving,
        plantReadyDate: ent?.plantReadyDate || null,
        stockSource: "SOW_READY",
        numberPerCrate,
      });
      totalLoaded += plantsMoving;
      seq += 1;
    }

    let orderLoaded = null;
    let finalizeResult = null;
    if (resolvedOrderId) {
      orderLoaded = await updateDispatchOrderShedLoaded({
        session,
        dispatchDoc: freshDispatch,
        orderId: resolvedOrderId,
        plantsLoaded: totalLoaded,
      });
      finalizeResult = await finalizeOrderOnShedLineLoaded({
        session,
        orderId: resolvedOrderId,
        dispatchDoc: freshDispatch,
        orderLoaded,
        performedBy,
      });
    }

    const transportStatus = await syncDispatchTransportStatusAfterShedChange({
      session,
      dispatchDoc: freshDispatch,
      plantRowIndex: dispatchPlantRowIdx,
    });

    await session.commitTransaction();

    schedulePostShedLoadAlerts({
      finalizeResult,
      changedBy: performedBy ? String(performedBy) : "Secondary shed",
    });

    return {
      allocations: results,
      totalLoaded,
      slotSubtractTotal,
      orderLoaded,
      transportStatus,
      linkedOrderId: resolvedOrderId || null,
      stockSource: "SOW_READY",
    };
  } catch (err) {
    await session.abortTransaction();
    throw err;
  } finally {
    session.endSession();
  }
}
