import mongoose from "mongoose";
import moment from "moment";
import Order from "../models/order.model.js";
import { IST_OFFSET, deliveryDateToIstMoment } from "../utility/istSlotDate.js";
import { OVERDUE_LOOKBACK_DAYS } from "../utility/capacityBoardMetrics.js";
import { DISPATCH_DUE_STATUSES, istDay, orderDueQty } from "../utility/dispatchLagwadBuckets.js";
import { lagwadInSlot, orderInSlot } from "../utility/dispatchSlotWindow.js";
import { loadSlotIdSet, loadSlotLagwadLines } from "./dispatchLagwadSources.js";

const YMD = "YYYY-MM-DD";
const asId = (id) => new mongoose.Types.ObjectId(String(id));

function ymdOf(value) {
  return value ? deliveryDateToIstMoment(value)?.format(YMD) || "" : "";
}

function farmerName(order) {
  const farmer = order?.farmer;
  if (farmer && typeof farmer === "object" && farmer.name) return String(farmer.name).trim();
  return "Farmer";
}

/**
 * Orders still to give and lagwad lines for one can-sell card.
 * includeOverdue matches the first window, which rolls past-due orders and ready lagwad in.
 */
export async function getDispatchSlotDetail({ plantId, subtypeId, from, to, includeOverdue }) {
  const today = moment().utcOffset(IST_OFFSET).format(YMD);
  const start = istDay(from);
  const end = istDay(to);
  const lookbackStart = moment(today, YMD).subtract(OVERDUE_LOOKBACK_DAYS, "days").format(YMD);
  const orderStart = includeOverdue ? moment.min(start.clone(), istDay(lookbackStart)) : start.clone();
  const slotIds = await loadSlotIdSet(plantId, subtypeId, start.year(), end.year());

  const filter = {
    plantName: asId(plantId),
    orderStatus: { $in: DISPATCH_DUE_STATUSES },
    deliveryDate: { $gte: orderStart.clone().utc().toDate(), $lte: end.clone().endOf("day").utc().toDate() },
    $or: [{ quotaSource: { $ne: "dealer" } }, { quotaSource: { $exists: false } }],
  };
  if (subtypeId) filter.plantSubtype = asId(subtypeId);

  const [orderRows, lineRows] = await Promise.all([
    Order.find(filter)
      .select("orderId farmer deliveryDate orderStatus numberOfPlants additionalPlants remainingPlants quotaSource vehicleLoaded vehicleLoadedQuantity")
      .populate("farmer", "name")
      .lean(),
    loadSlotLagwadLines(slotIds),
  ]);

  const window = { from, to, includeOverdue, lookbackStart };
  const orders = [];
  for (const order of orderRows) {
    const plants = orderDueQty(order);
    if (!plants) continue;
    const deliveryDate = ymdOf(order.deliveryDate);
    if (!orderInSlot(deliveryDate, window)) continue;
    orders.push({
      orderId: order.orderId,
      farmerName: farmerName(order),
      deliveryDate,
      plants,
      pastDue: Boolean(deliveryDate && deliveryDate < today),
    });
  }
  orders.sort((a, b) => Number(b.pastDue) - Number(a.pastDue) || a.deliveryDate.localeCompare(b.deliveryDate) || a.orderId - b.orderId);

  const lines = [];
  for (const line of lineRows) {
    const quantity = Math.max(0, Math.floor(Number(line.availableQuantity) || 0));
    if (!quantity) continue;
    const readyDate = ymdOf(line.expectedReadyDate);
    if (!lagwadInSlot(readyDate, window)) continue;
    lines.push({
      readyDate,
      quantity,
      batchNumber: line.batchNumber || "",
      shed: line.shed || "",
    });
  }

  return {
    from,
    to,
    today,
    orders,
    lines,
    stillToGive: orders.reduce((sum, order) => sum + order.plants, 0),
    plants: lines.reduce((sum, line) => sum + line.quantity, 0),
  };
}
