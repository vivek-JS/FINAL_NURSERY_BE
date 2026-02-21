import { Parser } from "json2csv";
import OldSalesData from "../models/oldSalesData.model.js";
import OldSalesChangeLog from "../models/oldSalesChangeLog.model.js";
import catchAsync from "../utility/catchAsync.js";
import AppError from "../utility/appError.js";

const parseList = (value) => {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((item) => item.toString().trim()).filter(Boolean);
  return value
    .toString()
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
};

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const buildMatch = (query) => {
  const match = {};

  if (query.startDate || query.endDate) {
    const range = {};
    if (query.startDate) {
      const start = new Date(query.startDate);
      if (!Number.isNaN(start.getTime())) {
        start.setHours(0, 0, 0, 0);
        range.$gte = start;
      }
    }
    if (query.endDate) {
      const end = new Date(query.endDate);
      if (!Number.isNaN(end.getTime())) {
        end.setHours(23, 59, 59, 999);
        range.$lte = end;
      }
    }
    if (Object.keys(range).length) {
      match.deliveryDate = range;
    }
  }

  const listFilters = [
    "district",
    "taluka",
    "village",
    "plant",
    "variety",
    "media",
    "batch",
    "paymentMode",
    "reference",
    "marketingReference",
    "billGivenOrNot",
    "verifiedOrNot",
    "shadeNo",
    "vehicleNo",
    "driverName",
  ];

  listFilters.forEach((field) => {
    const list = parseList(query[field]);
    if (list.length) {
      match[field] = { $in: list };
    }
  });

  const searchFilters = [
    "customerName",
    "bookingNo",
    "mobileNo",
  ];

  searchFilters.forEach((field) => {
    if (query[field]) {
      match[field] = { $regex: escapeRegex(query[field].toString()), $options: "i" };
    }
  });

  // Generic search: q or search searches across customerName, mobileNo, village, taluka, district
  const q = query.q || query.search;
  if (q && typeof q === "string" && q.trim()) {
    const regex = { $regex: escapeRegex(q.trim()), $options: "i" };
    match.$or = [
      { customerName: regex },
      { mobileNo: regex },
      { village: regex },
      { taluka: regex },
      { district: regex },
    ];
  }

  return match;
};

const sumField = (field) => ({
  $sum: { $ifNull: [`$${field}`, 0] },
});

const buildSalesPersonName = () => ({
  $ifNull: [
    { $ifNull: ["$marketingReference", "$reference"] },
    "Unknown",
  ],
});

const QUALITY_FIELDS = new Set([
  "village",
  "district",
  "taluka",
  "plant",
  "variety",
  "media",
  "batch",
]);

const normalizeText = (value) =>
  value
    .toString()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const diceSimilarity = (a, b) => {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;

  const bigrams = (str) => {
    const res = [];
    for (let i = 0; i < str.length - 1; i += 1) {
      res.push(str.slice(i, i + 2));
    }
    return res;
  };

  const aBigrams = bigrams(a);
  const bBigrams = bigrams(b);
  const bCounts = new Map();

  bBigrams.forEach((gram) => {
    bCounts.set(gram, (bCounts.get(gram) || 0) + 1);
  });

  let matches = 0;
  aBigrams.forEach((gram) => {
    const count = bCounts.get(gram) || 0;
    if (count > 0) {
      matches += 1;
      bCounts.set(gram, count - 1);
    }
  });

  return (2 * matches) / (aBigrams.length + bBigrams.length);
};

const parseNumberParam = (value, fallback) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
};

const normalizeCaseKey = (value) =>
  value?.toString?.().trim().toLowerCase() || "";

