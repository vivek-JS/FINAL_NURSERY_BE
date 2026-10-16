import mongoose from "mongoose";
import Dispatch from "../models/dispatch.model.js";
import Tray from "../models/tray.model.js";
import PlantCms from "../models/plantCms.model.js";
import Order from "../models/order.model.js";

export const INSTANT_PICKUP_DRIVER = "शेतकरी स्वतः";
export const INSTANT_PICKUP_VEHICLE = "Farmer pickup";
const DEFAULT_TRAY_CAVITY = 126;
const DEAD_ORDER_STATUSES = ["CANCELLED", "REJECTED", "TEMPORARY_CANCELLED"];

export function instantPickupTransportId(order) {
  return `INSTANT-${order?.orderId ?? order?._id}`;
}

export function isInstantOrderRequest(body = {}) {
  const flag =
    body.instantDispatch === true || String(body.instantDispatch || "").toLowerCase() === "true";
  return flag && !String(body.dispatchId || "").trim();
}

const oid = (v) => (v ? String(v?._id ?? v) : "");

/** One entry per plant/subtype the farmer takes (multi-line instant orders have several). */
export function instantOrderPlantLines(order) {
  const lines = Array.isArray(order?.plantLineItems) ? order.plantLineItems : [];
  if (lines.length) {
    return lines
      .map((l) => ({
        plantId: oid(l.plantName),
        subTypeId: oid(l.plantSubtype),
        plants: Number(l.numberOfPlants) || 0,
        cavity: oid(l.cavity) || oid(order.cavity),
        plantName: l.plantNameSnapshot || "",
        subtypeName: l.plantSubtypeSnapshot || "",
      }))
      .filter((l) => l.plantId && l.subTypeId && l.plants > 0);
  }
  const plants = (Number(order?.numberOfPlants) || 0) + (Number(order?.additionalPlants) || 0);
  if (!oid(order?.plantName) || !oid(order?.plantSubtype) || plants < 1) return [];
  return [
    {
      plantId: oid(order.plantName),
      subTypeId: oid(order.plantSubtype),
      plants,
      cavity: oid(order.cavity),
      plantName: "",
      subtypeName: "",
    },
  ];
}

/**
 * Pickup Dispatch doc for an instant order. Pure: names and trays are resolved by the caller.
 * plantsDetails / crates must satisfy the Dispatch schema because every shed load re-saves the doc.
 */
export function buildInstantPickupDispatch(order, { lines, trayById, fallbackTray }) {
  const plantsDetails = lines.map((l) => {
    const tray = trayById.get(l.cavity) || fallbackTray;
    const perCrate = Number(tray?.numberPerCrate) || Number(tray?.cavity) || DEFAULT_TRAY_CAVITY;
    const name = [l.plantName, l.subtypeName].filter(Boolean).join(" -> ") || "Plant";
    return {
      name,
      id: l.plantId,
      plantId: l.plantId,
      subTypeId: l.subTypeId,
      quantity: l.plants,
      totalPlants: l.plants,
      pickupDetails: [],
      crates: [
        {
          cavity: String(tray._id),
          cavityName: tray.name || `${tray.cavity} Cavity`,
          crateCount: Math.ceil(l.plants / perCrate),
          plantCount: l.plants,
        },
      ],
    };
  });
  const total = lines.reduce((s, l) => s + l.plants, 0);
  return {
    name: "Instant pickup",
    transportId: instantPickupTransportId(order),
    transportStatus: "PENDING",
    isInstantPickup: true,
    orderIds: [order._id],
    orderDispatchDetails: [
      {
        orderId: order._id,
        dispatchQuantity: total,
        remainingAfterDispatch: 0,
        originalDispatchQuantity: total,
        driverName: INSTANT_PICKUP_DRIVER,
        vehicleName: INSTANT_PICKUP_VEHICLE,
        crates: plantsDetails.map((p) => ({
          cavity: String(p.crates[0].cavity),
          cavityName: p.crates[0].cavityName,
          crateCount: p.crates[0].crateCount,
          plantCount: p.crates[0].plantCount,
        })),
      },
    ],
    driverName: INSTANT_PICKUP_DRIVER,
    vehicleName: INSTANT_PICKUP_VEHICLE,
    plantsDetails,
  };
}

/** Idempotent: one pickup dispatch per instant order. Returns the dispatch (or null when nothing to give). */
export async function ensureInstantPickupDispatch(order) {
  if (!order?._id) return null;
  const existing = await Dispatch.findOne({ isInstantPickup: true, orderIds: order._id }).lean();
  if (existing) return existing;

  const lines = instantOrderPlantLines(order);
  if (!lines.length) return null;

  const plantIds = [...new Set(lines.map((l) => l.plantId))].filter((id) =>
    mongoose.Types.ObjectId.isValid(id)
  );
  const cms = plantIds.length
    ? await PlantCms.find({ _id: { $in: plantIds } }).select("name subtypes._id subtypes.name").lean()
    : [];
  const cmsById = new Map(cms.map((p) => [String(p._id), p]));
  for (const l of lines) {
    const p = cmsById.get(l.plantId);
    if (!l.plantName) l.plantName = p?.name || "";
    if (!l.subtypeName) {
      l.subtypeName = (p?.subtypes || []).find((s) => String(s._id) === l.subTypeId)?.name || "";
    }
  }

  const trayIds = [...new Set(lines.map((l) => l.cavity))].filter((id) =>
    mongoose.Types.ObjectId.isValid(id)
  );
  const trays = trayIds.length ? await Tray.find({ _id: { $in: trayIds } }).lean() : [];
  const trayById = new Map(trays.map((t) => [String(t._id), t]));
  const fallbackTray =
    trays[0] ||
    (await Tray.findOne({ cavity: DEFAULT_TRAY_CAVITY }).lean()) ||
    (await Tray.findOne({}).lean());
  if (!fallbackTray && trayById.size === 0) return null;

  const doc = buildInstantPickupDispatch(order, { lines, trayById, fallbackTray });
  try {
    return (await Dispatch.create(doc)).toObject();
  } catch (e) {
    if (e?.code === 11000) {
      return Dispatch.findOne({ transportId: doc.transportId }).lean();
    }
    throw e;
  }
}

/** Pending pickups whose order was cancelled / rejected / deleted are cancelled (nothing to give). */
export async function sweepCancelledInstantPickups() {
  const pending = await Dispatch.find({
    isInstantPickup: true,
    transportStatus: "PENDING",
    isDeleted: { $ne: true },
  })
    .select("orderIds")
    .lean();
  if (!pending.length) return 0;
  const orderIds = pending.flatMap((d) => d.orderIds || []);
  const live = await Order.find({
    _id: { $in: orderIds },
    orderStatus: { $nin: DEAD_ORDER_STATUSES },
  })
    .select("_id")
    .lean();
  const liveIds = new Set(live.map((o) => String(o._id)));
  const dead = pending
    .filter((d) => !(d.orderIds || []).some((id) => liveIds.has(String(id))))
    .map((d) => d._id);
  if (!dead.length) return 0;
  await Dispatch.updateMany({ _id: { $in: dead } }, { $set: { transportStatus: "CANCELLED" } });
  return dead.length;
}
