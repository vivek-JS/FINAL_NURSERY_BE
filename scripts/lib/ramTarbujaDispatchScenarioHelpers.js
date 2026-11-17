import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import {
  applyPlantsToLinkedSlots,
  markOrdersSowed,
  recordExcessPlantsOnSlot,
  pushEvent,
  findSowBatchForRequest,
} from "../../controllers/sowingCompleteHelpers.js";
import { parseLocalDate, fmtDDMMYYYY } from "../../controllers/sowingSlotReadyHelpers.js";
import { allocateNextOrderId } from "../../services/orderIdAllocation.service.js";
import { sowQtySlotImpact } from "../../utility/lagwadSlotPlantsSplit.js";
import SowingRequest from "../../models/sowingRequest.model.js";
import Order from "../../models/order.model.js";
import PlantSlot from "../../models/slots.model.js";

export const BATCH_ID = "DISPATCH-SCENARIO-RAM-TARBUJA-OCT2026";
export const MOBILE_NUMBER = 9823832132;
export const PLANT_ID = "691054dffba6fb380f8d57b3";
export const SUBTYPE_ID = "6aa562960401ec99b9f6fe37";
export const SALES_PERSON_ID = "69ca549bc2ef331f5e13c91b";
export const CAVITY_ID = "699acb84779cdf7c42175832";
export const READY_DAYS = 18;
export const SHED = "Dispatch Scenario Shed";

export const DATES = [
  "2026-10-17",
  "2026-10-18",
  "2026-10-19",
  "2026-10-20",
  "2026-10-21",
  "2026-10-22",
];

/** excessSow = extra plants sowed beyond order need (saleable leftover on that batch). */
export const ORDER_ROWS = [
  { case: "ABLE_EXACT", date: "2026-10-17", qty: 1000, excessSow: 500, seedSource: "COMPANY", status: "ACCEPTED", sow: "exact" },
  { case: "ABLE_EXACT", date: "2026-10-18", qty: 1000, excessSow: 0, seedSource: "RAISING", status: "ACCEPTED", sow: "exact" },
  { case: "ABLE_EXACT", date: "2026-10-19", qty: 1000, excessSow: 800, seedSource: "COMPANY", status: "ACCEPTED", sow: "exact" },
  { case: "ABLE_EXACT", date: "2026-10-20", qty: 1000, excessSow: 0, seedSource: "COMPANY", status: "ACCEPTED", sow: "exact" },
  { case: "ABLE_EXACT", date: "2026-10-21", qty: 1200, excessSow: 400, seedSource: "RAISING", status: "ACCEPTED", sow: "exact" },
  { case: "ABLE_EXACT", date: "2026-10-22", qty: 1000, excessSow: 0, seedSource: "COMPANY", status: "ACCEPTED", sow: "exact" },
  { case: "MULTI_SOW_COVER", date: "2026-10-19", qty: 1000, excessSow: 500, seedSource: "COMPANY", status: "ACCEPTED", sow: "multi", sowGroup: "MULTI_19" },
  { case: "MULTI_SOW_COVER", date: "2026-10-20", qty: 1000, excessSow: 0, seedSource: "COMPANY", status: "ACCEPTED", sow: "multi", sowGroup: "MULTI_19" },
  { case: "MULTI_SOW_COVER", date: "2026-10-21", qty: 1000, excessSow: 0, seedSource: "RAISING", status: "ACCEPTED", sow: "multi", sowGroup: "MULTI_19" },
  { case: "NEW_UNSOWN", date: "2026-10-20", qty: 1500, seedSource: "COMPANY", status: "ACCEPTED", sow: false },
  { case: "NEW_UNSOWN", date: "2026-10-21", qty: 1500, seedSource: "COMPANY", status: "ACCEPTED", sow: false },
  { case: "NEW_UNSOWN", date: "2026-10-22", qty: 1500, seedSource: "RAISING", status: "ACCEPTED", sow: false },
  { case: "EXCESS_THEN_ORDER", date: "2026-10-22", qty: 1000, seedSource: "COMPANY", status: "ACCEPTED", sow: "cover_from_excess" },
  { case: "READY_STATUS", date: "2026-10-19", qty: 1000, excessSow: 300, seedSource: "COMPANY", status: "READY_FOR_DISPATCH", sow: "exact" },
];