const getDistinctValues = async (field, filter = {}) => {
  const match = { [field]: { $nin: [null, ""] }, ...filter };
  const values = await OldSalesData.distinct(field, match);
  return values
    .map((value) => value?.toString().trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
};

/** GET /old-sales/filter-options - Cascading district/taluka/village + all other filters */
export const getOldSalesFilterOptions = catchAsync(async (req, res) => {
  const { district, taluka } = req.query;
  const talukaFilter = district ? { district } : {};
  const villageFilter = district && taluka ? { district, taluka } : district ? { district } : taluka ? { taluka } : {};

  const [districts, talukas, villages, plants, varieties, media, batches, paymentModes, references, marketingReferences, billGivenOptions, verifiedOptions, shadeNumbers, vehicleNumbers, driverNames] = await Promise.all([
    getDistinctValues("district"),
    getDistinctValues("taluka", talukaFilter),
    getDistinctValues("village", villageFilter),
    getDistinctValues("plant"),
    getDistinctValues("variety"),
    getDistinctValues("media"),
    getDistinctValues("batch"),
    getDistinctValues("paymentMode"),
    getDistinctValues("reference"),
    getDistinctValues("marketingReference"),
    getDistinctValues("billGivenOrNot"),
    getDistinctValues("verifiedOrNot"),
    getDistinctValues("shadeNo"),
    getDistinctValues("vehicleNo"),
    getDistinctValues("driverName"),
  ]);

  res.status(200).json({
    success: true,
    data: {
      district: districts,
      taluka: talukas,
      village: villages,
      plant: plants,
      variety: varieties,
      media: media,
      batch: batches,
      paymentMode: paymentModes,
      reference: references,
      marketingReference: marketingReferences,
      billGivenOrNot: billGivenOptions,
      verifiedOrNot: verifiedOptions,
      shadeNo: shadeNumbers,
      vehicleNo: vehicleNumbers,
      driverName: driverNames,
    },
  });
});

export const getOldSalesFilters = catchAsync(async (req, res) => {
  const [
    districts,
    talukas,
    villages,
    plants,
    varieties,
    media,
    batches,
    paymentModes,
    references,
    marketingReferences,
    billGivenOptions,
    verifiedOptions,
    shadeNumbers,
    vehicleNumbers,
    driverNames,
  ] = await Promise.all([
    getDistinctValues("district"),
    getDistinctValues("taluka"),
    getDistinctValues("village"),
    getDistinctValues("plant"),
    getDistinctValues("variety"),
    getDistinctValues("media"),
    getDistinctValues("batch"),
    getDistinctValues("paymentMode"),
    getDistinctValues("reference"),
    getDistinctValues("marketingReference"),
    getDistinctValues("billGivenOrNot"),
    getDistinctValues("verifiedOrNot"),
    getDistinctValues("shadeNo"),
    getDistinctValues("vehicleNo"),
    getDistinctValues("driverName"),
  ]);

  res.status(200).json({
    success: true,
    data: {
      district: districts,
      taluka: talukas,
      village: villages,
      plant: plants,
      variety: varieties,
      media: media,
      batch: batches,
      paymentMode: paymentModes,
      reference: references,
      marketingReference: marketingReferences,
      billGivenOrNot: billGivenOptions,
      verifiedOrNot: verifiedOptions,
      shadeNo: shadeNumbers,
      vehicleNo: vehicleNumbers,
      driverName: driverNames,
    },
  });
});

export const getOldSalesAnalytics = catchAsync(async (req, res) => {
  const match = buildMatch(req.query);
  const matchStage = Object.keys(match).length ? [{ $match: match }] : [];

  const summaryPipeline = [
    ...matchStage,
    {
      $group: {
        _id: null,
        totalRecords: { $sum: 1 },
        totalPlantQty: sumField("plantQty"),
        totalInvoiceAmount: sumField("totalInvoiceAmount"),
        totalAdvancePaid: sumField("advancePaid"),
        totalRemainingAmount: sumField("remainingAmount"),
        totalPaymentAmount: sumField("paymentAmount"),
        avgRate: { $avg: "$rate" },
        avgInvoiceAmount: { $avg: "$invoiceAmount" },
        minDeliveryDate: { $min: "$deliveryDate" },
        maxDeliveryDate: { $max: "$deliveryDate" },
      },
    },
  ];

  const summaryResult = await OldSalesData.aggregate(summaryPipeline);
  const summary = summaryResult[0] || {
    totalRecords: 0,
    totalPlantQty: 0,
    totalInvoiceAmount: 0,
    totalAdvancePaid: 0,
    totalRemainingAmount: 0,
    totalPaymentAmount: 0,
    avgRate: 0,
    avgInvoiceAmount: 0,
  };

  const timeSeries = await OldSalesData.aggregate([
    ...matchStage,
    { $match: { deliveryDate: { $type: "date" } } },
    {
      $group: {
        _id: {
          $dateToString: { format: "%Y-%m-%d", date: "$deliveryDate" },
        },
        totalInvoiceAmount: sumField("totalInvoiceAmount"),
        totalPlantQty: sumField("plantQty"),
        totalRecords: { $sum: 1 },
      },
    },
    { $sort: { _id: 1 } },
  ]);

  const topPlants = await OldSalesData.aggregate([
    ...matchStage,
    {
      $group: {
        _id: "$plant",
        totalInvoiceAmount: sumField("totalInvoiceAmount"),
        totalPlantQty: sumField("plantQty"),
        totalRecords: { $sum: 1 },
      },
    },
    { $sort: { totalInvoiceAmount: -1 } },
    { $limit: 10 },
  ]);

  const topVarieties = await OldSalesData.aggregate([
    ...matchStage,
    {
      $group: {
        _id: "$variety",
        totalInvoiceAmount: sumField("totalInvoiceAmount"),
        totalPlantQty: sumField("plantQty"),
        totalRecords: { $sum: 1 },
      },
    },
    { $sort: { totalInvoiceAmount: -1 } },
    { $limit: 10 },
  ]);

  const paymentModes = await OldSalesData.aggregate([
    ...matchStage,
    {
      $group: {
        _id: "$paymentMode",
        totalInvoiceAmount: sumField("totalInvoiceAmount"),
        totalRecords: { $sum: 1 },
      },
    },
    { $sort: { totalInvoiceAmount: -1 } },
  ]);

  const districts = await OldSalesData.aggregate([
    ...matchStage,
    {
      $group: {
        _id: "$district",
        totalInvoiceAmount: sumField("totalInvoiceAmount"),
        totalRecords: { $sum: 1 },
      },
    },
    { $sort: { totalInvoiceAmount: -1 } },
    { $limit: 10 },
  ]);

  const verificationStatus = await OldSalesData.aggregate([
    ...matchStage,
    {
      $group: {
        _id: "$verifiedOrNot",
        totalRecords: { $sum: 1 },
      },
    },
    { $sort: { totalRecords: -1 } },
  ]);

  const topCustomers = await OldSalesData.aggregate([
    ...matchStage,
    {
      $group: {
        _id: {
          customerName: "$customerName",
          mobileNo: "$mobileNo",
        },
        totalInvoiceAmount: sumField("totalInvoiceAmount"),
        totalPlantQty: sumField("plantQty"),
        totalRecords: { $sum: 1 },
      },
    },
    { $sort: { totalInvoiceAmount: -1 } },
    { $limit: 10 },
  ]);

  const repeatCustomerStatsResult = await OldSalesData.aggregate([
    ...matchStage,
    {
      $group: {
        _id: {
          customerName: "$customerName",
          mobileNo: "$mobileNo",
        },
        totalRecords: { $sum: 1 },
        totalInvoiceAmount: sumField("totalInvoiceAmount"),
      },
    },
    {
      $group: {
        _id: null,
        totalCustomers: { $sum: 1 },
        repeatCustomers: {
          $sum: { $cond: [{ $gt: ["$totalRecords", 1] }, 1, 0] },
        },
        totalOrders: { $sum: "$totalRecords" },
        repeatOrders: {
          $sum: { $cond: [{ $gt: ["$totalRecords", 1] }, "$totalRecords", 0] },
        },
        repeatRevenue: {
          $sum: {
            $cond: [{ $gt: ["$totalRecords", 1] }, "$totalInvoiceAmount", 0],
          },
        },
      },
    },
  ]);

  const repeatCustomerStats = repeatCustomerStatsResult[0] || {
    totalCustomers: 0,
    repeatCustomers: 0,
    totalOrders: 0,
    repeatOrders: 0,
    repeatRevenue: 0,
  };

  const topSalesPersons = await OldSalesData.aggregate([
    ...matchStage,
    {
      $group: {
        _id: buildSalesPersonName(),
        totalInvoiceAmount: sumField("totalInvoiceAmount"),
        totalPlantQty: sumField("plantQty"),
        totalRecords: { $sum: 1 },
      },
    },
    { $sort: { totalInvoiceAmount: -1 } },
    { $limit: 10 },
  ]);

  res.status(200).json({
    success: true,
    data: {
      summary,
      timeSeries: timeSeries.map((item) => ({
        date: item._id,
        totalInvoiceAmount: item.totalInvoiceAmount,
        totalPlantQty: item.totalPlantQty,
        totalRecords: item.totalRecords,
      })),
      plantBreakdown: topPlants.map((item) => ({
        name: item._id || "Unknown",
        totalInvoiceAmount: item.totalInvoiceAmount,
        totalPlantQty: item.totalPlantQty,
        totalRecords: item.totalRecords,
      })),
      varietyBreakdown: topVarieties.map((item) => ({
        name: item._id || "Unknown",
        totalInvoiceAmount: item.totalInvoiceAmount,
        totalPlantQty: item.totalPlantQty,
        totalRecords: item.totalRecords,
      })),
      paymentModeBreakdown: paymentModes.map((item) => ({
        name: item._id || "Unknown",
        totalInvoiceAmount: item.totalInvoiceAmount,
        totalRecords: item.totalRecords,
      })),
      districtBreakdown: districts.map((item) => ({
        name: item._id || "Unknown",
        totalInvoiceAmount: item.totalInvoiceAmount,
        totalRecords: item.totalRecords,
      })),
      verificationBreakdown: verificationStatus.map((item) => ({
        name: item._id || "Unknown",
        totalRecords: item.totalRecords,
      })),
      topCustomers: topCustomers.map((item) => ({
        customerName: item._id?.customerName || "Unknown",
        mobileNo: item._id?.mobileNo || "-",
        totalInvoiceAmount: item.totalInvoiceAmount,
        totalPlantQty: item.totalPlantQty,
        totalRecords: item.totalRecords,
      })),
      topSalesPersons: topSalesPersons.map((item) => ({
        name: item._id || "Unknown",
        totalInvoiceAmount: item.totalInvoiceAmount,
        totalPlantQty: item.totalPlantQty,
        totalRecords: item.totalRecords,
      })),
      repeatCustomerStats: {
        ...repeatCustomerStats,
        oneTimeCustomers:
          (repeatCustomerStats.totalCustomers || 0) -
          (repeatCustomerStats.repeatCustomers || 0),
      },
    },
  });
});

export const getOldSalesSuggestions = catchAsync(async (req, res, next) => {
  const field = req.query.field;
  if (!field || !QUALITY_FIELDS.has(field)) {
    return next(new AppError("Invalid field for suggestions", 400));
  }

  const minSimilarity = Math.min(
    Math.max(parseNumberParam(req.query.minSimilarity, 0.7), 0),
    1
  );
  const maxSimilarity = Math.min(
    Math.max(parseNumberParam(req.query.maxSimilarity, 0.9), 0),
    1
  );
  const minCount = Math.max(parseInt(req.query.minCount || "1", 10), 1);
  const referenceLimit = Math.max(
    parseInt(req.query.referenceLimit || "50", 10),
    10
  );
  const suggestionLimit = Math.max(
    parseInt(req.query.suggestionLimit || "3", 10),
    1
  );

  const aggregated = await OldSalesData.aggregate([
    { $match: { [field]: { $nin: [null, ""] } } },
    { $group: { _id: `$${field}`, count: { $sum: 1 } } },
    { $sort: { count: -1 } },
  ]);

  const referenceValues = aggregated
    .slice(0, referenceLimit)
    .map((item) => item._id)
    .filter(Boolean);

  const referenceMap = referenceValues.map((value) => ({
    value,
    normalized: normalizeText(value),
  }));

  const referenceSet = new Set(referenceValues.map((value) => value.toString()));

  const suggestions = [];

  aggregated.forEach((item) => {
    if (!item?._id) return;
    if (item.count < minCount) return;
    if (referenceSet.has(item._id.toString())) return;

    const candidate = item._id.toString();
    const normalizedCandidate = normalizeText(candidate);
    if (!normalizedCandidate) return;

    const candidateSuggestions = referenceMap
      .map((ref) => ({
        value: ref.value,
        similarity: diceSimilarity(normalizedCandidate, ref.normalized),
      }))
      .filter(
        (suggestion) =>
          suggestion.similarity >= minSimilarity &&
          suggestion.similarity <= maxSimilarity
      )
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, suggestionLimit);

    if (candidateSuggestions.length) {
      suggestions.push({
        value: candidate,
        count: item.count,
        suggestions: candidateSuggestions,
      });
    }
  });

  res.status(200).json({
    success: true,
    data: {
      field,
      referenceValues,
      suggestions,
      thresholds: {
        minSimilarity,
        maxSimilarity,
        minCount,
        referenceLimit,
        suggestionLimit,
      },
    },
  });
});

