import mongoose from "mongoose";
import moment from "moment";
import AppError from "../utility/appError.js";
import PlantOutward from "../models/plantOutward.model.js";
import DispatchBatch from "../models/dispatchBatch.model.js";
import Dispatch from "../models/dispatch.model.js";
import Order from "../models/order.model.js";
import Tray from "../models/tray.model.js";
import {
  safeMongooseNumber,
  safeNonNegativeInt,
} from "../utility/safeMongooseNumber.js";
import {
  syncSecondaryInwardSlotStockAdd,
  subtractSecondaryInwardSlotStock,
} from "./secondaryShedSlotStock.service.js";
import { recordSecondaryOutwardOnLedger } from "./secondaryDispatchAvailability.service.js";
import {
  recordShedActivity,
  SHED_ACTIVITY_ACTIONS,
} from "./shedActivity.service.js";
import { updateOrderWithLedgerSync } from "../controllers/dispatch.controller.js";
import { allocateNextInvoiceNumbers } from "./invoiceSequence.service.js";
import { ensureOfficialDeliveryChallanForOrder } from "./officialDeliveryChallan.service.js";

const BATCH_SELECT_FIELDS =
  "batchNumber dateAdded primaryPlantReadyDays secondaryPlantReadyDays isActive plantCmsId plantSubtypeId";

export function pollyhouseMatchesFilter(linePollyhouse, filterPollyhouse) {
  const ph = String(linePollyhouse || "").trim().toLowerCase();
  const f = String(filterPollyhouse || "").trim().toLowerCase();
  if (!ph || !f) return false;
  return ph === f || ph.includes(f) || f.includes(ph);
}

/** Scale bottles when moving fewer trays than the source inward row. */
function bottlesForVehicleLoadMove(line, loadedTrayCount, plantsMoving) {
  const cavity = Math.max(1, Math.floor(Number(line.cavity) || 126));
  const inwardTrays = Math.max(1, safeNonNegativeInt(line.numberOfTrays, 1));
  const inwardBottles = Math.max(1, safeNonNegativeInt(line.numberOfBottles, 1));
  const trays = Math.max(1, safeNonNegativeInt(loadedTrayCount, 1));
  const proportionalBottles =
    trays >= inwardTrays
      ? inwardBottles
      : Math.max(1, Math.ceil((trays / inwardTrays) * inwardBottles));
  return Math.max(proportionalBottles, Math.max(1, Math.floor(Number(plantsMoving) || 0)));
}

/** FIFO allocate plants across sorted suggestion lines (full trays + optional partial last tray). */
export function allocateSecondaryFifoPlants(suggestions, totalPlantsWanted) {
  const wanted = Math.max(0, Math.floor(Number(totalPlantsWanted) || 0));
  if (wanted < 1) {
    return { ok: false, error: "plants must be at least 1", allocations: [] };
  }

  let budget = wanted;
  const allocations = [];

  for (const line of suggestions || []) {
    if (budget <= 0) break;
    const cav = Math.max(1, Math.floor(Number(line.cavity) || 126));
    const avail = Math.max(
      0,
      Number(line.remainingPlants ?? line.availableQuantity) || 0
    );
    if (avail < 1) continue;

    const takeCap = Math.min(budget, avail);
    const maxFullTraysOnLine = Math.floor(avail / cav);
    const fullTrays = Math.min(maxFullTraysOnLine, Math.floor(takeCap / cav));
    const plantsFromFull = fullTrays * cav;
    let partialTrayPlants = 0;

    const stillNeed = takeCap - plantsFromFull;
    const stillAvailOnLine = avail - plantsFromFull;
    if (stillNeed > 0 && stillNeed < cav && stillNeed <= stillAvailOnLine) {
      partialTrayPlants = stillNeed;
    }

    const plants = plantsFromFull + partialTrayPlants;
    if (plants < 1) continue;

    const numberOfFullTrays = fullTrays;
    const numberOfTrays = fullTrays + (partialTrayPlants > 0 ? 1 : 0);

    allocations.push({
      batchId: String(line.batchId),
      secondaryInwardId: String(line.secondaryInwardId),
      batchNumber: line.batchNumber,
      cavity: cav,
      size: line.size || "R1",
      numberOfFullTrays,
      partialTrayPlants,
      numberOfTrays,
      plants,
      pollyhouse: line.pollyhouse,
      numberOfBottles: bottlesForVehicleLoadMove(line, numberOfTrays, plants),
    });
    budget -= plants;
  }

  const totalAllocated = wanted - budget;
  if (totalAllocated < 1) {
    return {
      ok: false,
      error: "No eligible FIFO stock for requested quantity",
      allocations: [],
    };
  }
  if (budget > 0) {
    return {
      ok: false,
      error: `Only ${totalAllocated} plants available in shed (FIFO)`,
      allocations,
      partial: true,
      totalAllocated,
      requested: wanted,
    };
  }

  return { ok: true, allocations, totalAllocated };
}

const SIZE_KEYS = ["R1", "R2", "R3"];

const parseSizeSplit = (raw) => {
  if (!raw || typeof raw !== "object") return null;
  const split = { R1: 0, R2: 0, R3: 0 };
  let any = false;
  for (const sz of SIZE_KEYS) {
    const n = Math.max(0, Math.floor(Number(raw[sz]) || 0));
    split[sz] = n;
    if (n > 0) any = true;
  }
  return any ? split : null;
};

