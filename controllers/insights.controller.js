/**
 * Agri insights dashboard — bundle API for agri-insights-hub UI.
 *
 * Booking analytics: `bookingChannel` "office" = internal staff (non-FARMER submitter via
 * `placedByOfficeAdmin` or `orderSubmittedBy`→user.role); "mobile" = farmer self-service or unknown.
 * `salesPersonId` + `attributedToDealer` (sales user jobTitle === "DEALER") for sales/dealer filters.
 *
 * GET /api/v1/insights/dashboard
 *
 * Query: startDate, endDate (DD-MM-YYYY), optional plantId, subtypeId (Mongo ObjectId),
 *        dueOnly ("true" | "false").
 *
 * - Farmer plant orders only: dealerOrder === false.
 * - Excludes terminal order statuses: CANCELLED, REJECTED, TEMPORARY_CANCELLED.
 * - Date filter: orderBookingDate (same as getDeliveryOrders).
 * - Role scoping: mirrors getGeoSummary / getAll (SALES → own salesPerson; DEALER → dealer or salesPerson).
 *
 * Dispatches (timeline + “actually dispatched today” KPI):
 * - Loaded for IST window: start of (today − 3 days) through end of (today + 8 days), Dispatch.createdAt.
 * - isDeleted: false. transportStatus CANCELLED rows are omitted.
 *
 * KPI buckets (kpiSummary in response):
 * - todayExpected / next7Expected / due: open farmer orders by deliveryDate (IST calendar).
 * - todayActual: dispatch trips created today (plants + order count from Dispatch records).
 */

import mongoose from "mongoose";
import catchAsync from "../utility/catchAsync.js";
import Order from "../models/order.model.js";
import Dispatch from "../models/dispatch.model.js";
import PlantCms from "../models/plantCms.model.js";
import { isSalesOrDealerInsightsUser, scopedInsightsRole } from "../utils/insightsAccess.js";
import {
  filterDispatchesByVisibleOrders,
  getOrderIdStrings,
  scopedOrderIdsForDispatch,
  sumDispatchPlantsForScope,
} from "../utils/insightsDispatchScope.js";

const EXCLUDED_ORDER_STATUSES = ["CANCELLED", "REJECTED", "TEMPORARY_CANCELLED"];

const CLOSED_FOR_EXPECTED_KPI = new Set([
  "DISPATCHED",
  "DISPATCH_PROCESS",
  "COMPLETED",
  "PARTIALLY_COMPLETED",
  "CANCELLED",
  "REJECTED",
  "TEMPORARY_CANCELLED",
]);

const parseDate = (dateStr, isEnd = false) => {
  const [day, month, year] = dateStr.split("-");
  return isEnd
    ? new Date(`${year}-${month}-${day}T23:59:59.999Z`)
    : new Date(`${year}-${month}-${day}T00:00:00.000Z`);
};

/** IST calendar YYYY-MM-DD for "today" (for reportDate + due comparisons). */
function istCalendarDateString(d = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = fmt.formatToParts(d);
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const day = parts.find((p) => p.type === "day")?.value;
  return `${y}-${m}-${day}`;
}

/** End of calendar day in Asia/Kolkata (for due-only comparisons vs DB dates). */
function endOfIstDay(ymd) {
  return new Date(`${ymd}T23:59:59.999+05:30`);
}

function mapOrderStatusToUi(orderStatus) {
  if (["COMPLETED", "PARTIALLY_COMPLETED"].includes(orderStatus)) return "delivered";
  if (["DISPATCHED", "DISPATCH_PROCESS"].includes(orderStatus)) return "dispatched";
  if (["FARM_READY", "READY_FOR_DISPATCH"].includes(orderStatus)) return "ready";
  return "pending";
}

function mapDispatchStatusToUi(transportStatus) {
  if (transportStatus === "DELIVERED") return "delivered";
  if (transportStatus === "IN_TRANSIT") return "in_transit";
  return "scheduled";
}

/** Sum rupees already collected (farmer order payments with status COLLECTED). */
function sumCollectedPayments(paymentArr) {
  if (!Array.isArray(paymentArr)) return 0;
  return paymentArr
    .filter((p) => p && p.paymentStatus === "COLLECTED")
    .reduce((sum, p) => sum + (Number(p.paidAmount) || 0), 0);
}

function applyRoleMatch(pipeline, user) {
  if (!user) return;
  const { _id: userId } = user;
  const role = scopedInsightsRole(user);
  if (role === "SALES") {
    pipeline.push({ $match: { salesPerson: userId } });
  } else if (role === "DEALER") {
    pipeline.push({
      $match: { $or: [{ dealer: userId }, { salesPerson: userId }] },
    });
  }
}

/** IST midnight + dayOffset (dispatch window edges). */
function istStartOfDayFrom(baseYmd, dayOffset = 0) {
  const pivot = new Date(`${baseYmd}T12:00:00+05:30`);
  pivot.setDate(pivot.getDate() + dayOffset);
  const cal = istCalendarDateString(pivot);
  return new Date(`${cal}T00:00:00+05:30`);
}

function istYmdFromValue(value) {
  if (value == null || value === "") return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return istCalendarDateString(d);
}

function istAddDaysYmd(ymd, days) {
  const pivot = new Date(`${ymd}T12:00:00+05:30`);
  pivot.setDate(pivot.getDate() + days);
  return istCalendarDateString(pivot);
}

function plantsForKpiOrder(row) {
  const rem = Number(row.remainingPlants);
  if (Number.isFinite(rem) && rem >= 0) return rem;
  return Number(row.qty) || 0;
}

function isOpenForExpectedKpi(row, excludeReadyForDispatch) {
  const st = String(row.rawOrderStatus || row.orderStatus || "").toUpperCase();
  if (CLOSED_FOR_EXPECTED_KPI.has(st)) return false;
  if (excludeReadyForDispatch && st === "READY_FOR_DISPATCH") return false;
  return true;
}

function slimOrderForKpi(row) {
  return {
    id: row.id,
    orderId: row.orderId,
    farmerName: row.farmerName || "",
    salesperson: row.salesperson || "",
    plantId: row.plantId,
    variety: row.variety || "",
    plants: plantsForKpiOrder(row),
    deliveryDate: row.deliveryDate || null,
    orderStatus: row.rawOrderStatus || "",
    district: row.district || "",
    taluka: row.taluka || "",
    village: row.village || "",
  };
}

/** Expected = deliveryDate; actual today = Dispatch trips on report calendar day. */
function computeDispatchKpiSummary(orders, dispatches, reportDateStr, options = {}) {
  const excludeReadyForDispatch = Boolean(options.excludeReadyForDispatch);
  const next7EndYmd = istAddDaysYmd(reportDateStr, 7);

  const todayExpected = { plantCount: 0, orderCount: 0, orders: [] };
  const next7Expected = { plantCount: 0, orderCount: 0, orders: [] };
  const due = { plantCount: 0, orderCount: 0, orders: [] };
  const todayActual = { plantCount: 0, orderCount: 0, dispatchCount: 0, dispatches: [] };

  for (const o of orders) {
    if (!isOpenForExpectedKpi(o, excludeReadyForDispatch)) continue;
    const delYmd = istYmdFromValue(o.deliveryDate);
    if (!delYmd) continue;
    const plants = plantsForKpiOrder(o);
    const slim = slimOrderForKpi(o);

    if (delYmd < reportDateStr) {
      due.plantCount += plants;
      due.orderCount += 1;
      due.orders.push(slim);
    } else if (delYmd === reportDateStr) {
      todayExpected.plantCount += plants;
      todayExpected.orderCount += 1;
      todayExpected.orders.push(slim);
    } else if (delYmd > reportDateStr && delYmd <= next7EndYmd) {
      next7Expected.plantCount += plants;
      next7Expected.orderCount += 1;
      next7Expected.orders.push(slim);
    }
  }

  for (const d of dispatches) {
    const dYmd = istYmdFromValue(d.date);
    if (dYmd !== reportDateStr) continue;
    todayActual.plantCount += Number(d.totalPlants) || 0;
    todayActual.orderCount += Number(d.orders) || 0;
    todayActual.dispatchCount += 1;
    todayActual.dispatches.push({
      id: d.id,
      vehicle: d.vehicle || "",
      driver: d.driver || "",
      totalPlants: Number(d.totalPlants) || 0,
      orders: Number(d.orders) || 0,
      status: d.status || "scheduled",
    });
  }

  return { todayExpected, next7Expected, due, todayActual, reportDate: reportDateStr };
}