export const normalizeOldSalesField = catchAsync(async (req, res, next) => {
  const { field, fromValue, toValue, similarity, reason, recordId, source } =
    req.body || {};

  if (!field || !QUALITY_FIELDS.has(field)) {
    return next(new AppError("Invalid field for normalization", 400));
  }
  if (!toValue || toValue.toString().trim() === "") {
    return next(new AppError("New value is required", 400));
  }

  let affectedCount = 0;
  let previousValue = fromValue;
  let scope = "bulk";

  if (recordId) {
    const record = await OldSalesData.findById(recordId);
    if (!record) {
      return next(new AppError("Record not found", 404));
    }
    previousValue = record[field];
    record[field] = toValue;
    await record.save();
    affectedCount = 1;
    scope = "single";
  } else {
    if (fromValue === undefined || fromValue === null) {
      return next(new AppError("fromValue is required for bulk update", 400));
    }
    const updateResult = await OldSalesData.updateMany(
      { [field]: fromValue },
      { $set: { [field]: toValue } }
    );
    affectedCount = updateResult.modifiedCount || updateResult.nModified || 0;
  }

  const similarityValue =
    similarity !== undefined && similarity !== null ? Number(similarity) : null;
  const warning = similarityValue !== null ? similarityValue < 0.8 : false;

  await OldSalesChangeLog.create({
    field,
    fromValue: previousValue?.toString?.() ?? fromValue?.toString?.(),
    toValue: toValue.toString(),
    similarity: similarityValue,
    warning,
    scope,
    affectedCount,
    reason,
    changedBy: req.user?._id,
    metadata: {
      source: source || "manual",
      recordId: recordId || null,
    },
  });

  res.status(200).json({
    success: true,
    data: {
      affectedCount,
      field,
      fromValue: previousValue ?? fromValue,
      toValue,
      warning,
    },
  });
});