/** Parse API body into per-shed inputs (optional R1/R2/R3 split). */
export function normalizeShedLoadInputs(body = {}) {
  if (Array.isArray(body.shedLoads) && body.shedLoads.length > 0) {
    return body.shedLoads
      .map((row) => {
        const pollyhouse = String(row?.pollyhouse || "").trim();
        if (!pollyhouse) return null;
        const sizeSplit = parseSizeSplit(row?.sizeSplit);
        if (sizeSplit) return { pollyhouse, sizeSplit };
        const plants = Math.max(0, Math.floor(Number(row?.plants) || 0));
        if (plants > 0) return { pollyhouse, plants };
        return null;
      })
      .filter(Boolean);
  }
  const ph = String(body.pollyhouse || "").trim();
  const plants = Math.max(0, Math.floor(Number(body.plants) || 0));
  if (ph && plants > 0) return [{ pollyhouse: ph, plants }];
  return [];
}

/** Expand shed inputs to FIFO rows (per size when sizeSplit provided). */
export function expandShedLoadsToFifoRows(shedInputs) {
  const rows = [];
  for (const input of shedInputs || []) {
    const pollyhouse = String(input?.pollyhouse || "").trim();
    if (!pollyhouse) continue;
    const sizeSplit = parseSizeSplit(input?.sizeSplit);
    if (sizeSplit) {
      for (const sz of SIZE_KEYS) {
        if (sizeSplit[sz] > 0) {
          rows.push({ pollyhouse, size: sz, plants: sizeSplit[sz] });
        }
      }
      continue;
    }
    const plants = Math.max(0, Math.floor(Number(input?.plants) || 0));
    if (plants > 0) rows.push({ pollyhouse, plants });
  }
  return rows;
}

/** @deprecated use normalizeShedLoadInputs + expandShedLoadsToFifoRows */
export function normalizeShedLoads(body = {}) {
  return expandShedLoadsToFifoRows(normalizeShedLoadInputs(body));
}

/** FIFO allocate per shed (+ size when given), merge allocations. */
export function allocateMultiShedFifoLoads(suggestions, shedInputs) {
  const inputs = (shedInputs || []).filter((row) => row?.pollyhouse);
  const fifoRows = expandShedLoadsToFifoRows(inputs);
  if (!fifoRows.length) {
    return {
      ok: false,
      error: "At least one shed with plants is required",
      allocations: [],
      byShed: [],
      totalAllocated: 0,
      requested: 0,
    };
  }

  const allocations = [];
  const byShed = [];
  const errors = [];
  let totalAllocated = 0;
  const requested = fifoRows.reduce((s, row) => s + row.plants, 0);

  for (const input of inputs) {
    const pollyhouse = input.pollyhouse;
    const inShed = (suggestions || []).filter(
      (s) =>
        s.dispatchEligible && pollyhouseMatchesFilter(s.pollyhouse, pollyhouse)
    );
    const shedAvailable = inShed.reduce(
      (sum, l) =>
        sum + (Number(l.remainingPlants ?? l.availableQuantity) || 0),
      0
    );
    const sizeSplit = parseSizeSplit(input.sizeSplit);
    const requestedBySize = sizeSplit || { R1: 0, R2: 0, R3: 0 };
    const shedAllocations = [];
    let shedRequested = 0;
    let shedAllocated = 0;
    const shedErrors = [];

    const rowsForShed = fifoRows.filter((r) => r.pollyhouse === pollyhouse);
    for (const { size, plants } of rowsForShed) {
      shedRequested += plants;
      let pool = inShed;
      if (size) pool = inShed.filter((ln) => ln.size === size);
      const fifo = allocateSecondaryFifoPlants(pool, plants);
      const tagged = (fifo.allocations || []).map((a) => ({
        ...a,
        pollyhouse,
      }));
      shedAllocations.push(...tagged);
      shedAllocated += fifo.totalAllocated || 0;
      if (!fifo.ok) {
        const label = size ? `${pollyhouse} ${size}` : pollyhouse;
        shedErrors.push(`${label}: ${fifo.error}`);
      }
    }

    allocations.push(...shedAllocations);
    totalAllocated += shedAllocated;
    byShed.push({
      pollyhouse,
      requested: shedRequested,
      requestedBySize: sizeSplit || undefined,
      shedAvailablePlants: shedAvailable,
      byBatch: groupPolyhouseStockByBatch(inShed),
      ok: shedErrors.length === 0 && shedAllocated === shedRequested,
      error: shedErrors.length ? shedErrors.join("; ") : undefined,
      allocations: shedAllocations,
      totalAllocated: shedAllocated,
    });
    errors.push(...shedErrors);
  }

  const ok = errors.length === 0 && totalAllocated === requested;
  return {
    ok,
    error: errors.length ? errors.join("; ") : undefined,
    allocations,
    byShed,
    totalAllocated,
    requested,
    partial: totalAllocated > 0 && totalAllocated < requested,
  };
}

