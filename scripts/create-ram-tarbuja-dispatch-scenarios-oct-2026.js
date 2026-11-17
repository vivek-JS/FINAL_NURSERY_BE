/**
 * Seed Ram Tarbuja (Watermelon) dispatch scenarios for Oct 17–22, 2026.
 *
 * Cases: exact able-day sow, multi-order one batch, free excess, unsown
 * orders, excess-then-cover, READY_FOR_DISPATCH.
 *
 *   node scripts/create-ram-tarbuja-dispatch-scenarios-oct-2026.js --local
 *   node scripts/create-ram-tarbuja-dispatch-scenarios-oct-2026.js --prod
 *   node scripts/create-ram-tarbuja-dispatch-scenarios-oct-2026.js --local --execute
 *   node scripts/create-ram-tarbuja-dispatch-scenarios-oct-2026.js --prod --execute
 */
import dotenv from "dotenv";
import mongoose from "mongoose";
import path from "path";
import { fileURLToPath } from "url";
import { coverOrderFromBatches } from "../services/orderExcessBatchCover.service.js";
import { findSowBatchForRequest } from "../controllers/sowingCompleteHelpers.js";
import Order from "../models/order.model.js";
import {
  BATCH_ID,
  MOBILE_NUMBER,
  PLANT_ID,
  SUBTYPE_ID,
  SALES_PERSON_ID,
  CAVITY_ID,
  DATES,
  ORDER_ROWS,
  EXCESS_SOWS,
  markerFor,
  sowMarker,
  slotDate,
  slotIsActive,
  sowYmdForReady,
  createAccessToken,
  ensureRamSubtypeLocal,
  ensureDaySlots,
  createOrderViaApi,
  findExistingOrder,
  findExistingSow,
  completeSowForOrders,
} from "./lib/ramTarbujaDispatchScenarioHelpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const EXECUTE = process.argv.includes("--execute");
const USE_LOCAL = process.argv.includes("--local");
const USE_PROD = process.argv.includes("--prod");

function resolveEnv() {
  if (USE_LOCAL === USE_PROD) throw new Error("Pass exactly one of --local or --prod");
  if (USE_PROD) {
    if (!process.env.PROD_MONGO_URL) throw new Error("PROD_MONGO_URL is missing");
    return {
      label: "prod",
      mongoUrl: process.env.PROD_MONGO_URL,
      apiBase: (process.env.API_BASE_URL || "https://api1.rambiotechplants.com").replace(/\/$/, ""),
    };
  }
  const mongoUrl =
    process.env.MONGO_URL || process.env.STAGE_MONGO_URL || process.env.MONGODB_URI;
  if (!mongoUrl) throw new Error("MONGO_URL / MONGODB_URI is missing for --local");
  return {
    label: "local",
    mongoUrl,
    apiBase: (process.env.API_BASE_URL || `http://localhost:${process.env.PORT || "8000"}`).replace(
      /\/$/,
      ""
    ),
  };
}

function printVerification(verified) {
  console.log("\n=== VERIFICATION (orders) ===");
  console.log(
    "case".padEnd(18),
    "orderId".padEnd(10),
    "delivery".padEnd(12),
    "qty".padEnd(6),
    "status".padEnd(20),
    "sown".padEnd(6),
    "cover"
  );
  for (const o of verified) {
    const marker =
      (o.orderRemarks || []).find((r) => String(r).startsWith(`${BATCH_ID}:`)) || "";
    const caseName = String(marker).split(":")[1] || "?";
    const del = o.deliveryDate
      ? new Date(o.deliveryDate).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" })
      : "?";
    const cover = (o.sowingCoverSources || []).length
      ? `cover×${o.sowingCoverSources.length}`
      : o.sowingDoneRequestId
        ? "req"
        : "-";
    console.log(
      caseName.padEnd(18),
      String(o.orderId).padEnd(10),
      del.padEnd(12),
      String(o.numberOfPlants).padEnd(6),
      String(o.orderStatus || "").padEnd(20),
      (o.sowingDone ? "yes" : "no").padEnd(6),
      cover
    );
  }
}