export const getOldSalesChangeLogs = catchAsync(async (req, res) => {
  const page = Math.max(parseInt(req.query.page || "1", 10), 1);
  const limit = Math.max(parseInt(req.query.limit || "20", 10), 1);
  const skip = (page - 1) * limit;

  const [logs, total] = await Promise.all([
    OldSalesChangeLog.find()
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("changedBy", "name phoneNumber")
      .lean(),
    OldSalesChangeLog.countDocuments(),
  ]);

  res.status(200).json({
    success: true,
    data: {
      logs,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    },
  });
});

export const getOldSalesRepeatCustomers = catchAsync(async (req, res) => {
  const match = buildMatch(req.query);
  const matchStage = Object.keys(match).length ? [{ $match: match }] : [];
  const minOrders = Math.max(parseInt(req.query.minOrders || "2", 10), 2);
  const limit = Math.max(parseInt(req.query.limit || "20", 10), 1);

  const repeatCustomers = await OldSalesData.aggregate([
    ...matchStage,
    {
      $group: {
        _id: {
          customerName: "$customerName",
          mobileNo: "$mobileNo",
        },
        totalRecords: { $sum: 1 },
        totalInvoiceAmount: sumField("totalInvoiceAmount"),
        totalPlantQty: sumField("plantQty"),
        firstDeliveryDate: { $min: "$deliveryDate" },
        lastDeliveryDate: { $max: "$deliveryDate" },
        lastPaymentMode: { $last: "$paymentMode" },
      },
    },
    { $match: { totalRecords: { $gte: minOrders } } },
    { $sort: { totalInvoiceAmount: -1 } },
    { $limit: limit },
  ]);

  res.status(200).json({
    success: true,
    data: {
      minOrders,
      limit,
      customers: repeatCustomers.map((item) => ({
        customerName: item._id?.customerName || "Unknown",
        mobileNo: item._id?.mobileNo || "-",
        totalRecords: item.totalRecords,
        totalInvoiceAmount: item.totalInvoiceAmount,
        totalPlantQty: item.totalPlantQty,
        firstDeliveryDate: item.firstDeliveryDate,
        lastDeliveryDate: item.lastDeliveryDate,
        lastPaymentMode: item.lastPaymentMode,
      })),
    },
  });
});