/** Dedup + sanitize manual inward selections (aggregate plants per inward entry). */
export function normalizeInwardSelections(raw) {
  if (!Array.isArray(raw)) return [];
  const byId = new Map();
  for (const sel of raw) {
    const sid = String(sel?.secondaryInwardId || "").trim();
    const plants = Math.max(0, Math.floor(Number(sel?.plants) || 0));
    if (!sid || plants < 1) continue;
    const prev =
      byId.get(sid) || {
        secondaryInwardId: sid,
        batchId: sel?.batchId != null ? String(sel.batchId) : "",
        plants: 0,
      };
    prev.plants += plants;
    if (!prev.batchId && sel?.batchId != null) prev.batchId = String(sel.batchId);
    byId.set(sid, prev);
  }
  return [...byId.values()];
}

/**
 * Manual allocation: honor exactly the inward entries the user picked.
 * Each selection is validated against the inward line's available stock and the
 * overall plant cap (= remaining vehicle need). Plants -> trays mirror the
 * partial-last-tray model used by FIFO so executeOneSecondaryOutwardLine is reusable.
 */
/**
 * Attach per-cavity `numberPerCrate` (from Tray master) onto suggestion lines so
 * each inward entry's crate math uses its own cavity definition (mixed cavities supported).
 */
export async function enrichSuggestionsWithPerCrate(suggestions) {
  const lines = Array.isArray(suggestions) ? suggestions : [];
  const sizes = [
    ...new Set(lines.map((s) => Math.floor(Number(s.cavity) || 0)).filter((n) => n > 0)),
  ];
  if (!sizes.length) return lines;
  const trays = await Tray.find({ cavity: { $in: sizes } })
    .select("cavity numberPerCrate")
    .lean();
  const perByCavity = new Map();
  for (const t of trays) {
    const c = Math.floor(Number(t.cavity) || 0);
    const per = Math.max(0, Math.floor(Number(t.numberPerCrate) || 0));
    if (c > 0 && per > 0 && !perByCavity.has(c)) perByCavity.set(c, per);
  }
  return lines.map((s) => ({
    ...s,
    numberPerCrate:
      perByCavity.get(Math.floor(Number(s.cavity) || 0)) || s.numberPerCrate || 0,
  }));
}

export function allocateManualSecondaryLoads(suggestions, inwardSelections, opts = {}) {
  const selections = normalizeInwardSelections(inwardSelections);
  if (!selections.length) {
    return {
      ok: false,
      error: "At least one inward entry with plants is required",
      allocations: [],
      byShed: [],
      totalAllocated: 0,
      requested: 0,
    };
  }

  const lineById = new Map(
    (suggestions || []).map((s) => [String(s.secondaryInwardId), s])
  );
  const allocations = [];
  const errors = [];
  let totalAllocated = 0;
  let requested = 0;

  for (const sel of selections) {
    requested += sel.plants;
    const line = lineById.get(sel.secondaryInwardId);
    if (!line) {
      errors.push(`Inward entry ${sel.secondaryInwardId} not found`);
      continue;
    }
    if (line.dispatchEligible === false) {
      errors.push(`${line.batchNumber || sel.secondaryInwardId}: not dispatch-ready`);
      continue;
    }
    const cav = Math.max(1, Math.floor(Number(line.cavity) || 126));
    const avail = Math.max(
      0,
      Number(line.remainingPlants ?? line.availableQuantity) || 0
    );
    if (sel.plants > avail) {
      errors.push(
        `${line.batchNumber || sel.secondaryInwardId}: only ${avail} available`
      );
      continue;
    }
    const fullTrays = Math.floor(sel.plants / cav);
    const partialTrayPlants = sel.plants - fullTrays * cav;
    const numberOfTrays = fullTrays + (partialTrayPlants > 0 ? 1 : 0);
    allocations.push({
      batchId: String(line.batchId),
      secondaryInwardId: String(line.secondaryInwardId),
      batchNumber: line.batchNumber,
      cavity: cav,
      numberPerCrate: Math.max(0, Math.floor(Number(line.numberPerCrate) || 0)),
      size: line.size || "R1",
      numberOfFullTrays: fullTrays,
      partialTrayPlants,
      numberOfTrays,
      plants: sel.plants,
      pollyhouse: line.pollyhouse,
      numberOfBottles: bottlesForVehicleLoadMove(line, numberOfTrays, sel.plants),
    });
    totalAllocated += sel.plants;
  }

  const capPlants =
    opts.capPlants != null
      ? Math.max(0, Math.floor(Number(opts.capPlants) || 0))
      : null;
  if (capPlants != null && requested > capPlants) {
    errors.push(`Selected ${requested} exceeds remaining need ${capPlants}`);
  }

  const byShedMap = new Map();
  for (const a of allocations) {
    const ph = a.pollyhouse || "";
    const cur =
      byShedMap.get(ph) || { pollyhouse: ph, allocations: [], totalAllocated: 0 };
    cur.allocations.push(a);
    cur.totalAllocated += a.plants;
    byShedMap.set(ph, cur);
  }
  const byShed = [...byShedMap.values()].map((sh) => ({
    pollyhouse: sh.pollyhouse,
    requested: sh.totalAllocated,
    shedAvailablePlants: sh.totalAllocated,
    allocations: sh.allocations,
    totalAllocated: sh.totalAllocated,
    ok: true,
  }));

  const ok = errors.length === 0 && allocations.length > 0;
  return {
    ok,
    error: errors.length ? errors.join("; ") : undefined,
    allocations,
    byShed,
    totalAllocated,
    requested,
    partial: false,
  };
}

export function groupPolyhouseStockByBatch(lines) {
  const map = new Map();
  for (const ln of lines || []) {
    const bid = ln.batchId != null ? String(ln.batchId) : "";
    if (!bid) continue;
    const plants = Math.max(
      0,
      Number(ln.remainingPlants ?? ln.availableQuantity) || 0
    );
    const cur = map.get(bid) || {
      batchId: bid,
      batchNumber: ln.batchNumber != null ? String(ln.batchNumber) : "",
      totalPlants: 0,
      lineCount: 0,
    };
    cur.totalPlants += plants;
    cur.lineCount += 1;
    map.set(bid, cur);
  }
  return [...map.values()].sort((a, b) => b.totalPlants - a.totalPlants);
}

export async function sumPlantsLoadedOnDispatch(dispatchId) {
  if (!mongoose.isValidObjectId(String(dispatchId))) {
    return { total: 0, byOrder: new Map() };
  }
  const oid = new mongoose.Types.ObjectId(String(dispatchId));
  const pos = await PlantOutward.find({
    "secondaryOutward.linkedDispatchId": oid,
  })
    .select("secondaryOutward")
    .lean();

  let total = 0;
  const byOrder = new Map();
  for (const po of pos) {
    for (const so of po.secondaryOutward || []) {
      if (String(so.linkedDispatchId) !== String(dispatchId)) continue;
      const q = Number(so.totalQuantity) || 0;
      total += q;
      if (so.linkedOrderId) {
        const key = String(so.linkedOrderId);
        byOrder.set(key, (byOrder.get(key) || 0) + q);
      }
    }
  }
  return { total, byOrder };
}

export async function findDispatchActiveByIdOrTransport(idParam) {
  const raw = String(idParam ?? "").trim();
  if (!raw) return null;
  if (mongoose.isValidObjectId(raw)) {
    const d = await Dispatch.findOne({ _id: raw, isDeleted: { $ne: true } });
    if (d) return d;
  }
  return Dispatch.findOne({ transportId: raw, isDeleted: { $ne: true } });
}

export function unionDispatchOrderObjectIds(dispatchDoc) {
  const plain = dispatchDoc?.toObject?.() ?? dispatchDoc;
  const ids = new Set();
  for (const id of plain.orderIds || []) {
    if (id) ids.add(String(id));
  }
  for (const ord of plain.orderDispatchDetails || []) {
    if (ord?.orderId) ids.add(String(ord.orderId));
  }
  return [...ids]
    .filter((id) => mongoose.isValidObjectId(id))
    .map((id) => new mongoose.Types.ObjectId(id));
}

const orderRemainingPlantsValue = (doc) => {
  const rem = doc?.remainingPlants;
  if (rem != null && Number.isFinite(Number(rem))) return Number(rem);
  return (
    Number(doc?.numberOfPlants || 0) + Number(doc?.additionalPlants || 0)
  );
};

const orderMatchesDispatchBatch = (orderDoc, batchLean) => {
  if (!batchLean?.plantCmsId || !batchLean?.plantSubtypeId) return false;
  return (
    String(orderDoc.plantName) === String(batchLean.plantCmsId) &&
    String(orderDoc.plantSubtype) === String(batchLean.plantSubtypeId)
  );
};

const buildSecondaryOrderLinkSnapshot = (orderDoc, batchLean) => {
  let pos = orderDoc.productOrderSnapshot;
  if (pos && typeof pos.toObject === "function") pos = pos.toObject();
  return {
    orderIdNumeric: orderDoc.orderId,
    publicOrderCode: orderDoc.publicOrderCode ?? null,
    batchNumber: batchLean?.batchNumber ?? null,
    plantNameId: orderDoc.plantName,
    plantSubtypeId: orderDoc.plantSubtype,
    productOrderSnapshot: pos || undefined,
    productName: orderDoc.productName,
    productMappingId: orderDoc.productMappingId,
  };
};

export async function computeSuggestedFulfillmentSequence(dispatchId) {
  if (!mongoose.isValidObjectId(String(dispatchId))) return 1;
  const oid = new mongoose.Types.ObjectId(String(dispatchId));
  const pos = await PlantOutward.find({
    "secondaryOutward.linkedDispatchId": oid,
  })
    .select(
      "secondaryOutward.linkedDispatchId secondaryOutward.dispatchFulfillmentSequence"
    )
    .lean();

  let maxSeq = 0;
  for (const po of pos) {
    for (const so of po.secondaryOutward || []) {
      if (String(so.linkedDispatchId) !== String(dispatchId)) continue;
      const seq = Number(so.dispatchFulfillmentSequence) || 0;
      if (seq > maxSeq) maxSeq = seq;
    }
  }
  return maxSeq + 1;
}

export function computeSecondaryDispatchEligibility(
  siPlain,
  secondaryDays,
  todayStart
) {
  const bypass = siPlain.readinessBypassAt != null;
  const inwardYmd = siPlain.secondaryInwardDate
    ? moment(siPlain.secondaryInwardDate).format("YYYY-MM-DD")
    : null;
  let expectedReadyByCalendar = null;
  if (siPlain.expectedReadyDate && moment(siPlain.expectedReadyDate).isValid()) {
    expectedReadyByCalendar = moment(siPlain.expectedReadyDate)
      .startOf("day")
      .toISOString();
  } else if (inwardYmd && secondaryDays > 0) {
    expectedReadyByCalendar = moment(inwardYmd)
      .add(secondaryDays, "days")
      .startOf("day")
      .toISOString();
  }
  const calendarEligible =
    expectedReadyByCalendar != null
      ? !todayStart.isBefore(moment(expectedReadyByCalendar).startOf("day"))
      : false;
  const dispatchEligible = Boolean(calendarEligible || bypass);
  return { dispatchEligible, expectedReadyByCalendar, calendarEligible };
}

async function resolvePlantRowFromDispatch(dispatchDoc, plantRowIndex) {
  let row = dispatchDoc.plantsDetails?.[plantRowIndex];
  if (!row) {
    const unionIds = unionDispatchOrderObjectIds(dispatchDoc);
    if (!unionIds.length) {
      throw new AppError(
        "Invalid plant row index for this dispatch (no plant rows and no orders)",
        400
      );
    }
    const inferOrder = await Order.findById(unionIds[0])
      .select("plantName plantSubtype")
      .lean();
    if (!inferOrder?.plantName || !inferOrder?.plantSubtype) {
      throw new AppError(
        "Cannot infer plant/subtype for this vehicle — add plant rows or fix orders",
        400
      );
    }
    const qtyFromDetails = (dispatchDoc.orderDispatchDetails || []).reduce(
      (s, r) => s + (Number(r.dispatchQuantity) || 0),
      0
    );
    const fallbackQty = qtyFromDetails || 1;
    row = {
      name: "Vehicle load",
      plantId: inferOrder.plantName,
      subTypeId: inferOrder.plantSubtype,
      quantity: fallbackQty,
      totalPlants: fallbackQty,
    };
  }
  return row;
}

async function executeOneSecondaryOutwardLine({
  session,
  batchId,
  allocation,
  pollyhouse,
  linkedDispatchDoc,
  dispatchPlantRowIdx,
  fulfillmentSeq,
  linkedOrderId,
  remarks,
  performedBy,
}) {
  const {
    secondaryInwardId,
    numberOfTrays,
    numberOfFullTrays,
    partialTrayPlants,
    cavity,
    size,
    numberOfBottles,
    plants,
  } = allocation;

  const plantOutward = await PlantOutward.findOne({ batchId }).session(session);
  if (!plantOutward) {
    throw new AppError("No plant outward found with this batch ID", 404);
  }

  const secondaryInward = plantOutward.secondaryInward.id(secondaryInwardId);
  if (!secondaryInward) {
    throw new AppError("Secondary inward entry not found", 404);
  }

  const batchDoc = await DispatchBatch.findById(plantOutward.batchId)
    .select(BATCH_SELECT_FIELDS)
    .session(session)
    .lean();

  const siPlain =
    typeof secondaryInward.toObject === "function"
      ? secondaryInward.toObject()
      : secondaryInward;

  const resolvedPollyhouse =
    (typeof pollyhouse === "string" && pollyhouse.trim()) ||
    String(siPlain.pollyhouse || "").trim();
  if (!resolvedPollyhouse) {
    throw new AppError("Pollyhouse is required for shed pickup", 400);
  }

  const plantsMoving = Math.max(1, Math.floor(Number(plants) || 0));
  const fullTrays = Math.max(0, Math.floor(Number(numberOfFullTrays) || 0));
  const partialPlants = Math.max(0, Math.floor(Number(partialTrayPlants) || 0));
  const loadedTrayCount = Math.max(1, Math.floor(Number(numberOfTrays) || 0));
  const expectedPlants = fullTrays * cavity + partialPlants;
  if (expectedPlants !== plantsMoving) {
    throw new AppError("FIFO tray math mismatch", 500);
  }

  plantOutward.validateTransfer(
    "secondaryInward",
    secondaryInwardId,
    plantsMoving
  );

  let linkedOrderDoc = null;
  if (linkedOrderId) {
    linkedOrderDoc = await Order.findById(linkedOrderId).session(session);
    if (!linkedOrderDoc) {
      throw new AppError("Linked order not found", 404);
    }
    const orderOk =
      linkedOrderDoc.orderStatus === "READY_FOR_DISPATCH" ||
      linkedOrderDoc.orderStatus === "DISPATCH_PROCESS";
    if (!orderOk) {
      throw new AppError(
        "Order must be READY_FOR_DISPATCH or DISPATCH_PROCESS",
        400
      );
    }
    if (!orderMatchesDispatchBatch(linkedOrderDoc, batchDoc)) {
      throw new AppError("Order plant/subtype does not match batch", 400);
    }
    const currentOrderRemaining = orderRemainingPlantsValue(linkedOrderDoc);
    if (plantsMoving > currentOrderRemaining) {
      throw new AppError(
        `Quantity (${plantsMoving}) exceeds order remaining (${currentOrderRemaining})`,
        400
      );
    }
    const onVehicle = unionDispatchOrderObjectIds(linkedDispatchDoc).some(
      (oid) => String(oid) === String(linkedOrderId)
    );
    if (!onVehicle) {
      throw new AppError("linkedOrderId must be on the linked vehicle dispatch", 400);
    }
  }

  const orderLinkSnapshot =
    linkedOrderDoc != null
      ? buildSecondaryOrderLinkSnapshot(linkedOrderDoc, batchDoc)
      : undefined;

  const resolvedOutDate = new Date();
  const transferHistory = {
    transferDate: resolvedOutDate,
    quantityTransferred: plantsMoving,
    remarks: remarks || "Vehicle fulfillment",
  };

  const secondaryOutwardEntry = {
    secondaryOutwardDate: resolvedOutDate,
    numberOfBottles,
    size,
    cavity,
    numberOfTrays: loadedTrayCount,
    numberOfFullTrays: fullTrays,
    partialTrayPlants: partialPlants,
    totalQuantity: plantsMoving,
    numberOfPlants: plantsMoving,
    availableQuantity: plantsMoving,
    pollyhouse: resolvedPollyhouse,
    laboursEngaged: 1,
    transferStatus: "available",
    sourceSecondaryInwardId: secondaryInwardId,
    ...(linkedOrderDoc != null && linkedOrderId
      ? { linkedOrderId, orderLinkSnapshot }
      : {}),
    linkedDispatchId: linkedDispatchDoc._id,
    linkedDispatchPlantRowIndex: dispatchPlantRowIdx,
    dispatchFulfillmentSequence: fulfillmentSeq,
    dispatchFulfillmentSnapshot: {
      transportId: linkedDispatchDoc.transportId,
      driverName: linkedDispatchDoc.driverName,
      vehicleName: linkedDispatchDoc.vehicleName,
      vehicleNumber: linkedDispatchDoc.vehicleNumber,
    },
  };

  const newSecondaryInwardStatus =
    secondaryInward.availableQuantity - plantsMoving === 0
      ? "fully_transferred"
      : "partially_transferred";

  const updatedDoc = await PlantOutward.findOneAndUpdate(
    { batchId, "secondaryInward._id": secondaryInwardId },
    {
      $push: {
        secondaryOutward: secondaryOutwardEntry,
        "secondaryInward.$.transferHistory": transferHistory,
      },
      $set: {
        "secondaryInward.$.transferStatus": newSecondaryInwardStatus,
        "secondaryInward.$.availableQuantity":
          secondaryInward.availableQuantity - plantsMoving,
      },
    },
    { new: true, session, runValidators: true }
  );

  const outArr = updatedDoc?.secondaryOutward || [];
  const newSo = outArr[outArr.length - 1];
  if (!newSo?._id) {
    throw new AppError("Could not resolve new secondary outward id", 500);
  }

  const secondaryDaysForElig = batchDoc
    ? Number(safeMongooseNumber(batchDoc.secondaryPlantReadyDays)) || 0
    : 0;
  const dispatchElig = computeSecondaryDispatchEligibility(
    siPlain,
    secondaryDaysForElig,
    moment().startOf("day")
  );

  let slotSubtract = 0;
  try {
    const syncResult = await syncSecondaryInwardSlotStockAdd({
      session,
      batchId,
      secondaryInwardId,
      batchLean: batchDoc,
      siPlain,
      dispatchEligible: dispatchElig.dispatchEligible,
      force: true,
      performedBy,
    });
    const siForSubtract = {
      ...siPlain,
      linkedBookingSlotId:
        syncResult?.slotId || siPlain.linkedBookingSlotId || null,
      slotStockSyncedPlants:
        (Number(siPlain.slotStockSyncedPlants) || 0) + (syncResult?.applied ?? 0),
    };
    const subResult = await subtractSecondaryInwardSlotStock({
      session,
      batchId,
      secondaryInwardId,
      batchLean: batchDoc,
      siPlain: siForSubtract,
      quantity: plantsMoving,
      performedBy,
    });
    slotSubtract = subResult?.subtracted ?? 0;
  } catch (slotErr) {
    console.warn(
      "[secondaryVehicleLoad] slot subtract:",
      slotErr?.message || slotErr
    );
  }

  await recordSecondaryOutwardOnLedger(session, {
    dispatchBatchId: batchId,
    plantOutwardId: updatedDoc._id,
    secondaryInwardId,
    secondaryOutwardId: newSo._id,
    quantity: plantsMoving,
    performedBy,
    metadata: {
      ...(linkedOrderDoc != null
        ? { orderId: linkedOrderId, orderNumber: linkedOrderDoc.orderId }
        : {}),
      dispatchId: linkedDispatchDoc._id,
    },
  });

  if (linkedOrderDoc) {
    const currentOrderRemaining = orderRemainingPlantsValue(linkedOrderDoc);
    const newRemaining = currentOrderRemaining - plantsMoving;
    let newOrderStatus = linkedOrderDoc.orderStatus;
    if (newRemaining === 0) {
      newOrderStatus = "DISPATCHED";
    } else if (newRemaining < currentOrderRemaining) {
      newOrderStatus = "DISPATCH_PROCESS";
    }

    const preAssignedSecondary = String(
      linkedOrderDoc?.deliveryChallanInvoiceNumber || ""
    ).trim();
    let official = null;
    let secondaryInvoiceLabel = preAssignedSecondary;
    if (newOrderStatus === "DISPATCHED" && newRemaining === 0) {
      official = await ensureOfficialDeliveryChallanForOrder(
        linkedOrderDoc,
        session
      );
    }
    if (official) {
      secondaryInvoiceLabel = official;
    } else if (!secondaryInvoiceLabel) {
      const [freshSec] = await allocateNextInvoiceNumbers(session, 1);
      secondaryInvoiceLabel = freshSec || "";
    }

    const dispatchHistoryEntry = {
      date: new Date(),
      quantity: plantsMoving,
      remainingAfterDispatch: newRemaining,
      processedBy:
        performedBy && mongoose.isValidObjectId(String(performedBy))
          ? performedBy
          : undefined,
      driverName: linkedDispatchDoc?.driverName || "",
      vehicleName: linkedDispatchDoc?.vehicleName || "",
      dispatchId: linkedDispatchDoc._id,
      source: "SECONDARY_SHED",
      secondaryOutwardId: newSo._id,
      plantOutwardId: updatedDoc._id,
      dispatchBatchId: plantOutward.batchId,
      productSnapshot: orderLinkSnapshot,
      ...(secondaryInvoiceLabel ? { invoiceNumber: secondaryInvoiceLabel } : {}),
    };

    const secondaryOrderSet = {
      remainingPlants: newRemaining,
      orderStatus: newOrderStatus,
    };
    if (official) {
      secondaryOrderSet.officialDeliveryChallanNumber = official;
    }
    if (!preAssignedSecondary && secondaryInvoiceLabel && !official) {
      secondaryOrderSet.deliveryChallanInvoiceNumber = secondaryInvoiceLabel;
    }

    await updateOrderWithLedgerSync({
      orderId: linkedOrderId,
      existingDoc: linkedOrderDoc,
      session,
      userId: performedBy,
      contextLabel: "secondary_vehicle_load",
      updateOperation: {
        $set: secondaryOrderSet,
        $push: { dispatchHistory: dispatchHistoryEntry },
      },
    });
  }

  await recordShedActivity({
    batchId,
    stage: "secondary_inward",
    subdocId: secondaryInwardId,
    action: SHED_ACTIVITY_ACTIONS.SECONDARY_OUTWARD,
    activityName: `जावक · ${plantsMoving} रोप`,
    performedBy,
    quantity: plantsMoving,
    metadata: {
      secondaryOutwardId: newSo._id,
      linkedDispatchId: linkedDispatchDoc._id,
      slotSubtract,
    },
    session,
  });

  return {
    batchId,
    secondaryInwardId,
    secondaryOutwardId: newSo._id,
    plants: plantsMoving,
    trays: loadedTrayCount,
    cavity,
    slotSubtract,
  };
}

