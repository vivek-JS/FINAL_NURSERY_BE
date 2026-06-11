import { fetchAdminSalesMis, fetchAdminDealerMis } from "../../../services/adminMisBreakdown.service.js";
import { buildMisOrdersMatch } from "../../../services/adminMisOrders.service.js";
import { aggregateGeoBreakdown } from "../utility/ceoGeoBreakdown.js";
import { parseCeoReportQuery, resolvePeriodWindow } from "../utility/ceoQueryParams.js";
import Order from "../../../models/order.model.js";
import { LINE_PLANT_TOTAL_ADD_FIELDS } from "../../../utility/istOrderDateStats.js";

const GEO_GROUPS = new Set(["taluka", "village", "district"]);

export async function fetchCeoOrderDeliveryBreakdown(query = {}) {
  const opts = parseCeoReportQuery(query);
  if (opts.error) return { error: opts.error, statusCode: 400 };

  const groupBy = String(query.groupBy || "plant").toLowerCase();
  const bucket = String(query.bucket || "deliveryTotal").trim();
  if (!bucket) return { error: "bucket is required", statusCode: 400 };

  const baseWindow = {
    startYmd: opts.startYmd,
    endYmd: opts.endYmd,
    rangeStart: opts.rangeStart,
    rangeEnd: opts.rangeEnd,
  };
  const window = resolvePeriodWindow(query, baseWindow);
  if (window.error) return { error: window.error, statusCode: 400 };

  if (GEO_GROUPS.has(groupBy)) {
    const matchSpec = buildMisOrdersMatch(
      { ...query, bucket, startDate: window.startYmd, endDate: window.endYmd },
      window
    );
    const bucketMatch =
      matchSpec?.kind === "transition" ? {} : matchSpec;
    const geo = await aggregateGeoBreakdown(groupBy, window.rangeStart, window.rangeEnd, {
      bucketMatch: typeof bucketMatch === "object" ? bucketMatch : {},
      taluka: query.taluka,
      village: query.village,
      district: query.district,
    });
    return {
      data: {
        groupBy,
        bucket,
        periodKey: window.periodKey || null,
        rows: geo.rows,
      },
    };
  }

  if (groupBy === "sales") {
    const result = await fetchAdminSalesMis(window.startYmd, window.endYmd, {
      dueOnly: opts.dueOnly,
      includeAllPastDue: opts.includeAllPastDue,
    });
    return {
      data: {
        groupBy: "sales",
        bucket,
        rows: filterBreakdownRows(result?.data?.rows, bucket),
        totals: result?.data?.totals,
      },
    };
  }

  if (groupBy === "dealer") {
    const result = await fetchAdminDealerMis(window.startYmd, window.endYmd, {
      dueOnly: opts.dueOnly,
      includeAllPastDue: opts.includeAllPastDue,
    });
    return {
      data: {
        groupBy: "dealer",
        bucket,
        rows: filterBreakdownRows(result?.data?.rows, bucket),
        totals: result?.data?.totals,
      },
    };
  }

  if (groupBy === "plant") {
    const rows = await aggregatePlantBreakdown(window, bucket, opts.extraMatch);
    return { data: { groupBy: "plant", bucket, rows } };
  }

  return { error: `Unsupported groupBy: ${groupBy}`, statusCode: 400 };
}

function filterBreakdownRows(rows, bucket) {
  if (!rows?.length) return [];
  if (bucket === "booking") {
    return rows.map((r) => ({
      personId: r.personId,
      personName: r.personName,
      orders: r.booking?.orders ?? 0,
      plants: r.booking?.plants ?? 0,
    }));
  }
  const dKey =
    bucket === "dispatched"
      ? "dispatched"
      : bucket === "completed"
        ? "completed"
        : bucket === "deliveryTotal"
          ? "total"
          : bucket;
  return rows.map((r) => ({
    personId: r.personId,
    personName: r.personName,
    orders: r.delivery?.[dKey]?.orders ?? 0,
    plants: r.delivery?.[dKey]?.plants ?? 0,
  }));
}

async function aggregatePlantBreakdown(window, bucket, extraMatch) {
  const match = buildMisOrdersMatch(
    { bucket, startDate: window.startYmd, endDate: window.endYmd },
    window
  );
  if (match?.kind === "transition") {
    return [];
  }

  const rows = await Order.aggregate([
    { $match: { ...match, ...extraMatch } },
    {
      $lookup: {
        from: "plantcms",
        localField: "plantName",
        foreignField: "_id",
        as: "_plant",
        pipeline: [{ $project: { name: 1, subtypes: 1 } }],
      },
    },
    {
      $addFields: {
        _plantRow: { $arrayElemAt: ["$_plant", 0] },
        _plantName: { $ifNull: [{ $arrayElemAt: ["$_plant.name", 0] }, "Unknown"] },
      },
    },
    { $addFields: LINE_PLANT_TOTAL_ADD_FIELDS },
    {
      $group: {
        _id: { plantId: "$plantName", plantName: "$_plantName" },
        orders: { $sum: 1 },
        plants: { $sum: "$linePlantTotal" },
      },
    },
    { $sort: { plants: -1 } },
    {
      $project: {
        _id: 0,
        plantId: "$_id.plantId",
        name: "$_id.plantName",
        orders: 1,
        plants: 1,
      },
    },
  ]);
  return rows;
}