export const getOldSalesGeoSummary = catchAsync(async (req, res) => {
  const match = buildMatch(req.query);
  const matchStage = Object.keys(match).length ? [{ $match: match }] : [];
  const limit = Math.max(parseInt(req.query.limit || "400", 10), 1);
  const sortBy = ["totalInvoiceAmount", "totalRecords", "totalPlantQty"].includes(req.query.sortBy)
    ? req.query.sortBy
    : "totalInvoiceAmount";
  const sortOrder = req.query.sortOrder === "asc" ? 1 : -1;

  const locations = await OldSalesData.aggregate([
    ...matchStage,
    {
      $match: {
        village: { $nin: [null, ""] },
        taluka: { $nin: [null, ""] },
        district: { $nin: [null, ""] },
      },
    },
    {
      $group: {
        _id: {
          village: "$village",
          taluka: "$taluka",
          district: "$district",
        },
        totalRecords: { $sum: 1 },
        totalInvoiceAmount: sumField("totalInvoiceAmount"),
        totalPlantQty: sumField("plantQty"),
      },
    },
    { $sort: { [sortBy]: sortOrder } },
    { $limit: limit },
  ]);

  res.status(200).json({
    success: true,
    data: {
      sortBy,
      limit,
      locations: locations.map((item) => ({
        village: item._id?.village || "Unknown",
        taluka: item._id?.taluka || "Unknown",
        district: item._id?.district || "Unknown",
        state: "Maharashtra",
        totalRecords: item.totalRecords,
        totalInvoiceAmount: item.totalInvoiceAmount,
        totalPlantQty: item.totalPlantQty,
      })),
    },
  });
});