async function main() {
  const env = resolveEnv();
  await mongoose.connect(env.mongoUrl, { serverSelectionTimeoutMS: 20000 });
  const db = mongoose.connection.db;

  if (USE_LOCAL) await ensureRamSubtypeLocal(db);

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

  let salesPerson = await db
    .collection("users")
    .findOne({ _id: new mongoose.Types.ObjectId(SALES_PERSON_ID), isDisabled: { $ne: true } });
  if (!salesPerson) {
    salesPerson = await db.collection("users").findOne({
      isDisabled: { $ne: true },
      $or: [{ role: "SALES" }, { jobTitle: "SALES" }, { role: "PRIMARY" }, { jobTitle: "PRIMARY" }],
    });
  }
  let cavity = await db.collection("trays").findOne({ _id: new mongoose.Types.ObjectId(CAVITY_ID) });
  if (!cavity) cavity = await db.collection("trays").findOne({ cavity: 126 });

  if (!farmer) throw new Error(`Farmer ${MOBILE_NUMBER} not found`);
  if (!plantDoc) throw new Error("Watermelon / Ram Tarbuja subtype not found");
  if (!salesPerson) throw new Error("Sales person missing/disabled");
  if (!cavity) throw new Error("126 cavity tray not found");
  if (!authUser) throw new Error("No active SUPER_ADMIN available");
  if (!slotDoc) throw new Error("Ram Tarbuja 2026 slot document not found");

  const salesPersonId = String(salesPerson._id);
  const cavityId = String(cavity._id);
  if (salesPersonId !== SALES_PERSON_ID || cavityId !== CAVITY_ID) {
    console.log(
      `Using salesPerson=${salesPerson.name} (${salesPersonId}) cavity=${cavity.name || cavity.cavity}`
    );
  }

  const subtype = plantDoc.subtypes.find((r) => String(r._id) === SUBTYPE_ID);
  await ensureDaySlots(db, slotDoc._id, subtypeOid, DATES, EXECUTE);

  const freshSlots = await db.collection("plantslots").findOne({ _id: slotDoc._id });
  const subtypeSlots = freshSlots.subtypeSlots.find((r) => String(r.subtypeId) === SUBTYPE_ID);
  const slotsByDate = new Map((subtypeSlots?.slots || []).map((s) => [s.startDay, s]));

  for (const date of DATES) {
    const slot = slotsByDate.get(slotDate(date));
    if (!slot || slot.endDay !== slotDate(date) || !slotIsActive(slot)) {
      if (!EXECUTE) {
        console.log(`DRY RUN: slot ${date} not ready yet (will create on --execute)`);
        continue;
      }
      throw new Error(`No active exact-day slot for ${date}`);
    }
  }

  console.log(
    `${EXECUTE ? "EXECUTE" : "DRY RUN"} · ${env.label} · ${farmer.name} (${MOBILE_NUMBER}) · ${plantDoc.name} / ${subtype.name}`
  );
  console.log(`API ${env.apiBase}`);

  const ordersCol = db.collection("orders");
  const preflight = [];
  for (const row of ORDER_ROWS) {
    const marker = markerFor(row);
    const existing = await findExistingOrder(ordersCol, marker);
    const slot = slotsByDate.get(slotDate(row.date));
    const raising = row.seedSource === "RAISING";
    const rate = raising ? Number(subtype.raisingRate) : Number(subtype.rates?.[0]);
    preflight.push({
      ...row,
      marker,
      slotId: slot ? String(slot._id) : null,
      rate,
      existingOrderId: existing?.orderId ?? null,
      existingMongoId: existing?._id ? String(existing._id) : null,
      sowYmd: sowYmdForReady(row.date),
    });
    console.log(
      `${row.case.padEnd(18)} ${row.date} qty=${row.qty} sow=${row.sow || "none"}` +
        (existing?.orderId ? ` SKIP(#${existing.orderId})` : " CREATE")
    );
  }
  for (const excess of EXCESS_SOWS) {
    const existing = await findExistingSow(sowMarker(excess.case, excess.readyDate));
    console.log(
      `${excess.case.padEnd(18)} ready=${excess.readyDate} plants=${excess.plants}` +
        (existing ? ` SKIP(${existing.requestNumber})` : " CREATE")
    );
  }

  if (!EXECUTE) {
    console.log("\nNo writes performed. Pass --execute to create orders + sowings.");
    return;
  }

  const token = createAccessToken(authUser);
  const adminId = authUser._id;
  const plant = { _id: plantDoc._id, name: plantDoc.name };
  const subtypeObj = { _id: subtype._id, name: subtype.name };
  const orderByMarker = new Map();
  const createdOrderIds = [];
  const skippedOrderIds = [];

  for (const row of preflight) {
    if (!row.slotId) throw new Error(`Missing slot for ${row.date}`);
    let order = row.existingMongoId ? await Order.findById(row.existingMongoId).lean() : null;
    if (!order) {
      const created = await createOrderViaApi({
        apiBase: env.apiBase,
        token,
        farmer,
        row,
        slotId: row.slotId,
        rate: row.rate,
        salesPersonId,
        cavityId,
        allowDbFallback: USE_LOCAL,
      });
      order =
        (await Order.findById(created._id || created.id).lean()) ||
        (await Order.findOne({ orderId: created.orderId }).lean());
      if (!order) throw new Error(`Could not reload order for ${row.marker}`);
      createdOrderIds.push(order.orderId);
      console.log(`CREATED order #${order.orderId} ${row.marker}`);
    } else {
      skippedOrderIds.push(order.orderId);
    }
    if (row.status === "READY_FOR_DISPATCH" && order.orderStatus !== "READY_FOR_DISPATCH") {
      await Order.updateOne({ _id: order._id }, { $set: { orderStatus: "READY_FOR_DISPATCH" } });
      order = { ...order, orderStatus: "READY_FOR_DISPATCH" };
      console.log(`STATUS #${order.orderId} -> READY_FOR_DISPATCH`);
    }
    orderByMarker.set(row.marker, order);
  }

  const sowResults = [];

  for (const excess of EXCESS_SOWS) {
    const result = await completeSowForOrders({
      adminId,
      plant,
      subtype: subtypeObj,
      readyYmd: excess.readyDate,
      sowYmd: sowYmdForReady(excess.readyDate),
      plants: excess.plants,
      orderObjectIds: [],
      caseName: excess.case,
      isExcessive: true,
    });
    sowResults.push({ case: excess.case, readyDate: excess.readyDate, ...result });
    console.log(
      result.skipped
        ? `SKIP sow ${excess.case} ${result.requestNumber}`
        : `SOWED ${excess.case} ${result.requestNumber} excess=${result.excessPlants}`
    );
  }

  for (const row of preflight) {
    if (row.sow !== "exact") continue;
    const order = orderByMarker.get(row.marker);
    if (!order) continue;
    if (order.sowingDone) {
      sowResults.push({ case: row.case, readyDate: row.date, skipped: true, orderId: order.orderId });
      continue;
    }
    const sowPlants = row.qty + (Number(row.excessSow) || 0);
    const result = await completeSowForOrders({
      adminId,
      plant,
      subtype: subtypeObj,
      readyYmd: row.date,
      sowYmd: row.sowYmd,
      plants: sowPlants,
      orderObjectIds: [order._id],
      caseName: `${row.case}_${row.date}`,
      isExcessive: false,
    });
    sowResults.push({ case: row.case, readyDate: row.date, orderId: order.orderId, ...result });
    console.log(
      result.skipped
        ? `SKIP sow ${row.case} #${order.orderId}`
        : `SOWED ${row.case} #${order.orderId} ${result.requestNumber} ready=${result.plantReadyDate} plants=${sowPlants} excess=${result.excessPlants}`
    );
  }

  const multiRows = preflight.filter((r) => r.sow === "multi" && r.sowGroup === "MULTI_19");
  if (multiRows.length) {
    const multiOrders = multiRows.map((r) => orderByMarker.get(r.marker)).filter(Boolean);
    const unsown = multiOrders.filter((o) => !o.sowingDone);
    const orderNeed = unsown.reduce(
      (s, o) => s + (Number(o.numberOfPlants) || 0) + (Number(o.additionalPlants) || 0),
      0
    );
    const multiExcess = multiRows.reduce((s, r) => s + (Number(r.excessSow) || 0), 0);
    const plants = orderNeed + multiExcess;
    const readyYmd = "2026-10-19";
    if (!unsown.length) {
      console.log("SKIP MULTI_SOW_COVER (already sowed)");
      sowResults.push({ case: "MULTI_SOW_COVER", skipped: true });
    } else {
      const result = await completeSowForOrders({
        adminId,
        plant,
        subtype: subtypeObj,
        readyYmd,
        sowYmd: sowYmdForReady(readyYmd),
        plants,
        orderObjectIds: unsown.map((o) => o._id),
        caseName: "MULTI_SOW_COVER",
        isExcessive: false,
      });
      sowResults.push({
        case: "MULTI_SOW_COVER",
        readyDate: readyYmd,
        orderIds: unsown.map((o) => o.orderId),
        ...result,
      });
      console.log(
        result.skipped
          ? `SKIP MULTI_SOW_COVER ${result.requestNumber}`
          : `SOWED MULTI_SOW_COVER ${result.requestNumber} orders=${unsown.map((o) => o.orderId).join(",")} plants=${plants}`
      );
    }
  }

  const coverRow = preflight.find((r) => r.sow === "cover_from_excess");
  if (coverRow) {
    const order = orderByMarker.get(coverRow.marker);
    if (order && !order.sowingDone) {
      const poolReq = await findExistingSow(sowMarker("EXCESS_THEN_ORDER_POOL", "2026-10-22"));
      if (!poolReq) throw new Error("EXCESS_THEN_ORDER_POOL sow missing");
      const batches = await findSowBatchForRequest(poolReq._id);
      const batchRow = batches[0];
      if (!batchRow?.batch?._id || !batchRow?.slotId) {
        throw new Error("EXCESS_THEN_ORDER_POOL batch not found on slot");
      }
      const need =
        (Number(order.numberOfPlants) || 0) + (Number(order.additionalPlants) || 0);
      const covered = await coverOrderFromBatches({
        order,
        picks: [
          {
            batchId: String(batchRow.batch._id),
            slotId: String(batchRow.slotId),
            plants: need,
          },
        ],
        userId: adminId,
      });
      sowResults.push({
        case: "EXCESS_THEN_ORDER",
        orderId: order.orderId,
        covered: true,
        sources: covered?.sources?.length || 0,
        requestNumber: poolReq.requestNumber,
      });
      console.log(`COVERED EXCESS_THEN_ORDER #${order.orderId} from ${poolReq.requestNumber}`);
    } else if (order?.sowingDone) {
      console.log(`SKIP EXCESS_THEN_ORDER #${order.orderId}`);
      sowResults.push({ case: "EXCESS_THEN_ORDER", orderId: order.orderId, skipped: true });
    }
  }

  const verified = await ordersCol
    .find(
      { orderRemarks: { $regex: `^${BATCH_ID}:` } },
      {
        projection: {
          orderId: 1,
          numberOfPlants: 1,
          deliveryDate: 1,
          orderStatus: 1,
          sowingDone: 1,
          sowingCoverSources: 1,
          sowingDoneRequestId: 1,
          orderRemarks: 1,
        },
      }
    )
    .sort({ deliveryDate: 1, orderId: 1 })
    .toArray();

  printVerification(verified);
  console.log("\n=== SOW SUMMARY ===");
  for (const s of sowResults) console.log(JSON.stringify(s));
  console.log(
    `\nDone · env=${env.label} · orders=${verified.length} · created=${createdOrderIds.length} · skippedOrders=${skippedOrderIds.length}`
  );
}

main()
  .catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });
