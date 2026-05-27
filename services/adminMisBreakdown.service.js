import Order from "../models/order.model.js";
import {
  LINE_PLANT_TOTAL_ADD_FIELDS,
  orderStatusExcludeMatch,
  parseYmdRange,
} from "../utility/istOrderDateStats.js";
import { buildPersonBreakdownTable } from "../utility/adminDailyMisMerge.js";
import {
  aggregateDueSummary,
  misDeliveryStatusMatch,
} from "../utility/adminMisDue.js";

const REMAINING_STATUSES = [
  "READY_FOR_DISPATCH",
  "DISPATCH_PROCESS",
  "PARTIALLY_COMPLETED",
];

const SALES_PERSON_STAGES = [
  {
    $lookup: {
      from: "users",
      localField: "salesPerson",
      foreignField: "_id",
      as: "_personData",
      pipeline: [{ $project: { name: 1, phoneNumber: 1, jobTitle: 1 } }],
    },
  },
  {
    $addFields: {
      _personName: { $ifNull: [{ $arrayElemAt: ["$_personData.name", 0] }, "Unknown"] },
      _personPhone: { $arrayElemAt: ["$_personData.phoneNumber", 0] },
      _personJobTitle: { $arrayElemAt: ["$_personData.jobTitle", 0] },
    },
  },
];

const DEALER_STAGES = [
  {
    $lookup: {
      from: "users",
      localField: "dealer",
      foreignField: "_id",
      as: "_dealerData",
      pipeline: [{ $project: { name: 1, phoneNumber: 1 } }],
    },
  },
  {
    $addFields: {
      _dealerName: { $ifNull: [{ $arrayElemAt: ["$_dealerData.name", 0] }, "Unknown"] },
      _dealerPhone: { $arrayElemAt: ["$_dealerData.phoneNumber", 0] },
    },
  },
];

function parseRange(startDate, endDate) {
  const parsed = parseYmdRange(startDate, endDate);
  if (parsed.error) {
    return { error: parsed.error, statusCode: 400 };
  }
  return parsed;
}

async function aggregateSalesRows(rangeStart, rangeEnd, statusMatch, deliveryMatch) {
  const [bookingRows, deliveryRows] = await Promise.all([
    Order.aggregate([
      {
        $match: {
          ...statusMatch,
          orderBookingDate: { $gte: rangeStart, $lte: rangeEnd },
        },
      },
      { $addFields: LINE_PLANT_TOTAL_ADD_FIELDS },
      ...SALES_PERSON_STAGES,
      {
        $group: {
          _id: {
            personId: "$salesPerson",
            personName: "$_personName",
            phoneNumber: "$_personPhone",
            jobTitle: "$_personJobTitle",
          },
          bookingOrders: { $sum: 1 },
          bookingPlants: { $sum: "$linePlantTotal" },
        },
      },
      {
        $project: {
          _id: 0,
          personId: "$_id.personId",
          personName: "$_id.personName",
          phoneNumber: "$_id.phoneNumber",
          jobTitle: "$_id.jobTitle",
          bookingOrders: 1,
          bookingPlants: 1,
        },
      },
    ]),
    Order.aggregate([
      {
        $match: {
          ...deliveryMatch,
          deliveryDate: { $gte: rangeStart, $lte: rangeEnd, $ne: null },
        },
      },
      { $addFields: LINE_PLANT_TOTAL_ADD_FIELDS },
      ...SALES_PERSON_STAGES,
      {
        $group: {
          _id: {
            personId: "$salesPerson",
            personName: "$_personName",
            phoneNumber: "$_personPhone",
            jobTitle: "$_personJobTitle",
            status: "$orderStatus",
          },
          orders: { $sum: 1 },
          plants: { $sum: "$linePlantTotal" },
          plantsRemaining: {
            $sum: {
              $cond: [
                { $in: ["$orderStatus", REMAINING_STATUSES] },
                { $ifNull: ["$remainingPlants", 0] },
                0,
              ],
            },
          },
        },
      },
    ]),
  ]);
  return buildPersonBreakdownTable(bookingRows, deliveryRows);
}

