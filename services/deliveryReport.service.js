import mongoose from "mongoose";
import Order from "../models/order.model.js";
import {
  LINE_PLANT_TOTAL_ADD_FIELDS,
  orderStatusExcludeMatch,
} from "../utility/istOrderDateStats.js";
import { parseCalendarQueryBound } from "../utility/istCalendar.js";
import { NON_DEALER_QUOTA_MATCH } from "../utility/slotDispatchStats.js";
import { duePipelineMatch } from "../utility/adminMisDue.js";
import { hydrateMisOrderDrawerList } from "../utility/misOrderEnrichment.js";
import { sumOrderAdvancePayments } from "../utils/paymentTiming.js";

const ROLLED_NOR = [
  { pastDueSlotRollover: true },
  { pastDueSlotRolloverAt: { $exists: true, $ne: null } },
];

const ROLLED_OR = { $or: ROLLED_NOR };

const VALID_COHORTS = new Set(["native", "rolled", "deliveryChanged"]);
const VALID_ADVANCE = new Set(["collected", "pending"]);

function toOid(value) {
  if (value == null || value === "") return null;
  const s = String(value).trim();
  if (!mongoose.Types.ObjectId.isValid(s)) return null;
  return new mongoose.Types.ObjectId(s);
}

function deliveryInRange(rangeStart, rangeEnd) {
  return { deliveryDate: { $gte: rangeStart, $lte: rangeEnd, $ne: null } };
}

function nativeCohortBranch(rangeStart, rangeEnd, includePastDue) {
  const inRange = {
    ...deliveryInRange(rangeStart, rangeEnd),
    $nor: ROLLED_NOR,
  };
  if (!includePastDue) return inRange;
  return {
    $or: [
      inRange,
      {
        ...duePipelineMatch(),
        deliveryDate: { $lt: rangeStart, $ne: null },
        $nor: ROLLED_NOR,
      },
    ],
  };
}

function rolledCohortBranch(rangeStart, rangeEnd, includePastDue) {
  const inRange = {
    ...deliveryInRange(rangeStart, rangeEnd),
    ...ROLLED_OR,
  };
  if (!includePastDue) return inRange;
  return {
    $or: [
      inRange,
      {
        ...duePipelineMatch(),
        deliveryDate: { $lt: rangeStart, $ne: null },
        ...ROLLED_OR,
      },
    ],
  };
}

function deliveryChangedBranch(rangeStart, rangeEnd, includePastDue) {
  const changeInRange = {
    deliveryChanges: {
      $elemMatch: { createdAt: { $gte: rangeStart, $lte: rangeEnd } },
    },
  };
  if (!includePastDue) {
    // deliveryDate range enforced on parent match; only need change-in-range here.
    return changeInRange;
  }
  return {
    $or: [
      { ...deliveryInRange(rangeStart, rangeEnd), ...changeInRange },
      {
        ...duePipelineMatch(),
        deliveryDate: { $lt: rangeStart, $ne: null },
        ...changeInRange,
      },
    ],
  };
}

/** Shared aggregation stages for advance payment amounts on each order row. */
const ADVANCE_PAYMENT_ADD_FIELDS = {
  $addFields: {
    _firstDispatchAt: {
      $let: {
        vars: {
          dh: {
            $filter: {
              input: { $ifNull: ["$dispatchHistory", []] },
              as: "h",
              cond: { $ne: ["$$h.date", null] },
            },
          },
        },
        in: {
          $min: {
            $map: { input: "$$dh", as: "h", in: "$$h.date" },
          },
        },
      },
    },
  },
};

