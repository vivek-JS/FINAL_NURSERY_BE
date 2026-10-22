/**
 * Tail of GET /order/getOrders?exportAll=true.
 * Filters and the farmer lookup are already on the pipeline.
 * Keeps only the columns the dashboard CSV uses, and skips tray,
 * history-user, dispatch, and plant-slot joins.
 */

const SOURCE_FIELDS = {
  orderId: 1,
  orderBookingDate: 1,
  createdAt: 1,
  updatedAt: 1,
  deliveryDate: 1,
  farmReadyDate: 1,
  oldDeliveryDate: 1,
  dispatchTargetDate: 1,
  numberOfPlants: 1,
  additionalPlants: 1,
  totalPlants: 1,
  returnedPlants: 1,
  damagedPlants: 1,
  rate: 1,
  orderStatus: 1,
  sowingDone: 1,
  deliveryChallanInvoiceNumber: 1,
  farmer: 1,
  orderFor: 1,
  plantName: 1,
  plantSubtype: 1,
  salesPerson: 1,
  payment: 1,
  dispatchHistory: 1,
  statusChanges: 1,
  farmReadyEnteredAt: 1,
  readyForDispatchEnteredAt: 1,
  readyDispatchPastDueRank: 1,
  dispatchTargetDateSort: 1,
};

function plantLookupStage() {
  return {
    $lookup: {
      from: "plantcms",
      let: { plantId: "$plantName", subtypeId: "$plantSubtype" },
      pipeline: [
        { $match: { $expr: { $eq: ["$_id", "$$plantId"] } } },
        {
          $project: {
            _id: 0,
            name: 1,
            subtypeName: {
              $let: {
                vars: {
                  hit: {
                    $arrayElemAt: [
                      {
                        $filter: {
                          input: { $ifNull: ["$subtypes", []] },
                          as: "st",
                          cond: { $eq: ["$$st._id", "$$subtypeId"] },
                        },
                      },
                      0,
                    ],
                  },
                },
                in: "$$hit.name",
              },
            },
          },
        },
      ],
      as: "plantExport",
    },
  };
}

function salesLookupStage() {
  return {
    $lookup: {
      from: "users",
      let: { uid: "$salesPerson" },
      pipeline: [
        { $match: { $expr: { $eq: ["$_id", "$$uid"] } } },
        { $project: { _id: 1, name: 1 } },
      ],
      as: "salesExport",
    },
  };
}

function exportRowProject() {
  return {
    $project: {
      orderId: 1,
      orderBookingDate: 1,
      createdAt: 1,
      deliveryDate: 1,
      farmReadyDate: 1,
      oldDeliveryDate: 1,
      dispatchTargetDate: 1,
      numberOfPlants: 1,
      additionalPlants: { $ifNull: ["$additionalPlants", 0] },
      totalPlants: {
        $ifNull: [
          "$totalPlants",
          {
            $add: [
              { $ifNull: ["$numberOfPlants", 0] },
              { $ifNull: ["$additionalPlants", 0] },
            ],
          },
        ],
      },
      returnedPlants: { $ifNull: ["$returnedPlants", 0] },
      damagedPlants: { $ifNull: ["$damagedPlants", 0] },
      rate: 1,
      orderStatus: 1,
      sowingDone: { $ifNull: ["$sowingDone", false] },
      deliveryChallanInvoiceNumber: 1,
      farmer: {
        $let: {
          vars: { f: { $arrayElemAt: [{ $ifNull: ["$farmer", []] }, 0] } },
          in: {
            name: "$$f.name",
            mobileNumber: "$$f.mobileNumber",
            village: "$$f.village",
            taluka: "$$f.taluka",
            district: "$$f.district",
            districtName: "$$f.districtName",
            talukaName: "$$f.talukaName",
          },
        },
      },
      orderFor: {
        name: "$orderFor.name",
        mobileNumber: "$orderFor.mobileNumber",
      },
      plantType: {
        name: { $arrayElemAt: ["$plantExport.name", 0] },
      },
      plantSubtype: {
        name: { $arrayElemAt: ["$plantExport.subtypeName", 0] },
      },
      salesPerson: {
        $let: {
          vars: { s: { $arrayElemAt: [{ $ifNull: ["$salesExport", []] }, 0] } },
          in: { _id: "$$s._id", name: "$$s.name" },
        },
      },
      payment: {
        $map: {
          input: { $ifNull: ["$payment", []] },
          as: "p",
          in: {
            paymentStatus: "$$p.paymentStatus",
            paidAmount: "$$p.paidAmount",
            paymentDate: "$$p.paymentDate",
            paymentTiming: "$$p.paymentTiming",
          },
        },
      },
      dispatchHistory: {
        $map: {
          input: { $ifNull: ["$dispatchHistory", []] },
          as: "h",
          in: {
            date: "$$h.date",
            dispatchDate: "$$h.dispatchDate",
            dispatchedAt: "$$h.dispatchedAt",
            createdAt: "$$h.createdAt",
          },
        },
      },
      statusChanges: {
        $map: {
          input: { $ifNull: ["$statusChanges", []] },
          as: "c",
          in: { newStatus: "$$c.newStatus", createdAt: "$$c.createdAt" },
        },
      },
    },
  };
}

/** Mutates pipeline. Call only after order filters and the farmer lookup. */
export function appendFastOrderExportStages(pipeline, { sort, limit } = {}) {
  const cap = Math.min(Math.max(Math.floor(Number(limit) || 1), 1), 200000);
  pipeline.push({ $project: SOURCE_FIELDS });
  pipeline.push(plantLookupStage());
  pipeline.push(salesLookupStage());
  if (sort && Object.keys(sort).length) pipeline.push({ $sort: sort });
  pipeline.push({ $limit: cap });
  pipeline.push(exportRowProject());
}
