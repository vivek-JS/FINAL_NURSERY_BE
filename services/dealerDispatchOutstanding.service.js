import mongoose from "mongoose";
import Order from "../models/order.model.js";

export const DISPATCH_OUTSTANDING_STATUSES = [
  "DISPATCHED",
  "COMPLETED",
  "PARTIALLY_COMPLETED",
];

function resolveLocation(order) {
  const farmer =
    order.farmer && typeof order.farmer === "object" ? order.farmer : null;
  const orderFor =
    order.orderFor && typeof order.orderFor === "object" ? order.orderFor : null;

  const village =
    String(orderFor?.villageName || orderFor?.village || farmer?.village || "")
      .trim() || "—";
  const district =
    String(
      orderFor?.districtName || orderFor?.district || farmer?.district || ""
    ).trim() || "—";
  const taluka =
    String(orderFor?.talukaName || orderFor?.taluka || farmer?.taluka || "")
      .trim() || null;

  const farmerName =
    String(orderFor?.name || farmer?.name || "").trim() || "—";

  return { village, district, taluka, farmerName };
}

function resolveFarmerMobile(order) {
  const farmer =
    order.farmer && typeof order.farmer === "object" ? order.farmer : null;
  const orderFor =
    order.orderFor && typeof order.orderFor === "object" ? order.orderFor : null;
  const raw = orderFor?.mobileNumber ?? farmer?.mobileNumber ?? "";
  const digits = String(raw).replace(/\D/g, "");
  if (digits.length >= 10) return digits.slice(-10);
  return null;
}

function villageDistrictKey(village, district) {
  return `${String(village || "").trim()}|||${String(district || "").trim()}`;
}

function buildDealerOutstandingBaseMatch(dealerId) {
  const oid = new mongoose.Types.ObjectId(dealerId);
  return {
    dealerOrder: { $ne: true },
    orderStatus: { $in: DISPATCH_OUTSTANDING_STATUSES },
    $or: [{ salesPerson: oid }, { dealer: oid }],
  };
}

const locationFieldsStage = {
  $addFields: {
    _village: {
      $let: {
        vars: {
          v: {
            $ifNull: [
              "$orderFor.villageName",
              "$orderFor.village",
              { $arrayElemAt: ["$_farmerDoc.village", 0] },
              "Unknown village",
            ],
          },
        },
        in: { $trim: { input: { $toString: "$$v" } } },
      },
    },
    _district: {
      $let: {
        vars: {
          d: {
            $ifNull: [
              "$orderFor.districtName",
              "$orderFor.district",
              { $arrayElemAt: ["$_farmerDoc.district", 0] },
              "—",
            ],
          },
        },
        in: { $trim: { input: { $toString: "$$d" } } },
      },
    },
  },
};

const farmerLookupStage = {
  $lookup: {
    from: "farmers",
    localField: "farmer",
    foreignField: "_id",
    as: "_farmerDoc",
  },
};

function mapPaymentHistory(payment = []) {
  return [...payment]
    .map((p, index) => ({
      _id: p._id,
      index,
      paidAmount: Number(p.paidAmount) || 0,
      paymentStatus: p.paymentStatus || "PENDING",
      modeOfPayment: p.modeOfPayment || "",
      bankName: p.bankName || "",
      remark: p.remark || "",
      paymentDate: p.paymentDate || p.createdAt || null,
      isWalletPayment: Boolean(p.isWalletPayment),
    }))
    .sort((a, b) => {
      const ta = a.paymentDate ? new Date(a.paymentDate).getTime() : 0;
      const tb = b.paymentDate ? new Date(b.paymentDate).getTime() : 0;
      return tb - ta;
    });
}

function mapOrderRow(order) {
  const totalPlants =
    (order.numberOfPlants || 0) + (order.additionalPlants || 0);
  const freight = Math.max(0, Number(order.freightCharges) || 0);
  const orderTotal =
    Math.round(((order.rate || 0) * totalPlants + freight) * 100) / 100;
  const totalCollected = (order.payment || [])
    .filter((p) => p.paymentStatus === "COLLECTED")
    .reduce((sum, p) => sum + (Number(p.paidAmount) || 0), 0);
  const outstanding = Math.round((orderTotal - totalCollected) * 100) / 100;
  const loc = resolveLocation(order);

  return {
    _id: order._id,
    orderId: order.orderId,
    orderStatus: order.orderStatus,
    orderPaymentStatus: order.orderPaymentStatus,
    plantName: order.plantName?.name || null,
    numberOfPlants: order.numberOfPlants,
    additionalPlants: order.additionalPlants || 0,
    rate: order.rate,
    orderTotal,
    totalCollected,
    outstanding,
    village: loc.village,
    district: loc.district,
    taluka: loc.taluka,
    farmerName: loc.farmerName,
    farmerMobile: resolveFarmerMobile(order),
    deliveryDate: order.deliveryDate || null,
    orderBookingDate: order.orderBookingDate || order.createdAt,
    payments: mapPaymentHistory(order.payment || []),
  };
}