/** Unique customers (farmers) from old sales for broadcast lists. Same filters as analytics/records. */
export const getOldSalesUniqueCustomers = catchAsync(async (req, res) => {
  const match = buildMatch(req.query);
  const matchStage = Object.keys(match).length ? [{ $match: match }] : [];
  const page = Math.max(parseInt(req.query.page || "1", 10), 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit || "50", 10), 1), 5000);
  const skip = (page - 1) * limit;

  // Aggregate unique mobile numbers with a lookup to farmers to fetch opt_in
  const pipeline = [
    ...matchStage,
    {
      $match: {
        mobileNo: { $nin: [null, ""] },
        $expr: { $gte: [{ $strLenCP: { $ifNull: ["$mobileNo", ""] } }, 10] },
      },
    },
    {
      $group: {
        _id: "$mobileNo",
        customerName: { $first: "$customerName" },
        village: { $first: "$village" },
        taluka: { $first: "$taluka" },
        district: { $first: "$district" },
        state: { $first: "$state" },
      },
    },
    {
      $project: {
        _id: 1,
        customerName: 1,
        village: 1,
        taluka: 1,
        district: 1,
        state: 1,
      },
    },
    // Lookup Farmer by matching mobile number string
    {
      $lookup: {
        from: "farmers",
        let: { mobile: "$_id" },
        pipeline: [
          {
            $addFields: {
              mobileStr: { $toString: "$mobileNumber" },
            },
          },
          {
            $match: {
              $expr: { $eq: ["$mobileStr", "$$mobile"] },
            },
          },
          { $project: { opt_in: 1, mobileNumber: 1 } },
        ],
        as: "farmerMatch",
      },
    },
    {
      $addFields: {
        opt_in: { $ifNull: [{ $arrayElemAt: ["$farmerMatch.opt_in", 0] }, null] },
      },
    },
    { $sort: { customerName: 1 } },
    {
      $facet: {
        metadata: [{ $count: "total" }],
        data: [{ $skip: skip }, { $limit: limit }],
      },
    },
  ];

  const result = await OldSalesData.aggregate(pipeline);
  const metadata = result[0]?.metadata?.[0] || { total: 0 };
  const customers = result[0]?.data || [];
  const total = metadata.total;
  const totalPages = Math.ceil(total / limit) || 1;
  const hasNextPage = page < totalPages;
  const nextPage = hasNextPage ? page + 1 : null;

  res.status(200).json({
    success: true,
    data: {
      pagination: {
        page,
        limit,
        total,
        totalPages,
        hasNextPage,
        nextPage,
      },
      customers: customers
        .map((c) => ({
          name: c.customerName || "",
          mobileNumber: (c._id || "").toString().trim(),
          customerName: c.customerName || "",
          mobileNo: (c._id || "").toString().trim(),
          village: c.village || "",
          taluka: c.taluka || "",
          district: c.district || "",
          state: c.state || "",
          opt_in: c.opt_in ?? null,
        }))
        .filter((c) => c.mobileNumber.length >= 10),
    },
  });
});

