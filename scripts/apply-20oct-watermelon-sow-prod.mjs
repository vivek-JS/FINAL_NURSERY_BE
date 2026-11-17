/**
 * 20 Oct 2026 watermelon diary: cancel open packet requests, write sow entries.
 *   node scripts/apply-20oct-watermelon-sow-prod.mjs
 *   node scripts/apply-20oct-watermelon-sow-prod.mjs --apply
 */
import dotenv from "dotenv";
import mongoose from "mongoose";
import path from "path";
import { fileURLToPath } from "url";
import PlantCms from "../models/plantCms.model.js";
import Product from "../models/product.model.js";
import Order from "../models/order.model.js";
import SowingRequest from "../models/sowingRequest.model.js";
import { planOrderSowCover } from "../services/orderSowCover.plan.js";
import {
  pushEvent,
  applyPlantsToLinkedSlots,
  markOrdersSowed,
  recordExcessPlantsOnSlot,
} from "../controllers/sowingCompleteHelpers.js";
import {
  parseLocalDate,
  findSlotByPlantReadyDate,
  toSowYmd,
  addDays,
  fmtDDMMYYYY,
} from "../controllers/sowingSlotReadyHelpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const APPLY = process.argv.includes("--apply");
const TAG = "diary-20oct2026-watermelon";
const PLANT_ID = "691054dffba6fb380f8d57b3";
const ADMIN_ID = "6976c986299fa0215edc853d";
const HUNG = ["SR202610200004", "SR202610200002", "SR202610200003"];
const sowedAt = parseLocalDate("2026-10-20");
const plantReadyDays = 18;

const ROWS = [
  { variety: "Simbha", plants: 38808, packets: 38, orderIds: [4159, 4160] },
  { variety: "Redking", plants: 53171, packets: 50.5, orderIds: [4164, 4217, 4179] },
  { variety: "Redmaxx", plants: 27972, packets: 24, orderIds: [4182] },
  { variety: "Prachand", plants: 27846, packets: 25, orderIds: [], excessOnly: true },
];