async function aggregateDealerRows(rangeStart, rangeEnd, statusMatch, deliveryMatch) {
  const dealerMatch = {
    dealerOrder: true,
    dealer: { $exists: true, $ne: null },
  };

  const [bookingRows, deliveryRows] = await Promise.all([
    Order.aggregate([
      {
        $match: {
          ...statusMatch,
          ...dealerMatch,
          orderBookingDate: { $gte: rangeStart, $lte: rangeEnd },
        },
      },
      { $addFields: LINE_PLANT_TOTAL_ADD_FIELDS },
      ...DEALER_STAGES,
      {
        $group: {
          _id: {
            personId: "$dealer",
            personName: "$_dealerName",
            phoneNumber: "$_dealerPhone",
          },
          bookingOrders: { $sum: 1 },
          bookingPlants: { $sum: "$linePlantTotal" },
        },
      },
      {
        $project: {
          _id: 0,
          personId: "$_id.personId",
          personName: "$_id.personName",
          phoneNumber: "$_id.phoneNumber",
          bookingOrders: 1,
          bookingPlants: 1,
        },
      },
    ]),
    Order.aggregate([
      {
        $match: {
          ...deliveryMatch,
          ...dealerMatch,
          deliveryDate: { $gte: rangeStart, $lte: rangeEnd, $ne: null },
        },
      },
      { $addFields: LINE_PLANT_TOTAL_ADD_FIELDS },
      ...DEALER_STAGES,
      {
        $group: {
          _id: {
            personId: "$dealer",
            personName: "$_dealerName",
            phoneNumber: "$_dealerPhone",
            status: "$orderStatus",
          },
          orders: { $sum: 1 },
          plants: { $sum: "$linePlantTotal" },
          plantsRemaining: {
            $sum: {
              $cond: [
                { $in: ["$orderStatus", REMAINING_STATUSES] },
                { $ifNull: ["$remainingPlants", 0] },
                0,
              ],
            },
          },
        },
      },
    ]),
  ]);
  return buildPersonBreakdownTable(bookingRows, deliveryRows);
}

export async function fetchAdminSalesMis(startDate, endDate, options = {}) {
  const { dueOnly = false, includeAllPastDue = false } = options;
  const parsed = parseRange(startDate, endDate);
  if (parsed.error) {
    return { error: parsed.error, statusCode: 400 };
  }
  const { rangeStart, rangeEnd, startYmd, endYmd } = parsed;
  const statusMatch = orderStatusExcludeMatch();
  const deliveryMatch = misDeliveryStatusMatch(dueOnly);
  const [table, dueSummary] = await Promise.all([
    aggregateSalesRows(rangeStart, rangeEnd, statusMatch, deliveryMatch),
    aggregateDueSummary(rangeStart, rangeEnd, { dueOnly }),
  ]);

  return {
    data: {
      timezone: "Asia/Kolkata",
      startDate: startYmd,
      endDate: endYmd,
      rows: table.rows,
      totals: table.totals,
      dueSummary,
      dueOnly,
      includeAllPastDue,
    },
  };
}

export async function fetchAdminDealerMis(startDate, endDate, options = {}) {
  const { dueOnly = false, includeAllPastDue = false } = options;
  const parsed = parseRange(startDate, endDate);
  if (parsed.error) {
    return { error: parsed.error, statusCode: 400 };
  }
  const { rangeStart, rangeEnd, startYmd, endYmd } = parsed;
  const statusMatch = orderStatusExcludeMatch();
  const deliveryMatch = misDeliveryStatusMatch(dueOnly);
  const [table, dueSummary] = await Promise.all([
    aggregateDealerRows(rangeStart, rangeEnd, statusMatch, deliveryMatch),
    aggregateDueSummary(rangeStart, rangeEnd, { dueOnly }),
  ]);

  return {
    data: {
      timezone: "Asia/Kolkata",
      startDate: startYmd,
      endDate: endYmd,
      rows: table.rows,
      totals: table.totals,
      dueSummary,
      dueOnly,
      includeAllPastDue,
    },
  };
}