const ADVANCE_SUMS_ADD_FIELDS = {
  $addFields: {
    _advanceCollected: {
      $reduce: {
        input: { $ifNull: ["$payment", []] },
        initialValue: 0,
        in: {
          $add: [
            "$$value",
            {
              $cond: [
                {
                  $and: [
                    { $gt: [{ $ifNull: ["$$this.paidAmount", 0] }, 0] },
                    {
                      $or: [
                        { $eq: ["$$this.paymentTiming", "advance"] },
                        {
                          $and: [
                            { $eq: ["$$this.paymentStatus", "COLLECTED"] },
                            {
                              $or: [
                                { $eq: ["$_firstDispatchAt", null] },
                                {
                                  $lt: [
                                    { $ifNull: ["$$this.paymentDate", "$$this.createdAt"] },
                                    "$_firstDispatchAt",
                                  ],
                                },
                              ],
                            },
                          ],
                        },
                        {
                          $and: [
                            { $eq: ["$$this.paymentStatus", "PENDING"] },
                            { $eq: ["$_firstDispatchAt", null] },
                          ],
                        },
                      ],
                    },
                    { $eq: ["$$this.paymentStatus", "COLLECTED"] },
                  ],
                },
                { $ifNull: ["$$this.paidAmount", 0] },
                0,
              ],
            },
          ],
        },
      },
    },
    _advancePending: {
      $reduce: {
        input: { $ifNull: ["$payment", []] },
        initialValue: 0,
        in: {
          $add: [
            "$$value",
            {
              $cond: [
                {
                  $and: [
                    { $eq: ["$$this.paymentStatus", "PENDING"] },
                    { $gt: [{ $ifNull: ["$$this.paidAmount", 0] }, 0] },
                    {
                      $or: [
                        { $eq: ["$$this.paymentTiming", "advance"] },
                        { $eq: ["$_firstDispatchAt", null] },
                      ],
                    },
                  ],
                },
                { $ifNull: ["$$this.paidAmount", 0] },
                0,
              ],
            },
          ],
        },
      },
    },
  },
};

function advancePaymentMatch(advanceFilters) {
  if (!advanceFilters?.length) return null;
  const branches = [];
  if (advanceFilters.includes("collected")) {
    branches.push({ _advanceCollected: { $gt: 0 } });
  }
  if (advanceFilters.includes("pending")) {
    branches.push({ _advancePending: { $gt: 0 } });
  }
  if (!branches.length) return null;
  return branches.length === 1 ? branches[0] : { $or: branches };
}

function cohortFlagsAddFields(rangeStart, rangeEnd) {
  return {
    $addFields: {
      _isRolled: {
        $or: [
          { $eq: ["$pastDueSlotRollover", true] },
          {
            $and: [
              { $ne: ["$pastDueSlotRolloverAt", null] },
              { $ifNull: ["$pastDueSlotRolloverAt", false] },
            ],
          },
        ],
      },
      _hasChangeInRange: {
        $gt: [
          {
            $size: {
              $filter: {
                input: { $ifNull: ["$deliveryChanges", []] },
                as: "c",
                cond: {
                  $and: [
                    { $gte: ["$$c.createdAt", rangeStart] },
                    { $lte: ["$$c.createdAt", rangeEnd] },
                  ],
                },
              },
            },
          },
          0,
        ],
      },
      _deliveryInRange: {
        $and: [
          { $ne: ["$deliveryDate", null] },
          { $gte: ["$deliveryDate", rangeStart] },
          { $lte: ["$deliveryDate", rangeEnd] },
        ],
      },
    },
  };
}

/**
 * Parse query and build Mongo match for delivery report.
 * @returns {{ error?: string, statusCode?: number, match?: object, meta?: object }}
 */
