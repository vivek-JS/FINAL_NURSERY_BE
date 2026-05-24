/**
 * Usage: node scripts/diagnose-commission-order.js <orderId>
 * Example: node scripts/diagnose-commission-order.js 25262293
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
import Order from "../models/order.model.js";
import PlantCms from "../models/plantCms.model.js";
import {
  computeOrderCommissionMetrics,
  loadCommissionRatesMap,
  getDispatchedQty,
  getFinalPlants,
  ACTUAL_COMMISSION_STATUSES,
} from "../services/dealerCommission.service.js";

dotenv.config();

async function main() {
  const raw = process.argv[2];
  if (!raw) {
    console.error("Pass numeric orderId, e.g. 25262293");
    process.exit(1);
  }
  const orderId = Number(raw);
  if (!Number.isFinite(orderId)) {
    console.error("orderId must be a number");
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
  const order = await Order.findOne({ orderId })
    .populate("farmer", "name village")
    .lean();
  if (!order) {
    console.error(`Order ${orderId} not found`);
    process.exit(1);
  }

  const plants = await PlantCms.find({}).select("name subtypes").lean();
  const plantNames = new Map();
  const subtypeNames = new Map();
  for (const p of plants) {
    plantNames.set(p._id.toString(), p.name);
    for (const st of p.subtypes || []) subtypeNames.set(st._id.toString(), st.name);
  }
  const ratesMap = await loadCommissionRatesMap();
  const metrics = computeOrderCommissionMetrics(order, ratesMap, plantNames, subtypeNames);

  console.log(JSON.stringify({
    orderId: order.orderId,
    orderStatus: order.orderStatus,
    dealer: order.dealer,
    salesPerson: order.salesPerson,
    numberOfPlants: order.numberOfPlants,
    additionalPlants: order.additionalPlants,
    remainingPlants: order.remainingPlants,
    returnedPlants: order.returnedPlants,
    damagedPlants: order.damagedPlants,
    dispatchHistoryCount: (order.dispatchHistory || []).length,
    dispatchHistoryQty: (order.dispatchHistory || []).reduce((s, r) => s + Number(r.quantity || 0), 0),
    dispatchedQty: getDispatchedQty(order),
    finalPlants: getFinalPlants(order),
    inActualStatuses: ACTUAL_COMMISSION_STATUSES.has(order.orderStatus),
    orderPaymentStatus: order.orderPaymentStatus,
    paymentCompleted: order.paymentCompleted,
    paymentCollected: metrics.paymentCollected,
    orderTotalValue: metrics.orderTotalValue,
    isPaymentComplete: metrics.isPaymentComplete,
    expectedCommission: metrics.expectedCommission,
    actualCommission: metrics.actualCommission,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    orderBookingDate: order.orderBookingDate,
  }, null, 2));

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
