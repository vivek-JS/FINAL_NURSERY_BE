import Order from "../models/order.model.js";
import catchAsync from "../utility/catchAsync.js";
import generateResponse from "../utility/responseFormat.js";
import { appendOrderSearchPipelineStages } from "../utils/orderSearchMatch.util.js";

const billablePlantsExpr = {
  $max: [
    0,
    {
      $subtract: [
        {
          $ifNull: [
            "$totalPlants",
            {
              $add: [{ $ifNull: ["$numberOfPlants", 0] }, { $ifNull: ["$additionalPlants", 0] }],
            },
          ],
        },
        {
          $add: [{ $ifNull: ["$returnedPlants", 0] }, { $ifNull: ["$damagedPlants", 0] }],
        },
      ],
    },
  ],
};

const collectedExpr = {
  $reduce: {
    input: { $ifNull: ["$payment", []] },
    initialValue: 0,
    in: {
      $add: [
        "$$value",
        {
          $cond: [
            { $eq: ["$$this.paymentStatus", "COLLECTED"] },
            { $toDouble: { $ifNull: ["$$this.paidAmount", 0] } },
            0,
          ],
        },
      ],
    },
  },
};

function shape(row) {
  const farmer = Array.isArray(row.farmer) ? row.farmer[0] : row.farmer;
  const sales = Array.isArray(row.salesPerson) ? row.salesPerson[0] : row.salesPerson;
  const dispatch = Array.isArray(row._dispatch) ? row._dispatch[0] : row._dispatch;
  const total = Math.round((Number(row.total) || 0) * 100) / 100;
  const collected = Math.round((Number(row.collected) || 0) * 100) / 100;
  const due = Math.round(Math.max(0, total - collected) * 100) / 100;
  return {
    id: String(row._id),
    orderId: row.orderId,
    orderStatus: row.orderStatus,
    farmer: farmer
      ? {
          _id: farmer._id,
          name: farmer.name || "",
          mobileNumber: farmer.mobileNumber || "",
          village: farmer.village || "",
        }
      : null,
    salesPerson: sales ? { name: sales.name || "", phoneNumber: sales.phoneNumber || "" } : null,
    vehicleName: dispatch?.vehicleName || row.vehicleName || "",
    vehicleNumber: dispatch?.vehicleNumber || row.vehicleNumber || "",
    driverName: dispatch?.driverName || "",
    total,
    collected,
    due,
    dispatchDate: row.deliveryDate || dispatch?.createdAt || row.updatedAt || null,
  };
}

/** GET /api/v1/order/outstanding-balances — dispatched/completed farmer orders still owing ₹. */
export const getOutstandingBalances = catchAsync(async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 40));
  const skip = (page - 1) * limit;
  const st = String(req.query.orderStatus || "").toUpperCase();
  const statuses = st === "DISPATCHED" || st === "COMPLETED" ? [st] : ["DISPATCHED", "COMPLETED"];
  const search = String(req.query.search || "").trim();

  const pipeline = [
    {
      $match: {
        dealerOrder: { $ne: true },
        orderStatus: { $in: statuses },
      },
    },
    {
      $addFields: {
        _billablePlantsForPayment: billablePlantsExpr,
        _totalCollectedPayments: collectedExpr,
      },
    },
    {
      $addFields: {
        _billableOrderAmount: {
          $multiply: [{ $toDouble: { $ifNull: ["$rate", 0] } }, "$_billablePlantsForPayment"],
        },
      },
    },
    {
      $addFields: {
        _due: { $subtract: ["$_billableOrderAmount", "$_totalCollectedPayments"] },
      },
    },
    { $match: { _due: { $gt: 0.009 } } },
  ];

  if (search) {
    appendOrderSearchPipelineStages(pipeline, search);
  } else {
    pipeline.push({
      $lookup: { from: "farmers", localField: "farmer", foreignField: "_id", as: "farmer" },
    });
  }

  const [countRows, sumRows, docs] = await Promise.all([
    Order.aggregate([...pipeline, { $count: "count" }]),
    Order.aggregate([
      ...pipeline,
      { $group: { _id: null, dueSum: { $sum: "$_due" }, count: { $sum: 1 } } },
    ]),
    Order.aggregate([
      ...pipeline,
      { $sort: { deliveryDate: -1, updatedAt: -1 } },
      { $skip: skip },
      { $limit: limit },
      {
        $lookup: { from: "users", localField: "salesPerson", foreignField: "_id", as: "salesPerson" },
      },
      {
        $lookup: { from: "dispatches", localField: "currentDispatchId", foreignField: "_id", as: "_dispatch" },
      },
      {
        $project: {
          orderId: 1,
          orderStatus: 1,
          farmer: 1,
          salesPerson: 1,
          _dispatch: 1,
          vehicleName: 1,
          vehicleNumber: 1,
          deliveryDate: 1,
          updatedAt: 1,
          total: "$_billableOrderAmount",
          collected: "$_totalCollectedPayments",
        },
      },
    ]),
  ]);

  const total = Number(countRows[0]?.count) || 0;
  const dueSum = Math.round((Number(sumRows[0]?.dueSum) || 0) * 100) / 100;

  return res.status(200).json(
    generateResponse("Success", "Outstanding balances fetched", {
      rows: docs.map(shape),
      summary: { count: total, dueSum },
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    })
  );
});
