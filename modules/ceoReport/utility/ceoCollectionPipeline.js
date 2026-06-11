import {
  LINE_PLANT_TOTAL_ADD_FIELDS,
  orderStatusExcludeMatch,
} from "../../../utility/istOrderDateStats.js";

/** Core $addFields after LINE_PLANT_TOTAL_ADD_FIELDS */
export const CEO_COLLECTION_AMOUNT_FIELDS = {
  _orderAmount: {
    $multiply: ["$linePlantTotal", { $ifNull: ["$rate", 0] }],
  },
  _collected: {
    $reduce: {
      input: {
        $filter: {
          input: { $ifNull: ["$payment", []] },
          as: "p",
          cond: { $eq: ["$$p.paymentStatus", "COLLECTED"] },
        },
      },
      initialValue: 0,
      in: { $add: ["$$value", { $ifNull: ["$$this.paidAmount", 0] }] },
    },
  },
  _pending: {
    $reduce: {
      input: {
        $filter: {
          input: { $ifNull: ["$payment", []] },
          as: "p",
          cond: { $eq: ["$$p.paymentStatus", "PENDING"] },
        },
      },
      initialValue: 0,
      in: { $add: ["$$value", { $ifNull: ["$$this.paidAmount", 0] }] },
    },
  },
  _advanceCollected: {
    $reduce: {
      input: {
        $filter: {
          input: { $ifNull: ["$payment", []] },
          as: "p",
          cond: {
            $and: [
              { $eq: ["$$p.paymentStatus", "COLLECTED"] },
              { $eq: [{ $toLower: { $ifNull: ["$$p.paymentTiming", ""] } }, "advance"] },
            ],
          },
        },
      },
      initialValue: 0,
      in: { $add: ["$$value", { $ifNull: ["$$this.paidAmount", 0] }] },
    },
  },
};

export function buildCollectionMatch(rangeStart, rangeEnd, extraMatch = {}, dateField = "booking") {
  const match = {
    ...orderStatusExcludeMatch(),
    dealerOrder: { $ne: true },
    farmer: { $exists: true, $ne: null },
    ...extraMatch,
  };
  const range = { $gte: rangeStart, $lte: rangeEnd };
  if (dateField === "delivery") {
    match.deliveryDate = { ...range, $ne: null };
  } else if (dateField === "collection") {
    match.payment = {
      $elemMatch: {
        paymentStatus: "COLLECTED",
        paymentDate: range,
      },
    };
  } else {
    match.orderBookingDate = range;
  }
  return match;
}

export function collectionLookupStages() {
  return [
    {
      $lookup: {
        from: "farmers",
        localField: "farmer",
        foreignField: "_id",
        pipeline: [
          {
            $project: {
              name: 1,
              village: 1,
              talukaName: 1,
              districtName: 1,
              mobileNumber: 1,
            },
          },
        ],
        as: "_farmer",
      },
    },
    {
      $lookup: {
        from: "users",
        localField: "salesPerson",
        foreignField: "_id",
        pipeline: [{ $project: { name: 1 } }],
        as: "_sales",
      },
    },
    {
      $lookup: {
        from: "plantcms",
        localField: "plantName",
        foreignField: "_id",
        pipeline: [{ $project: { name: 1, subtypes: 1 } }],
        as: "_plant",
      },
    },
    {
      $addFields: {
        _farmerDoc: { $arrayElemAt: ["$_farmer", 0] },
        _salesName: { $arrayElemAt: ["$_sales.name", 0] },
        _plantDoc: { $arrayElemAt: ["$_plant", 0] },
        _subtypeName: {
          $let: {
            vars: {
              subtypes: { $ifNull: [{ $arrayElemAt: ["$_plant.subtypes", 0] }, []] },
            },
            in: {
              $arrayElemAt: [
                {
                  $map: {
                    input: {
                      $filter: {
                        input: "$$subtypes",
                        as: "st",
                        cond: { $eq: ["$$st._id", "$plantSubtype"] },
                      },
                    },
                    as: "m",
                    in: "$$m.name",
                  },
                },
                0,
              ],
            },
          },
        },
      },
    },
    {
      $addFields: {
        customerName: { $ifNull: ["$_farmerDoc.name", ""] },
        village: { $ifNull: ["$_farmerDoc.village", ""] },
        taluka: { $ifNull: ["$_farmerDoc.talukaName", ""] },
        district: { $ifNull: ["$_farmerDoc.districtName", ""] },
        salesmanName: { $ifNull: ["$_salesName", "Unknown"] },
        salesmanId: { $toString: "$salesPerson" },
        branch: { $ifNull: ["$expectedNursery", "—"] },
        productName: {
          $concat: [
            { $ifNull: ["$_plantDoc.name", ""] },
            " ",
            { $ifNull: ["$_subtypeName", ""] },
          ],
        },
        orderAmount: "$_orderAmount",
        collectionAmount: "$_collected",
        outstandingAmount: {
          $max: [0, { $subtract: ["$_orderAmount", "$_collected"] }],
        },
        advanceAmount: "$_advanceCollected",
        dueDate: "$deliveryDate",
        bookingDate: "$orderBookingDate",
      },
    },
  ];
}

