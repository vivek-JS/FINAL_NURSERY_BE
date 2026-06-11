import Order from "../../../models/order.model.js";
import {
  LINE_PLANT_TOTAL_ADD_FIELDS,
  orderStatusExcludeMatch,
} from "../../../utility/istOrderDateStats.js";

export const FARMER_LOOKUP_STAGES = [
  {
    $lookup: {
      from: "farmers",
      localField: "farmer",
      foreignField: "_id",
      as: "_farmerDoc",
      pipeline: [
        {
          $project: {
            village: 1,
            taluka: 1,
            talukaName: 1,
            district: 1,
            districtName: 1,
          },
        },
      ],
    },
  },
  {
    $addFields: {
      _village: {
        $ifNull: [
          { $arrayElemAt: ["$_farmerDoc.village", 0] },
          "$orderFor.village",
          "Unknown",
        ],
      },
      _taluka: {
        $ifNull: [
          { $arrayElemAt: ["$_farmerDoc.talukaName", 0] },
          { $arrayElemAt: ["$_farmerDoc.taluka", 0] },
          "$orderFor.talukaName",
          "$orderFor.taluka",
          "Unknown",
        ],
      },
      _district: {
        $ifNull: [
          { $arrayElemAt: ["$_farmerDoc.districtName", 0] },
          { $arrayElemAt: ["$_farmerDoc.district", 0] },
          "$orderFor.districtName",
          "$orderFor.district",
          "Unknown",
        ],
      },
    },
  },
];

function buildGeoMatch(rangeStart, rangeEnd, extraMatch = {}) {
  return {
    ...orderStatusExcludeMatch(),
    ...extraMatch,
    $or: [
      { orderBookingDate: { $gte: rangeStart, $lte: rangeEnd } },
      { deliveryDate: { $gte: rangeStart, $lte: rangeEnd, $ne: null } },
    ],
  };
}

/** Top talukas and villages for CEO summary geoTop block. */
export async function aggregateGeoTop(rangeStart, rangeEnd, extraMatch = {}, { limit = 10 } = {}) {
  const pipeline = [
    { $match: buildGeoMatch(rangeStart, rangeEnd, extraMatch) },
    ...FARMER_LOOKUP_STAGES,
    { $addFields: LINE_PLANT_TOTAL_ADD_FIELDS },
    {
      $addFields: {
        _hasChange: {
          $gt: [{ $size: { $ifNull: ["$deliveryChanges", []] } }, 0],
        },
        _isEarly: { $eq: ["$dispatchedFromAnotherSlot", true] },
      },
    },
    {
      $facet: {
        byTaluka: [
          {
            $group: {
              _id: { taluka: "$_taluka", district: "$_district" },
              orders: { $sum: 1 },
              plants: { $sum: "$linePlantTotal" },
              deliveryChanged: {
                $sum: { $cond: ["$_hasChange", 1, 0] },
              },
              earlyDelivery: {
                $sum: { $cond: ["$_isEarly", 1, 0] },
              },
            },
          },
          { $sort: { plants: -1 } },
          { $limit: limit },
          {
            $project: {
              _id: 0,
              taluka: "$_id.taluka",
              district: "$_id.district",
              orders: 1,
              plants: 1,
              deliveryChanged: 1,
              earlyDelivery: 1,
            },
          },
        ],
        byVillage: [
          {
            $group: {
              _id: {
                village: "$_village",
                taluka: "$_taluka",
                district: "$_district",
              },
              orders: { $sum: 1 },
              plants: { $sum: "$linePlantTotal" },
            },
          },
          { $sort: { plants: -1 } },
          { $limit: limit },
          {
            $project: {
              _id: 0,
              village: "$_id.village",
              taluka: "$_id.taluka",
              district: "$_id.district",
              orders: 1,
              plants: 1,
            },
          },
        ],
      },
    },
  ];

  const [result] = await Order.aggregate(pipeline);
  return {
    byTaluka: result?.byTaluka ?? [],
    byVillage: result?.byVillage ?? [],
    drill: { groupBy: "taluka", bucket: "deliveryTotal" },
  };
}

const GROUP_FIELD = {
  taluka: "$_taluka",
  village: "$_village",
  district: "$_district",
};

/** Geo breakdown rows for drill endpoint. */
export async function aggregateGeoBreakdown(
  groupBy,
  rangeStart,
  rangeEnd,
  { bucketMatch = {}, taluka, village, district } = {}
) {
  const field = GROUP_FIELD[groupBy];
  if (!field) return { rows: [] };

  const match = { ...buildGeoMatch(rangeStart, rangeEnd), ...bucketMatch };
  const pipeline = [
    { $match: match },
    ...FARMER_LOOKUP_STAGES,
  ];

  if (taluka) pipeline.push({ $match: { _taluka: taluka } });
  if (village) pipeline.push({ $match: { _village: village } });
  if (district) pipeline.push({ $match: { _district: district } });

  pipeline.push(
    { $addFields: LINE_PLANT_TOTAL_ADD_FIELDS },
    {
      $group: {
        _id: field,
        orders: { $sum: 1 },
        plants: { $sum: "$linePlantTotal" },
        district: { $first: "$_district" },
        taluka: { $first: "$_taluka" },
        village: { $first: "$_village" },
      },
    },
    { $sort: { plants: -1 } },
    {
      $project: {
        _id: 0,
        name: "$_id",
        orders: 1,
        plants: 1,
        district: 1,
        taluka: 1,
        village: 1,
        groupBy,
      },
    }
  );

  const rows = await Order.aggregate(pipeline);
  return { rows };
}