export const getOldSalesCaseMismatches = catchAsync(async (req, res, next) => {
  const field = req.query.field;
  if (!field || !QUALITY_FIELDS.has(field)) {
    return next(new AppError("Invalid field for case mismatches", 400));
  }

  const limit = Math.max(parseInt(req.query.limit || "50", 10), 1);
  const minVariants = Math.max(parseInt(req.query.minVariants || "2", 10), 2);

  const pipeline = [
    { $match: { [field]: { $nin: [null, ""] } } },
    {
      $project: {
        value: `$${field}`,
        normalized: {
          $toLower: {
            $trim: {
              input: `$${field}`,
            },
          },
        },
      },
    },
    {
      $group: {
        _id: { normalized: "$normalized", value: "$value" },
        count: { $sum: 1 },
      },
    },
    {
      $group: {
        _id: "$_id.normalized",
        totalCount: { $sum: "$count" },
        variants: {
          $push: {
            value: "$_id.value",
            count: "$count",
          },
        },
        variantCount: { $sum: 1 },
      },
    },
    { $match: { variantCount: { $gte: minVariants } } },
    { $sort: { totalCount: -1 } },
    { $limit: limit },
  ];

  const groups = await OldSalesData.aggregate(pipeline);

  const mismatches = groups.map((group) => {
    const sortedVariants = [...group.variants].sort((a, b) => b.count - a.count);
    return {
      normalizedKey: group._id,
      totalCount: group.totalCount,
      variants: sortedVariants,
      recommended: sortedVariants[0]?.value || "",
    };
  });

  res.status(200).json({
    success: true,
    data: {
      field,
      mismatches,
      minVariants,
      limit,
    },
  });
});

