/**
 * Dummy Ram Tarbuja orders, each covered by its own sowing.
 * Ready date and delivery are yesterday, today, and tomorrow.
 * Sow is 18 days earlier. Leftover after 12% mortality is excess.
 *
 *   node scripts/create-dummy-ram-tarbuja-cover-nov2026.js
 *   node scripts/create-dummy-ram-tarbuja-cover-nov2026.js --fresh
 */
import dotenv from "dotenv";
import mongoose from "mongoose";
import path from "path";
import { fileURLToPath } from "url";
import Order from "../models/order.model.js";
import SowingRequest from "../models/sowingRequest.model.js";
import SowingEntry from "../models/sowingEntry.model.js";
import {
  applyPlantsToLinkedSlots,
  markOrdersSowed,
  recordExcessPlantsOnSlot,
  pushEvent,
} from "../controllers/sowingCompleteHelpers.js";
import { parseLocalDate, fmtDDMMYYYY } from "../controllers/sowingSlotReadyHelpers.js";
import { plantMortalityPct } from "../utility/plantSowingBuffer.js";
import { sowCoverPool } from "../utility/lagwadSlotPlantsSplit.js";
import { toSowingEntryListItem } from "../modules/sowingEntries/mapSowingEntry.js";
import { linkedOrdersForEntry, attributedOrderPlants } from "../modules/sowingEntries/linkedOrdersForEntry.js";
import {
  MOBILE_NUMBER,
  PLANT_ID,
  SUBTYPE_ID,
  SALES_PERSON_ID,
  CAVITY_ID,
  READY_DAYS,
  slotDate,
  slotIsActive,
  createAccessToken,
  ensureDaySlots,
  findExistingOrder,
} from "./lib/ramTarbujaDispatchScenarioHelpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const SHED = "Dummy Cover";
const FRESH = process.argv.includes("--fresh");
const MARK = FRESH ? "DUMMY-RAM-TARBUJA-FRESH-NOV2026" : "DUMMY-RAM-TARBUJA-COVER-NOV2026";
const ROWS = FRESH
  ? [
      { label: "6 Nov", ready: "2026-11-06", sow: "2026-10-19", qty: 800, plants: 1200 },
      { label: "7 Nov", ready: "2026-11-07", sow: "2026-10-20", qty: 900, plants: 1400 },
      { label: "8 Nov", ready: "2026-11-08", sow: "2026-10-21", qty: 700, plants: 1100 },
      { label: "9 Nov", ready: "2026-11-09", sow: "2026-10-22", qty: 1000, plants: 1500 },
    ]
  : [
      { label: "yesterday", ready: "2026-11-04", sow: "2026-10-17", qty: 600, plants: 1000 },
      { label: "today", ready: "2026-11-05", sow: "2026-10-18", qty: 1000, plants: 1500 },
      { label: "tomorrow", ready: "2026-11-06", sow: "2026-10-19", qty: 1000, plants: 1800 },
      { label: "7 Nov", ready: "2026-11-07", sow: "2026-10-20", qty: 800, plants: 1200 },
      { label: "8 Nov", ready: "2026-11-08", sow: "2026-10-21", qty: 900, plants: 1400 },
      { label: "9 Nov", ready: "2026-11-09", sow: "2026-10-22", qty: 700, plants: 1100 },
    ];

function markerFor(row) {
  return `${MARK}:${row.ready}`;
}

function istMidnightIso(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 0, 0, 0) - 5.5 * 60 * 60 * 1000).toISOString();
}