const outstandingComputeStages = [
  {
    $addFields: {
      _totalPlants: {
        $add: [
          { $ifNull: ["$numberOfPlants", 0] },
          { $ifNull: ["$additionalPlants", 0] },
        ],
      },
      _freight: { $ifNull: ["$freightCharges", 0] },
    },
  },
  {
    $addFields: {
      _orderTotal: {
        $round: [
          {
            $add: [
              { $multiply: [{ $ifNull: ["$rate", 0] }, "$_totalPlants"] },
              "$_freight",
            ],
          },
          2,
        ],
      },
    },
  },
  {
    $addFields: {
      _totalCollected: {
        $round: [
          {
            $reduce: {
              input: {
                $filter: {
                  input: { $ifNull: ["$payment", []] },
                  as: "p",
                  cond: { $eq: ["$$p.paymentStatus", "COLLECTED"] },
                },
              },
              initialValue: 0,
              in: {
                $add: ["$$value", { $ifNull: ["$$this.paidAmount", 0] }],
              },
            },
          },
          2,
        ],
      },
    },
  },
  {
    $addFields: {
      _outstanding: {
        $round: [{ $subtract: ["$_orderTotal", "$_totalCollected"] }, 2],
      },
    },
  },
];

/**
 * Dealer farmer orders dispatched/completed with payment still due.
 */
/**
 * Village-wise outstanding summary for dealer dispatch orders.
 */
export async function listDealerDispatchOutstandingByVillage(dealerId) {
  const baseMatch = buildDealerOutstandingBaseMatch(dealerId);

  const rows = await Order.aggregate([
    { $match: baseMatch },
    farmerLookupStage,
    ...outstandingComputeStages,
    { $match: { _outstanding: { $gt: 0 } } },
    locationFieldsStage,
    {
      $group: {
        _id: { village: "$_village", district: "$_district" },
        totalOutstanding: { $sum: "$_outstanding" },
        orderCount: { $sum: 1 },
        totalCollected: { $sum: "$_totalCollected" },
        totalOrderValue: { $sum: "$_orderTotal" },
      },
    },
    { $sort: { totalOutstanding: -1, "_id.village": 1 } },
  ]);

  const villages = rows.map((r) => ({
    village: r._id.village || "Unknown village",
    district: r._id.district || "—",
    villageKey: villageDistrictKey(r._id.village, r._id.district),
    totalOutstanding: Math.round(r.totalOutstanding * 100) / 100,
    orderCount: r.orderCount,
    totalCollected: Math.round(r.totalCollected * 100) / 100,
    totalOrderValue: Math.round(r.totalOrderValue * 100) / 100,
  }));

  const summary = {
    villageCount: villages.length,
    totalOrdersWithOutstanding: villages.reduce((s, v) => s + v.orderCount, 0),
    totalOutstanding: Math.round(
      villages.reduce((s, v) => s + v.totalOutstanding, 0) * 100
    ) / 100,
  };

  return { villages, summary };
}

export async function listDealerDispatchOutstandingOrders(
  dealerId,
  { page = 1, limit = 20, village, district } = {}
) {
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(50, Math.max(1, parseInt(limit, 10) || 20));
  const skip = (pageNum - 1) * limitNum;

  const baseMatch = buildDealerOutstandingBaseMatch(dealerId);
  const villageFilter = String(village || "").trim();
  const districtFilter = String(district || "").trim();
  const hasVillageFilter = Boolean(villageFilter);

  const postOutstandingStages = [
    farmerLookupStage,
    ...outstandingComputeStages,
    { $match: { _outstanding: { $gt: 0 } } },
    locationFieldsStage,
  ];

  if (hasVillageFilter) {
    postOutstandingStages.push({
      $match: {
        _village: villageFilter,
        ...(districtFilter ? { _district: districtFilter } : {}),
      },
    });
  }

  const [countRow, summaryRow, orderIds] = await Promise.all([
    Order.aggregate([
      { $match: baseMatch },
      ...postOutstandingStages,
      { $count: "total" },
    ]),
    Order.aggregate([
      { $match: baseMatch },
      ...postOutstandingStages,
      {
        $group: {
          _id: null,
          totalOutstanding: { $sum: "$_outstanding" },
        },
      },
    ]),
    Order.aggregate([
      { $match: baseMatch },
      ...postOutstandingStages,
      { $sort: { _outstanding: -1, orderId: -1 } },
      { $skip: skip },
      { $limit: limitNum },
      { $project: { _id: 1 } },
    ]),
  ]);

  const total = countRow[0]?.total || 0;
  const totalOutstanding = Math.round(
    (summaryRow[0]?.totalOutstanding || 0) * 100
  ) / 100;

  const ids = orderIds.map((r) => r._id);
  if (ids.length === 0) {
    return {
      orders: [],
      summary: { totalOrdersWithOutstanding: total, totalOutstanding },
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.max(1, Math.ceil(total / limitNum) || 1),
        hasMore: false,
      },
    };
  }

  const orders = await Order.find({ _id: { $in: ids } })
    .populate("farmer", "name village taluka district mobileNumber")
    .populate("plantName", "name")
    .select(
      "orderId orderStatus orderPaymentStatus numberOfPlants additionalPlants rate freightCharges payment farmer orderFor deliveryDate orderBookingDate createdAt plantName"
    )
    .lean();

  const orderMap = new Map(orders.map((o) => [String(o._id), o]));
  const pageRows = ids
    .map((id) => orderMap.get(String(id)))
    .filter(Boolean)
    .map(mapOrderRow);

  return {
    orders: pageRows,
    filters: hasVillageFilter
      ? { village: villageFilter, district: districtFilter || null }
      : null,
    summary: { totalOrdersWithOutstanding: total, totalOutstanding },
    pagination: {
      page: pageNum,
      limit: limitNum,
      total,
      totalPages: Math.max(1, Math.ceil(total / limitNum) || 1),
      hasMore: skip + pageRows.length < total,
    },
  };
}
