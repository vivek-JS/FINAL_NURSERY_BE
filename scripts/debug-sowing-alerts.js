import dotenv from "dotenv";
dotenv.config();
import mongoose from "mongoose";
import PlantSlot from "../models/slots.model.js";
import Order from "../models/order.model.js";

const connect = async () => {
  const uri = process.env.MONGO_URL || process.env.MONGODB_URI;
  if (!uri) {
    throw new Error("Set MONGO_URL or MONGODB_URI to run this script.");
  }
  await mongoose.connect(uri);
};

const run = async () => {
  await connect();
  const plantFilterArg = process.argv[2];
  const matchStage =
    plantFilterArg && plantFilterArg !== "all"
      ? {
          $match: { plantId: new mongoose.Types.ObjectId(plantFilterArg) },
        }
      : { $match: {} };

  const sowingAllowedOnly = process.argv.includes("--sowing-allowed");

  const slotFilterArg = process.argv[3] && !process.argv[3].startsWith("--") ? process.argv[3] : null;

  const pipeline = [
    matchStage,
    { $unwind: "$subtypeSlots" },
    { $unwind: "$subtypeSlots.slots" },
    ...(slotFilterArg
      ? [
          {
            $match: {
              "subtypeSlots.slots._id": new mongoose.Types.ObjectId(slotFilterArg),
            },
          },
        ]
      : []),
    {
      $lookup: {
        from: "plantcms",
        localField: "plantId",
        foreignField: "_id",
        as: "plantInfo",
      },
    },
    {
      $addFields: {
        plantInfo: { $arrayElemAt: ["$plantInfo", 0] },
        subtypeDetails: {
          $arrayElemAt: [
            {
              $filter: {
                input: { $ifNull: ["$plantInfo.subtypes", []] },
                as: "subtype",
                cond: { $eq: ["$$subtype._id", "$subtypeSlots.subtypeId"] },
              },
            },
            0,
          ],
        },
      },
    },
    ...(sowingAllowedOnly
      ? [
          {
            $match: {
              "plantInfo.sowingAllowed": true,
            },
          },
        ]
      : []),
    {
      $lookup: {
        from: "orders",
        let: { slotId: "$subtypeSlots.slots._id" },
        pipeline: [
          {
            $match: {
              $expr: { $eq: ["$bookingSlot", "$$slotId"] },
            },
          },
          {
            $project: {
              numberOfPlants: 1,
              orderStatus: 1,
            },
          },
        ],
        as: "slotOrders",
      },
    },
    {
      $addFields: {
        primarySowed: {
          $toDouble: { $ifNull: ["$subtypeSlots.slots.primarySowed", 0] },
        },
        officeSowed: {
          $toDouble: { $ifNull: ["$subtypeSlots.slots.officeSowed", 0] },
        },
        storedBooked: {
          $toDouble: { $ifNull: ["$subtypeSlots.slots.totalBookedPlants", 0] },
        },
        slotReadyDays: {
          $cond: [
            { $gt: ["$subtypeSlots.slots.plantReadyDays", 0] },
            "$subtypeSlots.slots.plantReadyDays",
            { $ifNull: ["$subtypeDetails.plantReadyDays", 0] },
          ],
        },
        ordersBooked: {
          $toDouble: {
            $sum: {
              $map: {
                input: "$slotOrders",
                as: "order",
                in: { $ifNull: ["$$order.numberOfPlants", 0] },
              },
            },
          },
        },
      },
    },
    {
      $addFields: {
        effectiveBookedRaw: { $max: ["$ordersBooked", "$storedBooked"] },
        effectiveBooked: { $ifNull: ["$effectiveBookedRaw", 0] },
        pendingQuantityRaw: {
          $subtract: [
            { $max: ["$ordersBooked", "$storedBooked"] },
            { $ifNull: ["$primarySowed", 0] },
          ],
        },
        pendingQuantity: {
          $max: [
            0,
            {
              $subtract: [
                { $max: ["$ordersBooked", "$storedBooked"] },
                { $ifNull: ["$primarySowed", 0] },
              ],
            },
          ],
        },
        sowByDateISO: {
          $cond: [
            { $gt: ["$slotReadyDays", 0] },
            {
              $dateSubtract: {
                startDate: {
                  $dateFromString: {
                    dateString: {
                      $concat: [
                        { $substr: ["$subtypeSlots.slots.endDay", 6, 4] },
                        "-",
                        { $substr: ["$subtypeSlots.slots.endDay", 3, 2] },
                        "-",
                        { $substr: ["$subtypeSlots.slots.endDay", 0, 2] },
                      ],
                    },
                    format: "%Y-%m-%d",
                  },
                },
                unit: "day",
                amount: "$slotReadyDays",
              },
            },
            {
              $dateFromString: {
                dateString: {
                  $concat: [
                    { $substr: ["$subtypeSlots.slots.endDay", 6, 4] },
                    "-",
                    { $substr: ["$subtypeSlots.slots.endDay", 3, 2] },
                    "-",
                    { $substr: ["$subtypeSlots.slots.endDay", 0, 2] },
                  ],
                },
                format: "%Y-%m-%d",
              },
            },
          ],
        },
      },
    },
    { $sort: { pendingQuantity: -1 } },
    { $limit: 5 },
    {
      $project: {
        plantId: "$plantId",
        plantName: "$plantInfo.name",
        subtypeId: "$subtypeSlots.subtypeId",
        subtypeName: "$subtypeDetails.name",
        slotId: "$subtypeSlots.slots._id",
        startDay: "$subtypeSlots.slots.startDay",
        endDay: "$subtypeSlots.slots.endDay",
        slotReadyDays: "$slotReadyDays",
        effectiveBooked: 1,
        storedBooked: 1,
        ordersBooked: 1,
        primarySowed: 1,
        effectiveBookedRaw: 1,
        pendingQuantityRaw: 1,
        pendingQuantity: 1,
        sowByDateISO: 1,
      },
    },
  ];

  const slotDoc = await PlantSlot.aggregate(pipeline).allowDiskUse(true);

  console.log("debug db", mongoose.connection.name);
  console.log(JSON.stringify(slotDoc, null, 2));

  await mongoose.connection.close();
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});