async function createOrder({ apiBase, token, farmer, row, slotId, rate, salesPersonId, cavityId }) {
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
    deliveryDate: istMidnightIso(row.ready),
    orderBookingDate: new Date().toISOString(),
    orderPaymentStatus: "PENDING",
    sowingPlan: {
      seedSource: "COMPANY",
      companySeedPackets: packets,
      raisingSeedPackets: 0,
      sowingNotes: `dummy cover ${row.label}`,
    },
    orderRemarks: [marker, `Dummy Ram Tarbuja ${row.label} delivery ${row.ready}`],
  };
  const response = await fetch(`${apiBase}/api/v1/farmer/createFarmer`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
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

async function sowOne({ adminId, plant, subtype, row, order }) {
  const notesTag = `${MARK}:SOW:${row.ready}`;
  const existing = await SowingRequest.findOne({ notes: { $regex: notesTag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") } })
    .select("_id requestNumber sowingCompleted")
    .lean();
  if (existing?.sowingCompleted) {
    return { skipped: true, requestNumber: existing.requestNumber };
  }

  const sowedAt = parseLocalDate(row.sow);
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
    notes: `${notesTag} · ready ${row.ready}`,
    linkedSlotIds: [],
    linkedOrderIds: [order._id],
    isExcessiveSowing: false,
    seedSource: "COMPANY",
    packetsFromCompany: 0,
    packetsFromRaising: 0,
    packetsIssued: 0,
    packetsUsed: 0,
    packetsReturned: 0,
    sowedQuantity: row.plants,
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

  const slotResult = await applyPlantsToLinkedSlots(request, row.plants, {
    packetsUsed: 0,
    requestNumber,
    linkedOrderIds: [order._id],
    isExcessiveSowing: false,
    shedName: SHED,
    sowedAt,
    plantReadyDays: READY_DAYS,
    resolveByReadyDate: true,
    userId: adminId,
  });

  const orderResult = await markOrdersSowed(request, {
    sowedAt,
    plantsSowed: row.plants,
    plantReadyDays: READY_DAYS,
    orderIds: [order._id],
  });

  const excessPlants = Math.max(0, Number(orderResult.remainingUncovered) || 0);
  const orderCoveredPlants = Math.max(0, Number(orderResult.orderPlantsCovered) || 0);
  if (slotResult.appliedSlotId) {
    await recordExcessPlantsOnSlot(
      slotResult.appliedSlotId,
      request._id,
      excessPlants,
      orderCoveredPlants,
      orderResult.batchLinkedIds || [order._id]
    );
  }

  pushEvent(request, {
    type: "SOW_COMPLETED",
    by: adminId,
    quantity: row.plants,
    unit: "plants",
    message: `${row.label}: ${row.plants} plants ready ${row.ready}`,
    meta: { tag: MARK, readyDate: row.ready, orderCoveredPlants, excessPlants },
  });
  await request.save();

  return {
    skipped: false,
    requestNumber,
    plantReadyDate: slotResult.plantReadyDate || fmtDDMMYYYY(parseLocalDate(row.ready)),
    orderCoveredPlants,
    excessPlants,
    ordersMarked: orderResult.marked,
  };
}

async function main() {
  const mongoUrl = process.env.PROD_MONGO_URL;
  if (!mongoUrl) throw new Error("PROD_MONGO_URL is missing");
  const apiBase = (process.env.API_BASE_URL || "https://api1.rambiotechplants.com").replace(/\/$/, "");
  await mongoose.connect(mongoUrl, { serverSelectionTimeoutMS: 20000 });
  const db = mongoose.connection.db;

  const plantOid = new mongoose.Types.ObjectId(PLANT_ID);
  const subtypeOid = new mongoose.Types.ObjectId(SUBTYPE_ID);
  const [farmer, plantDoc, authUser, slotDoc] = await Promise.all([
    db.collection("farmers").findOne({ mobileNumber: MOBILE_NUMBER }),
    db.collection("plantcms").findOne({ _id: plantOid, "subtypes._id": subtypeOid }),
    db.collection("users").findOne({
      isDisabled: { $ne: true },
      $or: [{ role: "SUPER_ADMIN" }, { jobTitle: "SUPER_ADMIN" }],
    }),
    db.collection("plantslots").findOne({
      plantId: plantOid,
      year: 2026,
      "subtypeSlots.subtypeId": subtypeOid,
    }),
  ]);
  if (!farmer) throw new Error("Dummy farmer not found");
  if (!plantDoc) throw new Error("Ram Tarbuja not found");
  if (!authUser) throw new Error("No active SUPER_ADMIN");
  if (!slotDoc) throw new Error("Ram Tarbuja 2026 slots not found");

  const pct = plantMortalityPct(plantDoc);
  if (pct !== 12) throw new Error(`Watermelon mortality is ${pct}, expected 12`);

  for (const row of ROWS) {
    const saleable = sowCoverPool(row.plants, pct);
    const excess = saleable - row.qty;
    if (excess < 1 || saleable < row.qty) {
      throw new Error(`${row.label} saleable ${saleable} does not cover ${row.qty}`);
    }
  }

  let salesPerson = await db.collection("users").findOne({
    _id: new mongoose.Types.ObjectId(SALES_PERSON_ID),
    isDisabled: { $ne: true },
  });
  if (!salesPerson) {
    salesPerson = await db.collection("users").findOne({
      isDisabled: { $ne: true },
      $or: [{ role: "SALES" }, { jobTitle: "SALES" }],
    });
  }
  let cavity = await db.collection("trays").findOne({ _id: new mongoose.Types.ObjectId(CAVITY_ID) });
  if (!cavity) cavity = await db.collection("trays").findOne({ cavity: 126 });
  if (!salesPerson) throw new Error("Sales person missing");
  if (!cavity) throw new Error("126 cavity tray not found");

  const subtype = plantDoc.subtypes.find((row) => String(row._id) === SUBTYPE_ID);
  const rate = Number(subtype.rates?.[0]);
  if (!(rate > 0)) throw new Error("Ram Tarbuja company rate missing");

  await ensureDaySlots(db, slotDoc._id, subtypeOid, ROWS.map((row) => row.ready), true);
  const freshSlots = await db.collection("plantslots").findOne({ _id: slotDoc._id });
  const subtypeSlots = freshSlots.subtypeSlots.find((row) => String(row.subtypeId) === SUBTYPE_ID);
  const slotsByDate = new Map((subtypeSlots?.slots || []).map((slot) => [slot.startDay, slot]));

  console.log(`prod · ${farmer.name} · ${plantDoc.name} / ${subtype.name} · mortality ${pct}%`);
  const token = createAccessToken(authUser);
  const ordersCol = db.collection("orders");

  for (const row of ROWS) {
    const slot = slotsByDate.get(slotDate(row.ready));
    if (!slot || !slotIsActive(slot)) throw new Error(`No active slot for ${row.ready}`);
    const marker = markerFor(row);
    let existing = await findExistingOrder(ordersCol, marker);
    let order = existing ? await Order.findById(existing._id).lean() : null;
    if (!order) {
      const created = await createOrder({
        apiBase,
        token,
        farmer,
        row,
        slotId: String(slot._id),
        rate,
        salesPersonId: String(salesPerson._id),
        cavityId: String(cavity._id),
      });
      order =
        (await Order.findById(created._id || created.id).lean()) ||
        (await Order.findOne({ orderId: created.orderId }).lean());
      if (!order) throw new Error(`Could not reload ${marker}`);
      console.log(`CREATED #${order.orderId} ${row.label} qty=${row.qty} delivery=${row.ready}`);
    } else {
      console.log(`SKIP order #${order.orderId} ${row.label}`);
    }

    const sow = await sowOne({
      adminId: authUser._id,
      plant: { _id: plantDoc._id, name: plantDoc.name },
      subtype: { _id: subtype._id, name: subtype.name },
      row,
      order,
    });
    console.log(
      sow.skipped
        ? `SKIP sow ${row.label} ${sow.requestNumber}`
        : `SOWED ${row.label} #${order.orderId} ${sow.requestNumber} ready=${sow.plantReadyDate} cover=${sow.orderCoveredPlants} excess=${sow.excessPlants} marked=${sow.ordersMarked}`
    );
  }

  const tagged = await Order.find({ orderRemarks: { $regex: `^${MARK}:` } })
    .select("_id orderId numberOfPlants additionalPlants deliveryDate sowingDone sowingCoverSources sowingDoneRequestId orderRemarks")
    .lean();
  console.log("\n=== ORDERS ===");
  for (const order of tagged.sort((a, b) => a.orderId - b.orderId)) {
    const delivery = new Date(order.deliveryDate).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    const source = (order.sowingCoverSources || [])
      .map((src) => `${src.requestNumber}:${src.plants}`)
      .join(", ");
    console.log(`#${order.orderId} qty=${order.numberOfPlants} delivery=${delivery} done=${order.sowingDone} source=${source || "-"}`);
  }

  const requestIds = tagged.flatMap((order) => (order.sowingCoverSources || []).map((src) => src.sowingRequestId)).filter(Boolean);
  const entries = await SowingEntry.find({ sowingRequestId: { $in: requestIds } }).lean();
  console.log("\n=== SOWING ENTRIES ===");
  for (const entry of entries.sort((a, b) => String(a.sowDay).localeCompare(String(b.sowDay)))) {
    const item = toSowingEntryListItem(entry, attributedOrderPlants(entry, tagged));
    const cards = linkedOrdersForEntry(entry, tagged);
    console.log(
      `${item.requestNumber} sow=${item.sowingDate} ready=${item.plantReadyDate} sowed=${item.sowedQuantity} cover=${item.bookedPlants} excess=${item.excessPlants} drawer=${cards.map((card) => `#${card.orderNumber}:${card.sownHere}/${card.remaining}`).join(" ")}`
    );
  }
}

main()
  .catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });
