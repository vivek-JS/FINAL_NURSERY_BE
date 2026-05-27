import Order from "../models/order.model.js";
import {
  LINE_PLANT_TOTAL_ADD_FIELDS,
  orderStatusExcludeMatch,
  parseYmdRange,
} from "../utility/istOrderDateStats.js";
import {
  aggregateDueSummary,
  duePipelineMatch,
} from "../utility/adminMisDue.js";
import {
  aggregateGlobalStatusByGroup,
  aggregateAcceptedByDeliveryAndGroup,
  aggregateTransitionsByGroup,
  aggregatePipelineByGroup,
  aggregateDeliveryUnionByGroup,
  aggregateDeliveryInRangeByGroup,
  buildBreakdownTableFromMetrics,
} from "../utility/adminMisMetrics.js";

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

const SALES_GROUP_ID = {
  personId: "$salesPerson",
  personName: "$_personName",
  phoneNumber: "$_personPhone",
  jobTitle: "$_personJobTitle",
};

const DEALER_GROUP_ID = {
  personId: "$dealer",
  personName: "$_dealerName",
  phoneNumber: "$_dealerPhone",
};

function personEntityKey(row) {
  const id = row._id?.personId ?? row.personId;
  return id != null ? String(id) : "";
}

function metaFromBookingRow(key, booking) {
  return {
    personId: booking?.personId ?? key,
    personName: booking?.personName ?? "Unknown",
    phoneNumber: booking?.phoneNumber,
    jobTitle: booking?.jobTitle,
  };
}

function rowToBookingShape(row) {
  const id = row._id ?? row;
  return {
    personId: id.personId ?? row.personId,
    personName: id.personName ?? row.personName,
    phoneNumber: id.phoneNumber ?? row.phoneNumber,
    jobTitle: id.jobTitle ?? row.jobTitle,
    bookingOrders: row.bookingOrders ?? row.orders ?? 0,
    bookingPlants: row.bookingPlants ?? row.plants ?? 0,
  };
}

async function fetchPersonBreakdownMetrics(
  rangeStart,
  rangeEnd,
  { groupStages, groupIdFields, extraMatch = {}, dueOnly = false }
) {
  const statusMatch = orderStatusExcludeMatch();
  const mergedExtra = { ...extraMatch, ...(dueOnly ? duePipelineMatch() : {}) };

  const [
    bookingRows,
    globalFarmReadyRows,
    globalRfdRows,
    acceptedRows,
    dispatchedRows,
    completedRows,
    pipelineRows,
    deliveryUnionRows,
    deliveryInRangeRows,
  ] = await Promise.all([
    Order.aggregate([
      {
        $match: {
          ...statusMatch,
          ...mergedExtra,
          orderBookingDate: { $gte: rangeStart, $lte: rangeEnd },
        },
      },
      { $addFields: LINE_PLANT_TOTAL_ADD_FIELDS },
      ...groupStages,
      {
        $group: {
          _id: groupIdFields,
          bookingOrders: { $sum: 1 },
          bookingPlants: { $sum: "$linePlantTotal" },
        },
      },
    ]),
    aggregateGlobalStatusByGroup(
      "FARM_READY",
      statusMatch,
      groupStages,
      groupIdFields,
      mergedExtra
    ),
    aggregateGlobalStatusByGroup(
      "READY_FOR_DISPATCH",
      statusMatch,
      groupStages,
      groupIdFields,
      mergedExtra
    ),
    aggregateAcceptedByDeliveryAndGroup(
      rangeStart,
      rangeEnd,
      statusMatch,
      groupStages,
      groupIdFields,
      mergedExtra
    ),
    aggregateTransitionsByGroup(
      "DISPATCHED",
      rangeStart,
      rangeEnd,
      statusMatch,
      groupStages,
      groupIdFields,
      mergedExtra
    ),
    aggregateTransitionsByGroup(
      "COMPLETED",
      rangeStart,
      rangeEnd,
      statusMatch,
      groupStages,
      groupIdFields,
      mergedExtra
    ),
    aggregatePipelineByGroup(
      rangeStart,
      rangeEnd,
      statusMatch,
      groupStages,
      groupIdFields,
      mergedExtra
    ),
    dueOnly
      ? Promise.resolve([])
      : aggregateDeliveryUnionByGroup(
          rangeStart,
          rangeEnd,
          statusMatch,
          groupStages,
          groupIdFields,
          extraMatch
        ),
    dueOnly
      ? aggregateDeliveryInRangeByGroup(
          rangeStart,
          rangeEnd,
          statusMatch,
          groupStages,
          groupIdFields,
          mergedExtra
        )
      : Promise.resolve(null),
  ]);

  const bookingShaped = bookingRows.map(rowToBookingShape);

  return buildBreakdownTableFromMetrics({
    bookingRows: bookingShaped,
    entityKeyFn: personEntityKey,
    labelFromKey: metaFromBookingRow,
    globalFarmReadyRows,
    globalRfdRows,
    acceptedRows,
    dispatchedRows,
    completedRows,
    pipelineRows,
    deliveryUnionRows,
    deliveryInRangeRows: dueOnly ? deliveryInRangeRows : null,
  });
}

function parseRange(startDate, endDate) {
  const parsed = parseYmdRange(startDate, endDate);
  if (parsed.error) {
    return { error: parsed.error, statusCode: 400 };
  }
  return parsed;
}

export async function fetchAdminSalesMis(startDate, endDate, options = {}) {
  const { dueOnly = false, includeAllPastDue = false } = options;
  const parsed = parseRange(startDate, endDate);
  if (parsed.error) {
    return { error: parsed.error, statusCode: 400 };
  }
  const { rangeStart, rangeEnd, startYmd, endYmd } = parsed;

  const [table, dueSummary] = await Promise.all([
    fetchPersonBreakdownMetrics(rangeStart, rangeEnd, {
      groupStages: SALES_PERSON_STAGES,
      groupIdFields: SALES_GROUP_ID,
      dueOnly,
    }),
    aggregateDueSummary(rangeStart, rangeEnd, { dueOnly }),
  ]);

  if (includeAllPastDue && dueSummary?.combined) {
    table.totals.delivery.total = { ...dueSummary.combined };
  }

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

  const dealerMatch = {
    dealerOrder: true,
    dealer: { $exists: true, $ne: null },
  };

  const [table, dueSummary] = await Promise.all([
    fetchPersonBreakdownMetrics(rangeStart, rangeEnd, {
      groupStages: DEALER_STAGES,
      groupIdFields: DEALER_GROUP_ID,
      extraMatch: dealerMatch,
      dueOnly,
    }),
    aggregateDueSummary(rangeStart, rangeEnd, { dueOnly }),
  ]);

  if (includeAllPastDue && dueSummary?.combined) {
    table.totals.delivery.total = { ...dueSummary.combined };
  }

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