export function parseDeliveryReportQuery(query = {}) {
  const plantId = toOid(query.plantId);
  if (!plantId) {
    return { error: "plantId is required", statusCode: 400 };
  }

  const start = parseCalendarQueryBound(query.startDate, false);
  const end = parseCalendarQueryBound(query.endDate, true);
  if (!start || !end) {
    return { error: "startDate and endDate are required", statusCode: 400 };
  }

  const cohorts = String(query.cohorts || "native,rolled")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => VALID_COHORTS.has(s));
  if (!cohorts.length) {
    return { error: "At least one cohort is required (native, rolled, deliveryChanged)", statusCode: 400 };
  }

  const statuses = String(query.status || "ACCEPTED")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);

  const includePastDue = String(query.includePastDueBeyondRange ?? "") === "true";

  const advanceFilters = String(query.advancePayment || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => VALID_ADVANCE.has(s));

  const subtypeId = toOid(query.subtypeId);

  const cohortBranches = [];
  if (cohorts.includes("native")) {
    cohortBranches.push(nativeCohortBranch(start, end, includePastDue));
  }
  if (cohorts.includes("rolled")) {
    cohortBranches.push(rolledCohortBranch(start, end, includePastDue));
  }
  if (cohorts.includes("deliveryChanged")) {
    cohortBranches.push(deliveryChangedBranch(start, end, includePastDue));
  }

  const match = {
    ...orderStatusExcludeMatch(),
    ...NON_DEALER_QUOTA_MATCH,
    plantName: plantId,
    ...(subtypeId ? { plantSubtype: subtypeId } : {}),
    ...(statuses.length ? { orderStatus: { $in: statuses } } : {}),
    // Hard delivery-date window unless backlog toggle is on (cohort $or cannot bypass range).
    ...(!includePastDue ? deliveryInRange(start, end) : {}),
    $or: cohortBranches,
  };

  return {
    match,
    meta: {
      rangeStart: start,
      rangeEnd: end,
      cohorts,
      statuses,
      includePastDue,
      advanceFilters,
      plantId: String(plantId),
      subtypeId: subtypeId ? String(subtypeId) : null,
    },
  };
}

function basePipeline(parsed) {
  return [
    { $match: parsed.match },
    { $addFields: LINE_PLANT_TOTAL_ADD_FIELDS },
    ADVANCE_PAYMENT_ADD_FIELDS,
    ADVANCE_SUMS_ADD_FIELDS,
    ...(advancePaymentMatch(parsed.meta.advanceFilters)
      ? [{ $match: advancePaymentMatch(parsed.meta.advanceFilters) }]
      : []),
  ];
}

export async function fetchDeliveryReportSummary(query) {
  const parsed = parseDeliveryReportQuery(query);
  if (parsed.error) return parsed;

  const { rangeStart, rangeEnd } = parsed.meta;
  const pipeline = [
    ...basePipeline(parsed),
    cohortFlagsAddFields(rangeStart, rangeEnd),
    {
      $addFields: {
        _totalAmount: {
          $multiply: [
            { $ifNull: ["$linePlantTotal", 0] },
            { $ifNull: ["$rate", 0] },
          ],
        },
        _cohortTags: {
          $filter: {
            input: [
              {
                $cond: [
                  {
                    $and: [
                      "$_deliveryInRange",
                      { $not: "$_isRolled" },
                    ],
                  },
                  "native",
                  null,
                ],
              },
              {
                $cond: [
                  {
                    $and: ["$_deliveryInRange", "$_isRolled"],
                  },
                  "rolled",
                  null,
                ],
              },
              {
                $cond: ["$_hasChangeInRange", "deliveryChanged", null],
              },
            ],
            as: "t",
            cond: { $ne: ["$$t", null] },
          },
        },
      },
    },
    {
      $facet: {
        totals: [
          {
            $group: {
              _id: null,
              orders: { $sum: 1 },
              plants: { $sum: "$linePlantTotal" },
              amount: { $sum: "$_totalAmount" },
              advanceCollectedOrders: {
                $sum: { $cond: [{ $gt: ["$_advanceCollected", 0] }, 1, 0] },
              },
              advancePendingOrders: {
                $sum: { $cond: [{ $gt: ["$_advancePending", 0] }, 1, 0] },
              },
            },
          },
        ],
        byStatus: [
          {
            $group: {
              _id: "$orderStatus",
              orders: { $sum: 1 },
              plants: { $sum: "$linePlantTotal" },
              amount: { $sum: "$_totalAmount" },
            },
          },
          { $sort: { plants: -1 } },
          {
            $project: {
              _id: 0,
              status: "$_id",
              orders: 1,
              plants: 1,
              amount: 1,
            },
          },
        ],
        byCohort: [
          { $unwind: "$_cohortTags" },
          {
            $group: {
              _id: "$_cohortTags",
              orders: { $sum: 1 },
              plants: { $sum: "$linePlantTotal" },
              amount: { $sum: "$_totalAmount" },
            },
          },
          { $sort: { plants: -1 } },
          {
            $project: {
              _id: 0,
              cohort: "$_id",
              orders: 1,
              plants: 1,
              amount: 1,
            },
          },
        ],
      },
    },
  ];

  const [facet] = await Order.aggregate(pipeline).allowDiskUse(true);
  const totals = facet?.totals?.[0] || {
    orders: 0,
    plants: 0,
    amount: 0,
    advanceCollectedOrders: 0,
    advancePendingOrders: 0,
  };

  return {
    data: {
      totals: {
        orders: totals.orders,
        plants: totals.plants,
        amount: totals.amount,
      },
      byStatus: facet?.byStatus || [],
      byCohort: facet?.byCohort || [],
      byPayment: {
        advanceCollected: totals.advanceCollectedOrders,
        advancePending: totals.advancePendingOrders,
      },
      filters: parsed.meta,
    },
  };
}