export const getInsightsDashboard = catchAsync(async (req, res) => {
  const { startDate, endDate, plantId, subtypeId, varietyName, dueOnly, excludeReadyForDispatch } =
    req.query;

  if (!startDate || !endDate) {
    return res.status(400).json({
      success: false,
      message: "startDate and endDate are required (DD-MM-YYYY)",
    });
  }

  const reportDateStr = istCalendarDateString(new Date());
  const reportDateIso = `${reportDateStr}T12:00:00.000Z`;
  const dueCutoff = endOfIstDay(reportDateStr);

  const plantDocs = await PlantCms.find({})
    .select({ name: 1, subtypes: 1 })
    .lean();

  const plants = plantDocs.map((p) => {
    const firstSubtype = p.subtypes?.[0];
    return {
      id: String(p._id),
      name: p.name,
      nameMr: p.name,
      variety: firstSubtype?.name || "",
    };
  });

  const plantVarieties = {};
  for (const p of plantDocs) {
    plantVarieties[String(p._id)] = (p.subtypes || [])
      .map((s) => s.name)
      .filter(Boolean);
  }

  const pipeline = [];

  applyRoleMatch(pipeline, req.user);

  const matchStage = {
    dealerOrder: false,
    farmer: { $exists: true, $ne: null },
    orderStatus: { $nin: EXCLUDED_ORDER_STATUSES },
    orderBookingDate: {
      $gte: parseDate(startDate),
      $lte: parseDate(endDate, true),
    },
  };

  if (plantId && mongoose.Types.ObjectId.isValid(plantId)) {
    matchStage.plantName = new mongoose.Types.ObjectId(plantId);
  }
  if (subtypeId && subtypeId !== "general" && mongoose.Types.ObjectId.isValid(subtypeId)) {
    matchStage.plantSubtype = new mongoose.Types.ObjectId(subtypeId);
  } else if (
    plantId &&
    varietyName &&
    String(varietyName).trim() &&
    mongoose.Types.ObjectId.isValid(plantId)
  ) {
    const cms = await PlantCms.findById(plantId).select("subtypes").lean();
    const st = (cms?.subtypes || []).find(
      (s) => s.name?.trim() === String(varietyName).trim()
    );
    if (st?._id) {
      matchStage.plantSubtype = st._id;
    }
  }

  pipeline.push({ $match: matchStage });
  pipeline.push({ $sort: { orderBookingDate: -1 } });
  pipeline.push({ $limit: 10000 });

  pipeline.push({
    $lookup: {
      from: "farmers",
      localField: "farmer",
      foreignField: "_id",
      pipeline: [
        {
          $project: {
            _id: 0,
            name: 1,
            village: 1,
            taluka: 1,
            talukaName: 1,
            district: 1,
            districtName: 1,
          },
        },
      ],
      as: "farmerData",
    },
  });

  pipeline.push({
    $lookup: {
      from: "users",
      localField: "salesPerson",
      foreignField: "_id",
      pipeline: [{ $project: { _id: 0, name: 1, jobTitle: 1 } }],
      as: "salesData",
    },
  });

  pipeline.push({
    $lookup: {
      from: "plantcms",
      localField: "plantName",
      foreignField: "_id",
      pipeline: [{ $project: { name: 1, subtypes: 1 } }],
      as: "plantData",
    },
  });

  pipeline.push({
    $addFields: {
      varietyDoc: {
        $arrayElemAt: [
          {
            $filter: {
              input: { $ifNull: [{ $arrayElemAt: ["$plantData.subtypes", 0] }, []] },
              as: "st",
              cond: { $eq: ["$$st._id", "$plantSubtype"] },
            },
          },
          0,
        ],
      },
      qty: {
        $add: [{ $ifNull: ["$numberOfPlants", 0] }, { $ifNull: ["$additionalPlants", 0] }],
      },
      remainingPlants: { $ifNull: ["$remainingPlants", "$numberOfPlants"] },
      expectedDispatch: "$deliveryDate",
      farmerDistrict: {
        $ifNull: [
          { $arrayElemAt: ["$farmerData.districtName", 0] },
          { $arrayElemAt: ["$farmerData.district", 0] },
        ],
      },
      farmerTaluka: {
        $ifNull: [
          { $arrayElemAt: ["$farmerData.talukaName", 0] },
          { $arrayElemAt: ["$farmerData.taluka", 0] },
        ],
      },
      farmerVillage: { $arrayElemAt: ["$farmerData.village", 0] },
      farmerName: { $arrayElemAt: ["$farmerData.name", 0] },
      salesperson: { $arrayElemAt: ["$salesData.name", 0] },
      plantDisplayName: { $arrayElemAt: ["$plantData.name", 0] },
    },
  });

  if (String(dueOnly) === "true") {
    pipeline.push({
      $match: {
        $expr: {
          $and: [
            {
              $in: [
                "$orderStatus",
                [
                  "PENDING",
                  "PROCESSING",
                  "ACCEPTED",
                  "FARM_READY",
                  "READY_FOR_DISPATCH",
                ],
              ],
            },
            { $lte: ["$expectedDispatch", dueCutoff] },
            { $ne: ["$expectedDispatch", null] },
          ],
        },
      },
    });
  }

  pipeline.push({
    $project: {
      _id: 1,
      orderId: 1,
      orderStatus: 1,
      rate: 1,
      qty: 1,
      remainingPlants: 1,
      orderBookingDate: 1,
      deliveryDate: 1,
      expectedDispatch: 1,
      varietyName: "$varietyDoc.name",
      plantNameId: "$plantName",
      farmerName: 1,
      salesperson: 1,
      salesPersonIdStr: { $toString: "$salesPerson" },
      salesJobTitle: { $arrayElemAt: ["$salesData.jobTitle", 0] },
      farmerDistrict: 1,
      farmerTaluka: 1,
      farmerVillage: 1,
      placedByOfficeAdmin: 1,
      orderSubmittedBy: 1,
      payment: 1,
    },
  });

  pipeline.push({
    $lookup: {
      from: "users",
      localField: "orderSubmittedBy",
      foreignField: "_id",
      pipeline: [{ $project: { _id: 0, role: 1 } }],
      as: "_orderSubmitter",
    },
  });

  pipeline.push({
    $addFields: {
      submitterRoleUpper: {
        $toUpper: { $ifNull: [{ $arrayElemAt: ["$_orderSubmitter.role", 0] }, ""] },
      },
    },
  });

  const rawOrders = await Order.aggregate(pipeline).allowDiskUse(true);

  const orders = rawOrders.map((row) => {
    const qty = row.qty || 0;
    const rate = row.rate || 0;
    const uiStatus = mapOrderStatusToUi(row.orderStatus);
    const totalAmount = qty * rate;
    const advanceAmount = sumCollectedPayments(row.payment);
    const advancePercent =
      totalAmount > 0
        ? Math.min(100, Math.round((advanceAmount / totalAmount) * 100))
        : 0;
    const sr = String(row.submitterRoleUpper || "").trim();
    const bookingChannelOffice =
      Boolean(row.placedByOfficeAdmin) ||
      (sr.length > 0 && sr !== "FARMER");
    const jt = String(row.salesJobTitle || "").toUpperCase().trim();
    const attributedToDealer = jt === "DEALER";
    const remainingPlants =
      row.remainingPlants != null ? Number(row.remainingPlants) : qty;
    return {
      id: `ORD-${row.orderId}`,
      orderId: row.orderId,
      farmerName: row.farmerName || "",
      salesperson: row.salesperson || "",
      salesPersonId: row.salesPersonIdStr ? String(row.salesPersonIdStr) : "",
      attributedToDealer,
      plantId: String(row.plantNameId),
      variety: row.varietyName || "",
      qty,
      remainingPlants: Number.isFinite(remainingPlants) ? remainingPlants : qty,
      pricePerPlant: rate,
      totalAmount,
      status: uiStatus,
      rawOrderStatus: row.orderStatus || "",
      district: row.farmerDistrict || "",
      taluka: row.farmerTaluka || "",
      village: row.farmerVillage || "",
      createdAt: row.orderBookingDate
        ? new Date(row.orderBookingDate).toISOString()
        : null,
      deliveryDate: row.deliveryDate
        ? new Date(row.deliveryDate).toISOString()
        : null,
      expectedDispatch: row.expectedDispatch
        ? new Date(row.expectedDispatch).toISOString()
        : null,
      bookingChannel: bookingChannelOffice ? "office" : "mobile",
      advanceAmount,
      advancePercent,
    };
  });

  const winStart = istStartOfDayFrom(reportDateStr, -3);
  const winEndExclusive = istStartOfDayFrom(reportDateStr, 9);
  const winEnd = new Date(winEndExclusive.getTime() - 1);

  const dispatchDocs = await Dispatch.find({
    isDeleted: false,
    transportStatus: { $ne: "CANCELLED" },
    createdAt: { $gte: winStart, $lte: winEnd },
  })
    .sort({ createdAt: 1 })
    .lean();

  let visibleDispatchOrderIdSet = null;
  let dispatchDocsForResponse = dispatchDocs;
  if (isSalesOrDealerInsightsUser(req.user)) {
    const candidateOrderIdStrings = [
      ...new Set(dispatchDocs.flatMap((d) => getOrderIdStrings(d.orderIds))),
    ];
    const candidateOrderIds = candidateOrderIdStrings
      .filter((id) => mongoose.Types.ObjectId.isValid(id))
      .map((id) => new mongoose.Types.ObjectId(id));

    visibleDispatchOrderIdSet = new Set();
    if (candidateOrderIds.length) {
      const scopedOrderPipeline = [
        { $match: { _id: { $in: candidateOrderIds }, dealerOrder: false } },
      ];
      applyRoleMatch(scopedOrderPipeline, req.user);
      scopedOrderPipeline.push({ $project: { _id: 1 } });
      const scopedOrders = await Order.aggregate(scopedOrderPipeline).allowDiskUse(true);
      visibleDispatchOrderIdSet = new Set(scopedOrders.map((o) => String(o._id)));
    }

    dispatchDocsForResponse = filterDispatchesByVisibleOrders(
      dispatchDocs,
      visibleDispatchOrderIdSet
    );
  }

  const geoOrderIds = [
    ...new Set(
      dispatchDocsForResponse.flatMap((d) =>
        scopedOrderIdsForDispatch(d, visibleDispatchOrderIdSet)
      )
    ),
  ]
    .filter((id) => mongoose.Types.ObjectId.isValid(id))
    .map((id) => new mongoose.Types.ObjectId(id));

  const geoByOrderId = new Map();
  if (geoOrderIds.length) {
    const geoRows = await Order.aggregate([
      { $match: { _id: { $in: geoOrderIds }, dealerOrder: false } },
      {
        $lookup: {
          from: "farmers",
          localField: "farmer",
          foreignField: "_id",
          pipeline: [
            {
              $project: {
                district: {
                  $ifNull: ["$districtName", "$district"],
                },
                taluka: { $ifNull: ["$talukaName", "$taluka"] },
              },
            },
          ],
          as: "fd",
        },
      },
      {
        $project: {
          district: { $arrayElemAt: ["$fd.district", 0] },
          taluka: { $arrayElemAt: ["$fd.taluka", 0] },
        },
      },
    ]);
    for (const r of geoRows) {
      geoByOrderId.set(String(r._id), {
        district: r.district || "",
        taluka: r.taluka || "",
      });
    }
  }

  const dispatches = dispatchDocsForResponse.map((d) => {
    const scopedOrderIds = scopedOrderIdsForDispatch(d, visibleDispatchOrderIdSet);
    const firstOid = scopedOrderIds[0];
    const geo = firstOid ? geoByOrderId.get(String(firstOid)) : null;
    const totalPlants = sumDispatchPlantsForScope(d, visibleDispatchOrderIdSet);
    const exposePlantBreakdown =
      !visibleDispatchOrderIdSet || scopedOrderIds.length === getOrderIdStrings(d.orderIds).length;
    const plantsBreakdown = [];
    if (exposePlantBreakdown) {
      for (const pd of d.plantsDetails || []) {
        const q = pd.totalPlants || pd.quantity || 0;
        plantsBreakdown.push({
          plantId: pd.plantId ? String(pd.plantId) : String(pd.id || ""),
          qty: q,
        });
      }
    }
    const vehicle = [d.vehicleNumber, d.vehicleName].filter(Boolean).join(" · ") || d.vehicleName || "";
    return {
      id: d.transportId || String(d._id),
      groupId: d.routeId || `RDG-${String(d._id).slice(-8)}`,
      vehicle,
      driver: d.driverName || "",
      date: d.createdAt ? new Date(d.createdAt).toISOString() : null,
      district: geo?.district || "",
      taluka: geo?.taluka || "",
      totalPlants,
      orders: scopedOrderIds.length,
      status: mapDispatchStatusToUi(d.transportStatus),
      plants: plantsBreakdown,
    };
  });

  const kpiSummary = computeDispatchKpiSummary(orders, dispatches, reportDateStr, {
    excludeReadyForDispatch: String(excludeReadyForDispatch) === "true",
  });

  return res.status(200).json({
    success: true,
    data: {
      reportDate: reportDateIso,
      reportDateCalendar: reportDateStr,
      plants,
      plantVarieties,
      orders,
      dispatches,
      kpiSummary,
      meta: {
        orderCount: orders.length,
        cappedAt: rawOrders.length >= 10000 ? 10000 : null,
        dispatchWindow: {
          start: winStart.toISOString(),
          end: winEnd.toISOString(),
          note:
            "Dispatches are not filtered by plant/subtype/dueOnly; window is IST-based on createdAt.",
        },
      },
    },
  });
});
