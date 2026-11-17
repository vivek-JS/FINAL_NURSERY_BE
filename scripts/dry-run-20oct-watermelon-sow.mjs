/**
 * Dry-run only: 20 Oct 2026 watermelon diary rows.
 *   node scripts/dry-run-20oct-watermelon-sow.mjs
 */
import dotenv from "dotenv";
import mongoose from "mongoose";
import path from "path";
import { fileURLToPath } from "url";
import PlantCms from "../models/plantCms.model.js";
import Product from "../models/product.model.js";
import Order from "../models/order.model.js";
import SowingRequest from "../models/sowingRequest.model.js";
import { planOrderSowCover, orderPlantRemaining } from "../services/orderSowCover.plan.js";
import {
  fmtDDMMYYYY,
  findSlotByPlantReadyDate,
  parseLocalDate,
} from "../controllers/sowingSlotReadyHelpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const PLANT_ID = "691054dffba6fb380f8d57b3";
const SOW = parseLocalDate("2026-10-20");
const READY_DAYS = 18;

const ROWS = [
  {
    variety: "Simbha",
    plants: 38808,
    packets: 38,
    orderIds: [4159, 4160],
    excessOnly: false,
  },
  {
    variety: "Redking",
    plants: 53171,
    packets: 50.5,
    orderIds: [4164, 4217, 4179],
    excessOnly: false,
  },
  {
    variety: "Redmaxx",
    plants: 27972,
    packets: 24,
    orderIds: [4182],
    excessOnly: false,
  },
  {
    variety: "Prachand",
    plants: 27846,
    packets: 25,
    orderIds: [],
    excessOnly: true,
  },
];

function readyDate() {
  const d = new Date(SOW);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + READY_DAYS);
  return d;
}

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

await mongoose.connect(process.env.PROD_MONGO_URL);
try {
  const dbName = mongoose.connection.name;
  const plant = await PlantCms.findById(PLANT_ID).select("name subtypes").lean();
  if (!plant) throw new Error("watermelon plant missing");

  const ready = readyDate();
  const readyLabel = fmtDDMMYYYY(ready);
  const out = [];

  for (const row of ROWS) {
    const orders = row.orderIds.length
      ? await Order.find({ orderId: { $in: row.orderIds } })
          .select(
            "orderId numberOfPlants additionalPlants plantSubtype bookingSlot sowingDone orderStatus deliveryDate sowingPartialCover"
          )
          .lean()
      : [];
    const byNumber = new Map(orders.map((o) => [o.orderId, o]));
    const missing = row.orderIds.filter((id) => !byNumber.has(id));
    const subtypeIds = [...new Set(orders.map((o) => String(o.plantSubtype || "")))];
    const subtype =
      (plant.subtypes || []).find((s) => subtypeIds.includes(String(s._id))) ||
      (plant.subtypes || []).find((s) => norm(s.name) === norm(row.variety)) ||
      (plant.subtypes || []).find((s) => norm(s.name).includes(norm(row.variety)));

    const product = subtype
      ? await Product.find({
          plantId: plant._id,
          subtypeId: subtype._id,
          category: { $regex: /^seeds$/i },
          isActive: true,
        })
          .select("name code conversionFactor tentativePlantsPerPacket")
          .lean()
      : [];

    const activeReqs = orders.length
      ? await SowingRequest.find({
          linkedOrderIds: { $in: orders.map((o) => o._id) },
          status: { $nin: ["cancelled", "rejected"] },
        })
          .select("requestNumber status sowingCompleted subtypeName sowedQuantity packetsUsed")
          .lean()
      : [];

    let slot = null;
    if (subtype) {
      const booking = orders.find((o) => o.bookingSlot)?.bookingSlot;
      if (booking && !row.excessOnly) {
        slot = { slotId: String(booking), source: "order booking slot" };
      } else {
        const found = await findSlotByPlantReadyDate(plant._id, subtype._id, ready);
        slot = found?.slotId
          ? { slotId: String(found.slotId), source: "ready date", detail: found }
          : { slotId: null, source: "none" };
      }
    }

    const sorted = [...orders].sort(
      (a, b) =>
        new Date(a.deliveryDate || 0) - new Date(b.deliveryDate || 0) ||
        a.orderId - b.orderId
    );
    const plan = row.excessOnly
      ? null
      : planOrderSowCover({ plantsSowed: row.plants, orders: sorted });

    const orderLines = sorted.map((o) => ({
      orderId: o.orderId,
      subtypeId: String(o.plantSubtype || ""),
      booked: (Number(o.numberOfPlants) || 0) + (Number(o.additionalPlants) || 0),
      remaining: orderPlantRemaining(o),
      sowingDone: Boolean(o.sowingDone),
      status: o.orderStatus,
      slot: o.bookingSlot ? String(o.bookingSlot) : null,
    }));

    out.push({
      variety: row.variety,
      matchedSubtype: subtype?.name || null,
      plants: row.plants,
      packets: row.packets,
      excessOnly: row.excessOnly,
      missingOrders: missing,
      subtypeMismatch: subtypeIds.filter((id) => subtype && id !== String(subtype._id)),
      orders: orderLines,
      bookedSum: orderLines.reduce((s, o) => s + o.booked, 0),
      cover: plan
        ? {
            full: plan.full.map((f) => {
              const o = sorted.find((x) => String(x._id) === String(f.orderId));
              return { orderId: o?.orderId, plants: f.plants };
            }),
            partial: plan.partial
              ? {
                  orderId: sorted.find((x) => String(x._id) === String(plan.partial.orderId))
                    ?.orderId,
                  addPlants: plan.partial.addPlants,
                  stillLeft: plan.partial.remaining,
                }
              : null,
            waiting: plan.waiting.map((w) => ({
              orderId: sorted.find((x) => String(x._id) === String(w.orderId))?.orderId,
              remaining: w.remaining,
            })),
            excessPlants: plan.excess,
            orderPlantsCovered: plan.orderPlantsCovered,
          }
        : { excessPlants: row.plants },
      products: product.map((p) => ({
        name: p.name,
        code: p.code,
        perPacket: p.tentativePlantsPerPacket || p.conversionFactor,
      })),
      slot,
      readyDate: readyLabel,
      existingRequests: activeReqs.map((r) => ({
        requestNumber: r.requestNumber,
        status: r.status,
        completed: Boolean(r.sowingCompleted),
        subtype: r.subtypeName,
        plants: r.sowedQuantity,
        packets: r.packetsUsed,
      })),
    });
  }

  console.log(
    JSON.stringify(
      { dryRun: true, db: dbName, sowDate: "2026-10-20", plant: plant.name, rows: out },
      null,
      2
    )
  );
} finally {
  await mongoose.disconnect();
}