function norm(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function plantsPerPacket(p) {
  const tpp = Number(p?.tentativePlantsPerPacket);
  if (Number.isFinite(tpp) && tpp > 0) return tpp;
  return Number(p?.conversionFactor) || 1;
}

function pickProduct(products, packets, plants) {
  if (!products.length) return null;
  return [...products].sort((a, b) => {
    const gap = (p) => Math.abs(plants - packets * plantsPerPacket(p));
    return gap(a) - gap(b);
  })[0];
}

async function loadRow(plant, row) {
  const orders = row.orderIds.length
    ? await Order.find({ orderId: { $in: row.orderIds } })
        .select(
          "_id orderId numberOfPlants additionalPlants plantSubtype bookingSlot sowingDone orderStatus deliveryDate sowingPartialCover"
        )
        .lean()
    : [];
  const found = new Set(orders.map((o) => o.orderId));
  const missing = row.orderIds.filter((id) => !found.has(id));
  const subtype =
    (plant.subtypes || []).find((s) =>
      orders.some((o) => String(o.plantSubtype) === String(s._id))
    ) ||
    (plant.subtypes || []).find((s) => norm(s.name) === norm(row.variety)) ||
    (plant.subtypes || []).find((s) => norm(s.name).includes(norm(row.variety)));
  const products = subtype
    ? await Product.find({
        plantId: plant._id,
        subtypeId: subtype._id,
        category: { $regex: /^seeds$/i },
        isActive: true,
      })
        .select("name code conversionFactor tentativePlantsPerPacket primaryUnit secondaryUnit")
        .lean()
    : [];
  const product = pickProduct(products, row.packets, row.plants);
  const ready = addDays(sowedAt, plantReadyDays);
  const readySlot = subtype
    ? await findSlotByPlantReadyDate(plant._id, subtype._id, ready)
    : null;
  const sorted = [...orders].sort(
    (a, b) =>
      new Date(a.deliveryDate || 0) - new Date(b.deliveryDate || 0) || a.orderId - b.orderId
  );
  const plan = row.excessOnly ? null : planOrderSowCover({ plantsSowed: row.plants, orders: sorted });
  const blockers = [];
  if (missing.length) blockers.push(`missing orders ${missing.join(",")}`);
  if (!subtype) blockers.push("subtype not found");
  if (!readySlot?.slotId) blockers.push("no 07-11-2026 slot");
  const already = orders.filter((o) => o.sowingDone).map((o) => o.orderId);
  if (already.length) blockers.push(`already sown ${already.join(",")}`);
  return { row, orders: sorted, subtype, product, readySlot, plan, blockers };
}

async function cancelHung(adminId) {
  const hung = await SowingRequest.find({
    requestNumber: { $in: HUNG },
    sowingCompleted: { $ne: true },
    status: { $nin: ["cancelled", "rejected"] },
  });
  const out = [];
  for (const r of hung) {
    if (r.outwardId && r.packetsIssued > 0) {
      out.push({ requestNumber: r.requestNumber, skipped: true, reason: "stock already issued" });
      continue;
    }
    if (APPLY) {
      r.status = "cancelled";
      r.sowingInProgress = false;
      r.cancelledBy = adminId;
      r.cancelledDate = new Date();
      r.cancellationReason = `${TAG} · open packet request cancelled; sow entered from diary`;
      await r.save();
    }
    out.push({
      requestNumber: r.requestNumber,
      subtypeName: r.subtypeName,
      packets: r.packetsRequested,
      cancelled: APPLY,
    });
  }
  return out;
}

async function applyLoaded({ plant, adminId, loaded }) {
  const { row, orders, subtype, product, readySlot } = loaded;
  const isExcessOnly = Boolean(row.excessOnly);
  const cf = plantsPerPacket(product);
  const linkedOrderObjectIds = orders.map((o) => o._id);
  const slotIds = [
    ...new Set(
      orders.map((o) => o.bookingSlot).filter(Boolean).map(String)
    ),
  ];
  if (readySlot?.slotId && !slotIds.includes(String(readySlot.slotId))) {
    slotIds.push(readySlot.slotId);
  }
  const notes = `${TAG} · ${subtype.name} · ${row.plants} plants · ${row.packets} pkt${
    isExcessOnly ? " · EXCESS" : ` · orders ${row.orderIds.join(",")}`
  }`;

  if (!APPLY) {
    return {
      dry: true,
      subtype: subtype.name,
      product: product ? `${product.name} (${product.code})` : null,
      plants: row.plants,
      packets: row.packets,
      orders: row.orderIds,
      excessPlants: isExcessOnly ? row.plants : loaded.plan?.excess,
      readySlot: readySlot
        ? `${readySlot.startDay} → ${readySlot.endDay}`
        : null,
    };
  }

  const requestNumber = await SowingRequest.generateRequestNumber();
  const request = new SowingRequest({
    requestNumber,
    plantId: plant._id,
    plantName: plant.name,
    subtypeId: subtype._id,
    subtypeName: subtype.name,
    ...(product?._id ? { productId: product._id } : {}),
    packetsNeeded: row.packets,
    packetsRequested: row.packets,
    excessPackets: 0,
    primaryUnit: product?.primaryUnit?._id || product?.primaryUnit,
    secondaryUnit: product?.secondaryUnit?._id || product?.secondaryUnit,
    conversionFactor: cf,
    unitName: "packets",
    status: "issued",
    requestedBy: adminId,
    issuedBy: adminId,
    issuedDate: sowedAt,
    notes,
    linkedSlotIds: slotIds,
    linkedOrderIds: linkedOrderObjectIds,
    isExcessiveSowing: isExcessOnly,
    seedSource: "COMPANY",
    packetsFromCompany: row.packets,
    packetsFromRaising: 0,
    packetsIssued: row.packets,
    packetsUsed: row.packets,
    packetsReturned: 0,
    sowedQuantity: row.plants,
    shedName: "Office",
    completionNotes: notes,
    completedBy: adminId,
    sowingCompleted: true,
    sowingCompletedDate: sowedAt,
    sowingInProgress: false,
    remainingSowingNeeded: 0,
    completionEvents: [],
  });

  const slotResult = await applyPlantsToLinkedSlots(request, row.plants, {
    packetsUsed: row.packets,
    requestNumber,
    linkedOrderIds: linkedOrderObjectIds,
    isExcessiveSowing: isExcessOnly,
    shedName: "Office",
    sowedAt,
    plantReadyDays,
    resolveByReadyDate: true,
    userId: adminId,
  });

  pushEvent(request, {
    type: "SOW_COMPLETED",
    by: adminId,
    quantity: row.plants,
    unit: "plants",
    message: `Diary sow: ${row.plants} plants, ${row.packets} pkt`,
    meta: {
      tag: TAG,
      adminBypass: true,
      excessOnly: isExcessOnly,
      sowDate: toSowYmd(sowedAt),
      plantReadyDays: slotResult.plantReadyDays ?? plantReadyDays,
      plantReadyDate: slotResult.plantReadyDate || null,
      appliedSlotId: slotResult.appliedSlotId ? String(slotResult.appliedSlotId) : null,
    },
  });
  pushEvent(request, {
    type: "PACKETS_USED",
    by: adminId,
    quantity: row.packets,
    unit: "pkt",
    message: `${row.packets} packets recorded (inventory not deducted — admin bypass)`,
    meta: { adminBypass: true },
  });

  await request.saveWithUniqueRequestNumber();

  let orderResult = { marked: 0, remainingUncovered: row.plants, markedIds: [] };
  if (!isExcessOnly) {
    orderResult = await markOrdersSowed(request, {
      sowedAt,
      plantsSowed: row.plants,
      plantReadyDays,
      orderIds: linkedOrderObjectIds,
    });
  }
  const excessPlants = Math.max(0, Number(orderResult.remainingUncovered) || 0);
  const orderCoveredPlants = Math.max(0, row.plants - excessPlants);
  if (slotResult.appliedSlotId && !isExcessOnly) {
    await recordExcessPlantsOnSlot(
      slotResult.appliedSlotId,
      request._id,
      excessPlants,
      orderCoveredPlants,
      orderResult.batchLinkedIds || orderResult.markedIds || []
    );
  }
  if (orderResult.marked) {
    pushEvent(request, {
      type: "ORDERS_MARKED_SOWED",
      by: adminId,
      quantity: orderResult.marked,
      unit: "orders",
      message: `${orderResult.marked} orders marked sowingDone`,
      meta: { excessPlants, orderCoveredPlants },
    });
    await request.save();
  }

  const after = linkedOrderObjectIds.length
    ? await Order.find({ _id: { $in: linkedOrderObjectIds } })
        .select("orderId sowingDone")
        .lean()
    : [];
  return {
    requestNumber,
    subtype: subtype.name,
    product: product ? `${product.name} (${product.code})` : null,
    plants: row.plants,
    packets: row.packets,
    ordersMarked: after.filter((o) => o.sowingDone).map((o) => o.orderId),
    excessPlants,
    readyDate: slotResult.plantReadyDate,
    slot: slotResult.appliedSlotId ? String(slotResult.appliedSlotId) : null,
  };
}

await mongoose.connect(process.env.PROD_MONGO_URL);
try {
  const admin = await mongoose.connection.db.collection("users").findOne({
    _id: new mongoose.Types.ObjectId(ADMIN_ID),
  });
  if (!admin) throw new Error("admin missing");
  const plant = await PlantCms.findById(PLANT_ID).select("name subtypes").lean();
  if (!plant) throw new Error("watermelon missing");

  const loaded = [];
  for (const row of ROWS) loaded.push(await loadRow(plant, row));
  const blocked = loaded.filter((l) => l.blockers.length);
  if (blocked.length) {
    console.log(
      JSON.stringify(
        {
          apply: false,
          blocked: blocked.map((l) => ({ variety: l.row.variety, blockers: l.blockers })),
        },
        null,
        2
      )
    );
    process.exitCode = 1;
  } else {
    const cancelled = await cancelHung(admin._id);
    const created = [];
    for (const item of loaded) {
      created.push(await applyLoaded({ plant, adminId: admin._id, loaded: item }));
    }
    console.log(JSON.stringify({ apply: APPLY, db: mongoose.connection.name, cancelled, created }, null, 2));
  }
} finally {
  await mongoose.disconnect();
}