export const EXCESS_SOWS = [
  { case: "EXCESS_FREE", readyDate: "2026-10-18", plants: 2000 },
  { case: "EXCESS_THEN_ORDER_POOL", readyDate: "2026-10-22", plants: 1500 },
];

export const markerFor = (row) => `${BATCH_ID}:${row.case}:${row.date}`;
export const sowMarker = (caseName, readyDate) => `${BATCH_ID}:SOW:${caseName}:${readyDate}`;
export const slotDate = (date) => {
  const [y, m, d] = date.split("-");
  return `${d}-${m}-${y}`;
};
export const deliveryDateUtc = (date) => `${date}T18:30:00.000Z`;
export const slotIsActive = (slot) =>
  slot?.status === true || slot?.status === "active" || slot?.status === 1;

export function sowYmdForReady(readyYmd) {
  const d = parseLocalDate(readyYmd);
  if (!d) throw new Error(`Bad ready date ${readyYmd}`);
  d.setDate(d.getDate() - READY_DAYS);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function createAccessToken(user) {
  const secret = process.env.JWT_SECRET || process.env.PRIVATE_KEY;
  if (!secret) throw new Error("JWT_SECRET/PRIVATE_KEY is missing");
  return jwt.sign(
    {
      _id: String(user._id),
      phoneNumber: user.phoneNumber,
      role: user.role,
      jobTitle: user.jobTitle,
      name: user.name,
      type: "access",
    },
    secret,
    { expiresIn: "2h", issuer: "nursery-app", audience: "nursery-users" }
  );
}

export function emptyDaySlot(ddMmYyyy, tmpl) {
  const [dd, mm] = ddMmYyyy.split("-").map(Number);
  const month = new Date(2026, mm - 1, dd).toLocaleString("en-US", { month: "long" });
  return {
    _id: new mongoose.Types.ObjectId(),
    excessiveSowing: { packets: 0, plants: 0 },
    startDay: ddMmYyyy,
    endDay: ddMmYyyy,
    totalPlants: Number(tmpl?.totalPlants) || 50000,
    totalBookedPlants: 0,
    availablePlants: 0,
    availablePlantsMaterialized: false,
    actualPlants: 0,
    expectedMortality: 0,
    actualReadyPlants: 0,
    lagwadRemaining: 0,
    rolledInAvailablePlants: 0,
    rolledInActualReadyPlants: 0,
    closingStock: 0,
    buffer: tmpl?.buffer ?? 12,
    effectiveBuffer: 0,
    bufferAdjustedCapacity: 0,
    bufferAmount: 0,
    originalTotalPlants: 0,
    isOverflow: false,
    orders: [],
    allowedSalesmen: [],
    restrictToSalesmen: false,
    overflow: false,
    status: true,
    month,
    isManual: true,
    plantReadyDays: READY_DAYS,
    plantsSowed: 0,
    officeSowed: 0,
    primarySowed: 0,
    reminderBeforePlantReadyDays: 0,
    orderReservedPlants: 0,
    sowingCompleted: false,
    linkedSowingRequests: [],
    gapFullyCovered: false,
    sowingInProgress: [],
    sowingBatches: [],
    gapCovered: [],
    productStock: [],
    slotTrail: [],
  };
}

export async function ensureRamSubtypeLocal(db) {
  const plants = db.collection("plantcms");
  const plantOid = new mongoose.Types.ObjectId(PLANT_ID);
  const subtypeOid = new mongoose.Types.ObjectId(SUBTYPE_ID);
  const plant = await plants.findOne({ _id: plantOid });
  if (!plant) throw new Error("Watermelon PlantCms missing on local");
  if ((plant.subtypes || []).some((s) => String(s._id) === SUBTYPE_ID)) return;
  if (!process.env.PROD_MONGO_URL) {
    throw new Error("Ram Tarbuja missing locally; set PROD_MONGO_URL to copy subtype");
  }
  const prod = await mongoose.createConnection(process.env.PROD_MONGO_URL).asPromise();
  try {
    const prodPlant = await prod.collection("plantcms").findOne(
      { _id: plantOid },
      { projection: { subtypes: 1 } }
    );
    const subtype = (prodPlant?.subtypes || []).find((s) => String(s._id) === SUBTYPE_ID);
    if (!subtype) throw new Error("Ram Tarbuja not found on prod PlantCms");
    await plants.updateOne({ _id: plantOid }, { $push: { subtypes: subtype } });
    console.log("Copied Ram Tarbuja subtype to local CMS");

    const slotsCol = db.collection("plantslots");
    const localSlots = await slotsCol.findOne({ plantId: plantOid, year: 2026 });
    if (
      localSlots &&
      !(localSlots.subtypeSlots || []).some((s) => String(s.subtypeId) === SUBTYPE_ID)
    ) {
      const prodSlots = await prod.collection("plantslots").findOne({
        plantId: plantOid,
        year: 2026,
      });
      const st = (prodSlots?.subtypeSlots || []).find(
        (s) => String(s.subtypeId) === SUBTYPE_ID
      );
      if (st) {
        const clone = JSON.parse(JSON.stringify(st));
        clone.subtypeId = subtypeOid;
        for (const slot of clone.slots || []) {
          slot.sowingBatches = [];
          slot.linkedSowingRequests = [];
          slot.sowingInProgress = [];
          slot.plantsSowed = 0;
          slot.primarySowed = 0;
          slot.officeSowed = 0;
          slot.orderReservedPlants = 0;
          slot.availablePlants = 0;
          slot.totalBookedPlants = 0;
        }
        await slotsCol.updateOne({ _id: localSlots._id }, { $push: { subtypeSlots: clone } });
        console.log("Copied Ram Tarbuja 2026 subtypeSlots to local");
      }
    }
  } finally {
    await prod.close();
  }
}

export async function ensureDaySlots(db, slotDocId, subtypeOid, datesYmd, execute) {
  const col = db.collection("plantslots");
  const doc = await col.findOne({ _id: slotDocId });
  const stIdx = (doc.subtypeSlots || []).findIndex(
    (s) => String(s.subtypeId) === String(subtypeOid)
  );
  if (stIdx < 0) throw new Error("Ram Tarbuja subtypeSlots missing");
  const st = doc.subtypeSlots[stIdx];
  const byDay = new Map((st.slots || []).map((s) => [s.startDay, s]));
  const tmpl = st.slots?.[0] || null;
  const toAdd = [];
  for (const ymd of datesYmd) {
    const key = slotDate(ymd);
    const existing = byDay.get(key);
    if (existing && existing.endDay === key && slotIsActive(existing)) continue;
    if (existing && !slotIsActive(existing)) {
      if (execute) {
        await col.updateOne(
          { _id: slotDocId },
          { $set: { [`subtypeSlots.${stIdx}.slots.$[sl].status`]: true } },
          { arrayFilters: [{ "sl.startDay": key }] }
        );
        console.log(`Activated slot ${key}`);
      }
      continue;
    }
    if (!existing) toAdd.push(emptyDaySlot(key, tmpl));
  }
  if (!toAdd.length) return [];
  if (!execute) {
    console.log(`Would create ${toAdd.length} day slot(s): ${toAdd.map((s) => s.startDay).join(", ")}`);
    return toAdd.map((s) => s.startDay);
  }
  await col.updateOne(
    { _id: slotDocId, "subtypeSlots.subtypeId": subtypeOid },
    { $push: { "subtypeSlots.$.slots": { $each: toAdd } } }
  );
  console.log(`Created ${toAdd.length} day slot(s): ${toAdd.map((s) => s.startDay).join(", ")}`);
  return toAdd.map((s) => s.startDay);
}

async function createOrderViaDb({
  farmer,
  row,
  slotId,
  rate,
  salesPersonId,
  cavityId,
}) {
  const raising = row.seedSource === "RAISING";
  const packets = Math.ceil(row.qty / 100);
  const marker = markerFor(row);
  const nextOrderId = await allocateNextOrderId(Order);
  const slotOid = new mongoose.Types.ObjectId(slotId);
  const order = await Order.create({
    orderId: nextOrderId,
    farmer: farmer._id,
    salesPerson: new mongoose.Types.ObjectId(salesPersonId),
    plantName: new mongoose.Types.ObjectId(PLANT_ID),
    plantSubtype: new mongoose.Types.ObjectId(SUBTYPE_ID),
    bookingSlot: slotOid,
    cavity: new mongoose.Types.ObjectId(cavityId),
    numberOfPlants: row.qty,
    additionalPlants: 0,
    totalPlants: row.qty,
    remainingPlants: row.qty,
    rate,
    orderStatus: "ACCEPTED",
    payment: [],
    paymentStatus: "not paid",
    orderPaymentStatus: "PENDING",
    deliveryDate: new Date(deliveryDateUtc(row.date)),
    orderBookingDate: new Date(),
    sowingDone: false,
    sowingPlan: {
      seedSource: row.seedSource,
      companySeedPackets: raising ? 0 : packets,
      raisingSeedPackets: raising ? packets : 0,
      sowingNotes: raising ? "dispatch scenario raising" : "dispatch scenario company",
    },
    orderRemarks: [marker, `Dispatch scenario ${row.case} delivery ${row.date}`, "created-via-db-fallback"],
  });
  await PlantSlot.updateOne(
    { "subtypeSlots.slots._id": slotOid },
    {
      $inc: { "subtypeSlots.$[st].slots.$[sl].totalBookedPlants": row.qty },
      $addToSet: { "subtypeSlots.$[st].slots.$[sl].orders": order._id },
    },
    { arrayFilters: [{ "st.slots._id": slotOid }, { "sl._id": slotOid }] }
  );
  console.log(`DB-FALLBACK created order #${order.orderId}`);
  return order.toObject();
}

export async function createOrderViaApi({
  apiBase,
  token,
  farmer,
  row,
  slotId,
  rate,
  salesPersonId,
  cavityId,
  allowDbFallback = false,
}) {
  const raising = row.seedSource === "RAISING";
  const packets = Math.ceil(row.qty / 100);
  const marker = markerFor(row);
  const payload = {
    name: farmer.name,
    village: farmer.village,
    taluka: farmer.taluka,
    district: farmer.district,
    state: farmer.state,
    stateName: farmer.stateName,
    talukaName: farmer.talukaName,
    districtName: farmer.districtName,
    mobileNumber: String(MOBILE_NUMBER),
    numberOfPlants: row.qty,
    rate,
    paymentStatus: "not paid",
    salesPerson: salesPersonId,
    orderStatus: "ACCEPTED",
    plantName: PLANT_ID,
    plantSubtype: SUBTYPE_ID,
    bookingSlot: slotId,
    cavity: cavityId,
    deliveryDate: deliveryDateUtc(row.date),
    orderBookingDate: new Date().toISOString(),
    orderPaymentStatus: "PENDING",
    sowingPlan: {
      seedSource: row.seedSource,
      companySeedPackets: raising ? 0 : packets,
      raisingSeedPackets: raising ? packets : 0,
      sowingNotes: raising ? "dispatch scenario raising" : "dispatch scenario company",
    },
    orderRemarks: [marker, `Dispatch scenario ${row.case} delivery ${row.date}`],
  };
  let response;
  try {
    response = await fetch(`${apiBase}/api/v1/farmer/createFarmer`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    if (allowDbFallback) {
      console.warn(`API unreachable (${err.message}); using DB fallback for ${marker}`);
      return createOrderViaDb({ farmer, row, slotId, rate, salesPersonId, cavityId });
    }
    throw err;
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body?.status === "Error" || body?.success === false) {
    throw new Error(
      `${marker} create failed (HTTP ${response.status}): ${body?.message || body?.error || JSON.stringify(body)}`
    );
  }
  const orderDoc = body?.data?.order;
  if (!orderDoc?._id && !orderDoc?.orderId) throw new Error(`${marker} returned no order`);
  return orderDoc;
}

export async function findExistingOrder(ordersCol, marker) {
  return ordersCol.findOne(
    { orderRemarks: marker },
    {
      projection: {
        _id: 1,
        orderId: 1,
        sowingDone: 1,
        orderStatus: 1,
        numberOfPlants: 1,
        additionalPlants: 1,
        deliveryDate: 1,
        sowingCoverSources: 1,
        sowingDoneRequestId: 1,
      },
    }
  );
}

export async function findExistingSow(notesTag) {
  return SowingRequest.findOne({
    notes: { $regex: notesTag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") },
  })
    .select("_id requestNumber sowedQuantity sowingCompleted linkedOrderIds isExcessiveSowing")
    .lean();
}

export async function completeSowForOrders({
  adminId,
  plant,
  subtype,
  readyYmd,
  sowYmd,
  plants,
  orderObjectIds,
  caseName,
  isExcessive = false,
}) {
  const notesTag = sowMarker(caseName, readyYmd);
  const existing = await findExistingSow(notesTag);
  if (existing?.sowingCompleted) {
    return { skipped: true, requestNumber: existing.requestNumber, requestId: existing._id, notesTag };
  }

  const sowedAt = parseLocalDate(sowYmd);
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
    requestedBy: adminId,
    issuedBy: adminId,
    issuedDate: sowedAt,
    notes: `${notesTag} · ready ${readyYmd}`,
    linkedSlotIds: [],
    linkedOrderIds: orderObjectIds,
    isExcessiveSowing: isExcessive,
    seedSource: "COMPANY",
    packetsFromCompany: 0,
    packetsFromRaising: 0,
    packetsIssued: 0,
    packetsUsed: 0,
    packetsReturned: 0,
    sowedQuantity: plants,
    laboursLadies: 0,
    laboursGents: 0,
    shedName: SHED,
    completionNotes: notesTag,
    completedBy: adminId,
    sowingCompleted: true,
    sowingCompletedDate: sowedAt,
    sowingInProgress: false,
    remainingSowingNeeded: 0,
    completionEvents: [],
  });

  const slotResult = await applyPlantsToLinkedSlots(request, plants, {
    packetsUsed: 0,
    requestNumber,
    linkedOrderIds: orderObjectIds,
    isExcessiveSowing: isExcessive,
    shedName: SHED,
    sowedAt,
    plantReadyDays: READY_DAYS,
    resolveByReadyDate: true,
    userId: adminId,
  });

  const orderResult = await markOrdersSowed(request, {
    sowedAt,
    plantsSowed: plants,
    plantReadyDays: READY_DAYS,
    orderIds: orderObjectIds,
  });

  const excessPlants = Math.max(0, Number(orderResult.remainingUncovered) || 0);
  const orderCoveredPlants = Math.max(0, plants - excessPlants);
  if (slotResult.appliedSlotId) {
    await recordExcessPlantsOnSlot(
      slotResult.appliedSlotId,
      request._id,
      excessPlants,
      orderCoveredPlants,
      orderResult.markedIds || orderObjectIds
    );
  }

  pushEvent(request, {
    type: "SOW_COMPLETED",
    by: adminId,
    quantity: plants,
    unit: "plants",
    message: `${caseName}: ${plants} plants ready ${readyYmd}`,
    meta: { tag: BATCH_ID, case: caseName, readyDate: readyYmd, orderCoveredPlants, excessPlants },
  });
  if (orderResult.marked) {
    pushEvent(request, {
      type: "ORDERS_MARKED_SOWED",
      by: adminId,
      quantity: orderResult.marked,
      unit: "orders",
      message: `${orderResult.marked} orders marked`,
    });
  }
  await request.save();

  return {
    skipped: false,
    requestNumber,
    requestId: request._id,
    appliedSlotId: slotResult.appliedSlotId,
    plantReadyDate: slotResult.plantReadyDate || fmtDDMMYYYY(parseLocalDate(readyYmd)),
    ordersMarked: orderResult.marked,
    excessPlants,
    orderCoveredPlants,
    notesTag,
  };
}

/**
 * Raise excess on an already-completed order sow batch (idempotent to targetExcess).
 * Keeps orderCoveredPlants; grows plantsSowed + saleable available.
 */
export async function ensureOrderSowExcess(requestNumber, targetExcess, coveredOverride = null) {
  const want = Math.max(0, Math.floor(Number(targetExcess) || 0));
  if (!want) return { skipped: true, reason: "no excess target" };
  const request = await SowingRequest.findOne({ requestNumber });
  if (!request) return { skipped: true, reason: "request missing" };
  const rows = await findSowBatchForRequest(request._id);
  if (!rows.length) return { skipped: true, reason: "no batch" };
  const row = rows[0];
  const batch = row.batch || {};
  const slotId = new mongoose.Types.ObjectId(row.slotId);
  const covered =
    coveredOverride != null
      ? Math.max(0, Math.floor(Number(coveredOverride) || 0))
      : Math.max(0, Math.floor(Number(batch.orderCoveredPlants) || 0));
  const oldExcess = Math.max(0, Math.floor(Number(batch.excessPlants) || 0));
  if (oldExcess >= want) {
    return {
      skipped: true,
      requestNumber,
      reason: "already has excess",
      excessPlants: oldExcess,
    };
  }
  const oldTotal = Math.max(0, Math.floor(Number(batch.plantsSowed) || 0));
  const newExcess = want;
  const newTotal = covered + newExcess;
  const oldImpact = sowQtySlotImpact(oldTotal, {
    excessPlants: oldExcess,
    orderCoveredPlants: covered,
  });
  const newImpact = sowQtySlotImpact(newTotal, {
    excessPlants: newExcess,
    orderCoveredPlants: covered,
  });
  const plantsDelta = newTotal - oldTotal;
  const availDelta = newImpact.availablePlants - oldImpact.availablePlants;
  const reservedDelta = newImpact.orderReservedPlants - oldImpact.orderReservedPlants;
  const actualDelta = newImpact.actualPlants - oldImpact.actualPlants;
  const mortDelta = newImpact.expectedMortality - oldImpact.expectedMortality;

  await PlantSlot.updateOne(
    { "subtypeSlots.slots._id": slotId },
    {
      $inc: {
        "subtypeSlots.$[st].slots.$[sl].primarySowed": plantsDelta,
        "subtypeSlots.$[st].slots.$[sl].plantsSowed": plantsDelta,
        "subtypeSlots.$[st].slots.$[sl].totalPlants": plantsDelta,
        "subtypeSlots.$[st].slots.$[sl].actualPlants": actualDelta,
        "subtypeSlots.$[st].slots.$[sl].expectedMortality": mortDelta,
        "subtypeSlots.$[st].slots.$[sl].availablePlants": availDelta,
        "subtypeSlots.$[st].slots.$[sl].excessiveSowing.plants": availDelta,
        "subtypeSlots.$[st].slots.$[sl].orderReservedPlants": reservedDelta,
        "subtypeSlots.$[st].slots.$[sl].sowingBatches.$[b].plantsSowed": plantsDelta,
      },
      $set: {
        "subtypeSlots.$[st].slots.$[sl].sowingBatches.$[b].orderCoveredPlants": covered,
        "subtypeSlots.$[st].slots.$[sl].sowingBatches.$[b].excessPlants": newExcess,
        "subtypeSlots.$[st].slots.$[sl].sowingBatches.$[b].actualPlantsApplied":
          newImpact.actualPlants,
        "subtypeSlots.$[st].slots.$[sl].sowingBatches.$[b].expectedMortalityApplied":
          newImpact.expectedMortality,
        "subtypeSlots.$[st].slots.$[sl].sowingBatches.$[b].availablePlantsApplied":
          newImpact.availablePlants,
        "subtypeSlots.$[st].slots.$[sl].sowingBatches.$[b].orderReservedPlantsApplied":
          newImpact.orderReservedPlants,
      },
    },
    {
      arrayFilters: [
        { "st.slots._id": slotId },
        { "sl._id": slotId },
        { "b.sowingRequestId": request._id },
      ],
    }
  );
  request.sowedQuantity = newTotal;
  pushEvent(request, {
    type: "NOTE",
    by: null,
    quantity: newExcess - oldExcess,
    unit: "plants",
    message: `Dispatch scenario: set order-sow excess ${oldExcess} → ${newExcess}`,
    meta: { tag: BATCH_ID, fromExcess: oldExcess, toExcess: newExcess, covered },
  });
  await request.save();
  return {
    skipped: false,
    requestNumber,
    readyDate: batch.plantReadyDate || row.startDay,
    plantsSowed: newTotal,
    orderCoveredPlants: covered,
    excessPlants: newExcess,
  };
}
