/**
 * All dealers (jobTitle DEALER): plant × subtype counts per dealer.
 * Attributes each order to at most one dealer: prefer `dealer` ref if it is a known dealer user, else `salesPerson` if that user is a dealer.
 *
 *   node scripts/report-all-dealers-wise.js
 *   node scripts/report-all-dealers-wise.js --only-accepted
 *   node scripts/report-all-dealers-wise.js --stage
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import User from "../models/user.model.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });

const preferStage = process.argv.includes("--stage");
const onlyAccepted = process.argv.includes("--only-accepted");
const uri = preferStage
  ? process.env.MONGO_URL || process.env.STAGE_MONGO_URL || process.env.PROD_MONGO_URL
  : process.env.PROD_MONGO_URL || process.env.MONGO_URL || process.env.STAGE_MONGO_URL;

if (!uri) {
  console.error("No Mongo URI in .env");
  process.exit(1);
}

const STATUS_EXCLUDED = ["CANCELLED", "REJECTED", "TEMPORARY_CANCELLED"];

function statusMatch() {
  return onlyAccepted
    ? { orderStatus: "ACCEPTED" }
    : { orderStatus: { $nin: STATUS_EXCLUDED } };
}

async function main() {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 20000 });
  const col = mongoose.connection.db.collection("orders");

  const dealers = await User.find({ jobTitle: "DEALER" })
    .select("_id name phoneNumber")
    .sort({ name: 1 })
    .lean();
  const dealerIds = dealers.map((d) => d._id);

  if (dealerIds.length === 0) {
    console.log("No users with jobTitle DEALER.");
    await mongoose.disconnect();
    return;
  }

  const pipeline = [
    { $match: statusMatch() },
    {
      $addFields: {
        dealerKey: {
          $cond: [
            { $in: ["$dealer", dealerIds] },
            "$dealer",
            {
              $cond: [
                { $in: ["$salesPerson", dealerIds] },
                "$salesPerson",
                null,
              ],
            },
          ],
        },
        linePlantTotal: {
          $add: [
            { $ifNull: ["$numberOfPlants", 0] },
            { $ifNull: ["$additionalPlants", 0] },
          ],
        },
      },
    },
    { $match: { dealerKey: { $ne: null } } },
    {
      $lookup: {
        from: "plantcms",
        localField: "plantName",
        foreignField: "_id",
        as: "plantDetails",
      },
    },
    {
      $lookup: {
        from: "plantcms",
        let: { plantId: "$plantName", subtypeId: "$plantSubtype" },
        pipeline: [
          { $match: { $expr: { $eq: ["$_id", "$$plantId"] } } },
          { $unwind: "$subtypes" },
          { $match: { $expr: { $eq: ["$subtypes._id", "$$subtypeId"] } } },
          { $project: { subtypeName: "$subtypes.name" } },
        ],
        as: "subtypeDetails",
      },
    },
    {
      $group: {
        _id: {
          dealerId: "$dealerKey",
          plantId: "$plantName",
          subtypeId: "$plantSubtype",
        },
        plantName: { $first: { $arrayElemAt: ["$plantDetails.name", 0] } },
        subtypeName: { $first: { $arrayElemAt: ["$subtypeDetails.subtypeName", 0] } },
        orderCount: { $sum: 1 },
        plantCount: { $sum: "$linePlantTotal" },
      },
    },
    {
      $project: {
        _id: 0,
        dealerId: "$_id.dealerId",
        plantId: "$_id.plantId",
        subtypeId: "$_id.subtypeId",
        plantName: { $ifNull: ["$plantName", "Unknown"] },
        subtypeName: { $ifNull: ["$subtypeName", "Unknown"] },
        varietyLabel: {
          $concat: [
            { $ifNull: ["$plantName", "?"] },
            " — ",
            { $ifNull: ["$subtypeName", "?"] },
          ],
        },
        orderCount: 1,
        plantCount: 1,
      },
    },
    { $sort: { dealerId: 1, plantCount: -1, varietyLabel: 1 } },
  ];

  const varietyRows = await col.aggregate(pipeline).toArray();

  /** @type {Map<string, { dealerId: string, name: string, phoneNumber: unknown, totalOrders: number, totalPlants: number, byVariety: object[] }>} */
  const byId = new Map();
  for (const d of dealers) {
    byId.set(String(d._id), {
      dealerId: String(d._id),
      name: d.name,
      phoneNumber: d.phoneNumber,
      totalOrders: 0,
      totalPlants: 0,
      byVariety: [],
    });
  }

  for (const row of varietyRows) {
    const key = String(row.dealerId);
    const bucket = byId.get(key);
    if (!bucket) continue;
    bucket.totalOrders += row.orderCount;
    bucket.totalPlants += row.plantCount;
    bucket.byVariety.push({
      plantId: row.plantId,
      subtypeId: row.subtypeId,
      plantName: row.plantName,
      subtypeName: row.subtypeName,
      varietyLabel: row.varietyLabel,
      orderCount: row.orderCount,
      plantCount: row.plantCount,
    });
  }

  const report = [...byId.values()].sort((a, b) => b.totalPlants - a.totalPlants);

  const grandOrders = report.reduce((s, x) => s + x.totalOrders, 0);
  const grandPlants = report.reduce((s, x) => s + x.totalPlants, 0);

  console.log("host:", mongoose.connection.host, "db:", mongoose.connection.name);
  console.log(
    "source:",
    preferStage ? "stage (MONGO_URL first)" : "prod (PROD_MONGO_URL first)"
  );
  console.log(
    "status:",
    onlyAccepted ? "ACCEPTED only" : "exclude CANCELLED / REJECTED / TEMPORARY_CANCELLED"
  );
  console.log(
    "attribution: dealer ref if that user is DEALER, else salesPerson if DEALER; orders with neither → omitted"
  );
  console.log("dealers (User jobTitle DEALER):", dealers.length);
  console.log("grand totals (attributed orders only):", {
    totalOrders: grandOrders,
    totalPlants: grandPlants,
  });
  console.log("---");
  console.log(JSON.stringify(report, null, 2));
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