export async function updateDispatchOrderShedLoaded({
  session,
  dispatchDoc,
  orderId,
  plantsLoaded,
}) {
  if (!orderId || plantsLoaded < 1) return null;
  const oid = String(orderId);
  const details = dispatchDoc.orderDispatchDetails || [];
  let idx = details.findIndex((d) => String(d.orderId) === oid);
  if (idx < 0) return null;

  const row = details[idx];
  const prev = Math.max(0, Number(row.shedLoadedQuantity) || 0);
  const next = prev + plantsLoaded;
  const dispatchQty = Math.max(0, Number(row.dispatchQuantity) || 0);

  dispatchDoc.orderDispatchDetails[idx].shedLoadedQuantity = next;
  dispatchDoc.orderDispatchDetails[idx].shedLoadedAt = new Date();
  dispatchDoc.orderDispatchDetails[idx].shedLoadedFromSecondary = true;

  await dispatchDoc.save({ session, validateBeforeSave: true });

  return {
    orderId: oid,
    shedLoadedQuantity: next,
    dispatchQuantity: dispatchQty,
    fullyLoaded: dispatchQty > 0 && next >= dispatchQty,
  };
}

export async function previewSecondaryVehicleLoad({
  dispatchId,
  pollyhouse,
  plants,
  shedLoads,
  inwardSelections,
  plantRowIndex = 0,
  collectSuggestionsFn,
}) {
  const dispatchDoc = await findDispatchActiveByIdOrTransport(dispatchId);
  if (!dispatchDoc) {
    throw new AppError("Vehicle dispatch not found", 404);
  }
  if (!["PENDING", "IN_TRANSIT"].includes(dispatchDoc.transportStatus)) {
    throw new AppError("Vehicle must be PENDING or IN_TRANSIT", 400);
  }

  const row = await resolvePlantRowFromDispatch(dispatchDoc, plantRowIndex);
  const plantCmsId = row.plantId;
  const plantSubtypeId = row.subTypeId;
  if (!plantCmsId || !plantSubtypeId) {
    throw new AppError("Dispatch plant row missing plant/subtype ids", 400);
  }

  const { suggestions } = await collectSuggestionsFn(plantCmsId, plantSubtypeId);
  const { total: alreadyLoaded } = await sumPlantsLoadedOnDispatch(dispatchDoc._id);
  const vehicleNeed = Number(row.quantity ?? row.totalPlants ?? 0) || 0;
  const capPlants = Math.max(0, vehicleNeed - alreadyLoaded);

  const useManual = Array.isArray(inwardSelections) && inwardSelections.length > 0;
  let normalizedInputs = [];
  let multi;
  if (useManual) {
    const enriched = await enrichSuggestionsWithPerCrate(suggestions);
    multi = allocateManualSecondaryLoads(enriched, inwardSelections, {
      capPlants,
    });
  } else {
    normalizedInputs = normalizeShedLoadInputs({ pollyhouse, plants, shedLoads });
    if (!normalizedInputs.length) {
      throw new AppError(
        "shedLoads, inwardSelections, or pollyhouse+plants is required",
        400
      );
    }
    multi = allocateMultiShedFifoLoads(suggestions, normalizedInputs);
  }

  return {
    dispatchId: dispatchDoc._id,
    pollyhouse:
      normalizedInputs.length === 1 ? normalizedInputs[0].pollyhouse : undefined,
    shedLoads: normalizedInputs,
    plantRowIndex,
    plantRowQuantity: vehicleNeed,
    shedLoadedPlantsTotal: alreadyLoaded,
    shedAvailablePlants: multi.byShed.reduce(
      (s, sh) => s + (Number(sh.shedAvailablePlants) || 0),
      0
    ),
    byShed: multi.byShed,
    byBatch: groupPolyhouseStockByBatch(
      multi.allocations.map((a) => ({
        batchId: a.batchId,
        batchNumber: a.batchNumber,
        availableQuantity: a.plants,
      }))
    ),
    ok: multi.ok,
    error: multi.error,
    allocations: multi.allocations,
    totalAllocated: multi.totalAllocated,
    requested: multi.requested,
    partial: multi.partial,
  };
}

export async function executeSecondaryVehicleLoad({
  dispatchId,
  pollyhouse,
  plants,
  shedLoads,
  inwardSelections,
  plantRowIndex = 0,
  linkedOrderId,
  remarks,
  performedBy,
  collectSuggestionsFn,
}) {
  const dispatchDoc = await findDispatchActiveByIdOrTransport(dispatchId);
  if (!dispatchDoc) {
    throw new AppError("Vehicle dispatch not found", 404);
  }
  if (!["PENDING", "IN_TRANSIT"].includes(dispatchDoc.transportStatus)) {
    throw new AppError("Vehicle must be PENDING or IN_TRANSIT", 400);
  }

  const dispatchPlantRowIdx = Math.max(0, Number(plantRowIndex) || 0);
  const row = await resolvePlantRowFromDispatch(dispatchDoc, dispatchPlantRowIdx);
  const plantCmsId = row.plantId;
  const plantSubtypeId = row.subTypeId;

  const { suggestions } = await collectSuggestionsFn(plantCmsId, plantSubtypeId);

  const useManual = Array.isArray(inwardSelections) && inwardSelections.length > 0;
  let fifo;
  if (useManual) {
    const { total: alreadyLoaded } = await sumPlantsLoadedOnDispatch(
      dispatchDoc._id
    );
    const vehicleNeed = Number(row.quantity ?? row.totalPlants ?? 0) || 0;
    const capPlants = Math.max(0, vehicleNeed - alreadyLoaded);
    const enriched = await enrichSuggestionsWithPerCrate(suggestions);
    fifo = allocateManualSecondaryLoads(enriched, inwardSelections, {
      capPlants,
    });
  } else {
    const normalizedInputs = normalizeShedLoadInputs({ pollyhouse, plants, shedLoads });
    if (!normalizedInputs.length) {
      throw new AppError(
        "shedLoads, inwardSelections, or pollyhouse+plants is required",
        400
      );
    }
    fifo = allocateMultiShedFifoLoads(suggestions, normalizedInputs);
  }
  if (!fifo.ok) {
    throw new AppError(fifo.error || "Allocation failed", 400);
  }

  let resolvedOrderId = linkedOrderId;
  if (!resolvedOrderId) {
    const unionIds = unionDispatchOrderObjectIds(dispatchDoc);
    const statusIn = { $in: ["READY_FOR_DISPATCH", "DISPATCH_PROCESS"] };
    const matching = await Order.find({
      _id: { $in: unionIds },
      plantName: plantCmsId,
      plantSubtype: plantSubtypeId,
      remainingPlants: { $gt: 0 },
      orderStatus: statusIn,
    })
      .select("_id")
      .sort({ orderId: -1 })
      .limit(1)
      .lean();
    if (matching.length === 1) {
      resolvedOrderId = String(matching[0]._id);
    }
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const freshDispatch = await Dispatch.findById(dispatchDoc._id).session(session);
    if (!freshDispatch) {
      throw new AppError("Vehicle dispatch not found", 404);
    }

    let seq = await computeSuggestedFulfillmentSequence(freshDispatch._id);
    const results = [];
    let slotSubtractTotal = 0;

    for (const allocation of fifo.allocations) {
      const lineResult = await executeOneSecondaryOutwardLine({
        session,
        batchId: allocation.batchId,
        allocation,
        pollyhouse: allocation.pollyhouse,
        linkedDispatchDoc: freshDispatch,
        dispatchPlantRowIdx,
        fulfillmentSeq: seq,
        linkedOrderId: resolvedOrderId || undefined,
        remarks,
        performedBy,
      });
      results.push(lineResult);
      slotSubtractTotal += lineResult.slotSubtract || 0;
      seq += 1;
    }

    let orderLoaded = null;
    if (resolvedOrderId) {
      orderLoaded = await updateDispatchOrderShedLoaded({
        session,
        dispatchDoc: freshDispatch,
        orderId: resolvedOrderId,
        plantsLoaded: fifo.totalAllocated,
      });
    }

    await session.commitTransaction();

    return {
      allocations: results,
      totalLoaded: fifo.totalAllocated,
      slotSubtractTotal,
      orderLoaded,
      suggestedFulfillmentSequence: seq - fifo.allocations.length,
      linkedOrderId: resolvedOrderId || null,
    };
  } catch (err) {
    await session.abortTransaction();
    throw err;
  } finally {
    session.endSession();
  }
}