export function collectionFacetStages() {
  return {
    summary: [
      {
        $group: {
          _id: null,
          orderCount: { $sum: 1 },
          orderAmount: { $sum: "$orderAmount" },
          collectionAmount: { $sum: "$collectionAmount" },
          outstandingAmount: { $sum: "$outstandingAmount" },
          advanceAmount: { $sum: "$advanceAmount" },
          avgDelayDays: { $avg: "$_avgDelayDays" },
        },
      },
    ],
    bySalesman: [
      {
        $group: {
          _id: { id: "$salesmanId", name: "$salesmanName" },
          orderCount: { $sum: 1 },
          orderAmount: { $sum: "$orderAmount" },
          collectionAmount: { $sum: "$collectionAmount" },
          outstandingAmount: { $sum: "$outstandingAmount" },
        },
      },
      { $sort: { collectionAmount: -1 } },
      { $limit: 25 },
    ],
    byVillage: [
      {
        $group: {
          _id: "$village",
          orderCount: { $sum: 1 },
          orderAmount: { $sum: "$orderAmount" },
          collectionAmount: { $sum: "$collectionAmount" },
          outstandingAmount: { $sum: "$outstandingAmount" },
        },
      },
      { $match: { _id: { $ne: "" } } },
      { $sort: { collectionAmount: -1 } },
      { $limit: 25 },
    ],
    byBranch: [
      {
        $group: {
          _id: "$branch",
          orderCount: { $sum: 1 },
          orderAmount: { $sum: "$orderAmount" },
          collectionAmount: { $sum: "$collectionAmount" },
          outstandingAmount: { $sum: "$outstandingAmount" },
        },
      },
      { $sort: { collectionAmount: -1 } },
    ],
    byPaymentMode: [
      { $unwind: { path: "$payment", preserveNullAndEmptyArrays: false } },
      { $match: { "payment.paymentStatus": "COLLECTED" } },
      {
        $group: {
          _id: { $ifNull: ["$payment.modeOfPayment", "Unknown"] },
          count: { $sum: 1 },
          amount: { $sum: { $ifNull: ["$payment.paidAmount", 0] } },
        },
      },
      { $sort: { amount: -1 } },
    ],
    delayBuckets: [
      {
        $bucket: {
          groupBy: "$_avgDelayDays",
          boundaries: [0, 1, 8, 31, 61, 91, 10000],
          default: "unknown",
          output: {
            count: { $sum: 1 },
            outstanding: { $sum: "$outstandingAmount" },
          },
        },
      },
    ],
  };
}

/** Compute avg delay from collected payments vs deliveryDate */
export function delayComputeStage() {
  return {
    $addFields: {
      _avgDelayDays: {
        $let: {
          vars: {
            collectedPayments: {
              $filter: {
                input: { $ifNull: ["$payment", []] },
                as: "p",
                cond: {
                  $and: [
                    { $eq: ["$$p.paymentStatus", "COLLECTED"] },
                    { $ne: ["$$p.paymentDate", null] },
                  ],
                },
              },
            },
            due: { $ifNull: ["$deliveryDate", "$orderBookingDate"] },
          },
          in: {
            $cond: [
              { $and: [{ $gt: [{ $size: "$$collectedPayments" }, 0] }, { $ne: ["$$due", null] }] },
              {
                $avg: {
                  $map: {
                    input: "$$collectedPayments",
                    as: "cp",
                    in: {
                      $divide: [
                        { $subtract: ["$$cp.paymentDate", "$$due"] },
                        86400000,
                      ],
                    },
                  },
                },
              },
              null,
            ],
          },
        },
      },
    },
  };
}

export function baseCollectionPipeline(match, limit = 0) {
  const stages = [
    { $match: match },
    { $addFields: LINE_PLANT_TOTAL_ADD_FIELDS },
    { $addFields: CEO_COLLECTION_AMOUNT_FIELDS },
    delayComputeStage(),
    ...collectionLookupStages(),
  ];
  if (limit > 0) {
    stages.push({ $sort: { orderBookingDate: -1 } });
    stages.push({ $limit: limit });
  }
  return stages;
}