export const normalizeOldSalesCase = catchAsync(async (req, res, next) => {
  const { field, normalizedKey, toValue, reason, source } = req.body || {};

  if (!field || !QUALITY_FIELDS.has(field)) {
    return next(new AppError("Invalid field for case normalization", 400));
  }
  if (!normalizedKey) {
    return next(new AppError("normalizedKey is required", 400));
  }
  if (!toValue || toValue.toString().trim() === "") {
    return next(new AppError("New value is required", 400));
  }

  const normalized = normalizeCaseKey(normalizedKey);
  if (!normalized) {
    return next(new AppError("Invalid normalizedKey", 400));
  }

  const variants = await OldSalesData.aggregate([
    {
      $match: {
        $expr: {
          $eq: [
            {
              $toLower: {
                $trim: {
                  input: `$${field}`,
                },
              },
            },
            normalized,
          ],
        },
      },
    },
    {
      $group: {
        _id: `$${field}`,
        count: { $sum: 1 },
      },
    },
    { $sort: { count: -1 } },
  ]);

  const updateResult = await OldSalesData.updateMany(
    {
      $expr: {
        $eq: [
          {
            $toLower: {
              $trim: {
                input: `$${field}`,
              },
            },
          },
          normalized,
        ],
      },
    },
    { $set: { [field]: toValue } }
  );

  const affectedCount = updateResult.modifiedCount || updateResult.nModified || 0;

  await OldSalesChangeLog.create({
    field,
    fromValue: `case-group:${normalized}`,
    toValue: toValue.toString(),
    similarity: null,
    warning: false,
    scope: "bulk",
    affectedCount,
    reason,
    changedBy: req.user?._id,
    metadata: {
      source: source || "case-mismatch",
      normalizedKey: normalized,
      variants,
    },
  });

  res.status(200).json({
    success: true,
    data: {
      affectedCount,
      field,
      normalizedKey: normalized,
      toValue,
    },
  });
});

export const getOldSalesRecords = catchAsync(async (req, res) => {
  const match = buildMatch(req.query);
  const page = Math.max(parseInt(req.query.page || "1", 10), 1);
  const limit = Math.max(parseInt(req.query.limit || "50", 10), 1);
  const skip = (page - 1) * limit;

  const [records, total] = await Promise.all([
    OldSalesData.find(match)
      .sort({ deliveryDate: -1, _id: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    OldSalesData.countDocuments(match),
  ]);

  res.status(200).json({
    success: true,
    data: {
      records,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    },
  });
});

export const exportOldSalesCsv = catchAsync(async (req, res) => {
  const match = buildMatch(req.query);
  const records = await OldSalesData.find(match).lean();

  const fields = [
    "deliveryDate",
    "referenceReceiptNo",
    "billGivenOrNot",
    "bookingNo",
    "customerName",
    "mobileNo",
    "village",
    "taluka",
    "district",
    "plant",
    "variety",
    "media",
    "details",
    "shadeNo",
    "batch",
    "issuePlantQty",
    "returnQty",
    "damagedQty",
    "extraPlants",
    "plantQty",
    "mis",
    "reference",
    "marketingReference",
    "rate",
    "invoiceAmount",
    "rentOrExtraCharge",
    "vehicleNo",
    "driverName",
    "totalInvoiceAmount",
    "advancePaid",
    "advanceDate",
    "advanceDetails",
    "remainingAmount",
    "paymentMode",
    "paymentDate",
    "paymentAmount",
    "chequeNo",
    "depositedInBank",
    "balanceAmount",
    "remainingAmountPaidDate",
    "remainingAmountPaymentMode",
    "remainingAmountChequeNo",
    "remark",
    "verifiedOrNot",
    "sourceRowNumber",
    "sourceSheet",
    "sourceFile",
    "importBatchId",
  ];

  const parser = new Parser({ fields });
  const csv = parser.parse(records);

  res.setHeader("Content-Type", "text/csv");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename=old-sales-${Date.now()}.csv`
  );
  res.status(200).send(csv);
});