export async function fetchDeliveryReportOrders(query) {
  const parsed = parseDeliveryReportQuery(query);
  if (parsed.error) return parsed;

  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || 50));
  const skip = (page - 1) * limit;

  const { rangeStart, rangeEnd } = parsed.meta;

  const pipeline = [
    ...basePipeline(parsed),
    cohortFlagsAddFields(rangeStart, rangeEnd),
    { $sort: { deliveryDate: 1, orderId: 1 } },
    {
      $facet: {
        metadata: [{ $count: "total" }],
        data: [
          { $skip: skip },
          { $limit: limit },
          {
            $project: {
              orderId: 1,
              orderStatus: 1,
              numberOfPlants: 1,
              additionalPlants: 1,
              linePlantTotal: 1,
              rate: 1,
              orderBookingDate: 1,
              deliveryDate: 1,
              orderPaymentStatus: 1,
              paymentCompleted: 1,
              plantName: 1,
              plantSubtype: 1,
              farmer: 1,
              salesPerson: 1,
              orderFor: 1,
              deliveryChanges: 1,
              dispatchedFromAnotherSlot: 1,
              pastDueSlotRollover: 1,
              pastDueSlotRolloverAt: 1,
              payment: 1,
              dispatchHistory: 1,
              _advanceCollected: 1,
              _advancePending: 1,
              _isRolled: 1,
              _hasChangeInRange: 1,
              _deliveryInRange: 1,
            },
          },
        ],
      },
    },
  ];

  const [facet] = await Order.aggregate(pipeline).allowDiskUse(true);
  const total = facet?.metadata?.[0]?.total || 0;
  let orders = facet?.data || [];

  orders = await hydrateMisOrderDrawerList(orders);

  orders = orders.map((o) => {
    const adv = sumOrderAdvancePayments(o);
    return {
      ...o,
      advanceCollected: adv.completed,
      advancePending: adv.pending,
      cohortTags: [
        o._deliveryInRange && !o._isRolled ? "native" : null,
        o._deliveryInRange && o._isRolled ? "rolled" : null,
        o._hasChangeInRange ? "deliveryChanged" : null,
      ].filter(Boolean),
      plants: (Number(o.numberOfPlants) || 0) + (Number(o.additionalPlants) || 0),
      amount: ((Number(o.numberOfPlants) || 0) + (Number(o.additionalPlants) || 0)) * (Number(o.rate) || 0),
    };
  });

  return {
    data: {
      orders,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 0,
      filters: parsed.meta,
    },
  };
}
