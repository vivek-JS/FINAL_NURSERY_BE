/**
 * Direct DB report: plant × subtype orderCount + plantCount.
 * Default: exclude CANCELLED / REJECTED / TEMPORARY_CANCELLED. Use --only-accepted for ACCEPTED only.
 *   node scripts/report-plant-subtype-counts.js
 *   node scripts/report-plant-subtype-counts.js --stage   # prefer MONGO_URL over PROD
 *   node scripts/report-plant-subtype-counts.js --dealer-new-agro   # only New Agro Agency (Kundan Dusane) dealer
 *   node scripts/report-plant-subtype-counts.js --dealer-new-agro --only-accepted   # dealer + ACCEPTED only
 *   node scripts/report-plant-subtype-counts.js --dealer-unnati-agro --only-accepted   # Unnati Agro (Ravindra Petkar)
 *   node scripts/report-plant-subtype-counts.js --dealer-user-id <24hex>
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import User from "../models/user.model.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });

const preferStage = process.argv.includes("--stage");
const dealerNewAgro = process.argv.includes("--dealer-new-agro");
const dealerUnnatiAgro = process.argv.includes("--dealer-unnati-agro");
const onlyAccepted = process.argv.includes("--only-accepted");
const uri = preferStage
  ? process.env.MONGO_URL || process.env.STAGE_MONGO_URL || process.env.PROD_MONGO_URL
  : process.env.PROD_MONGO_URL || process.env.MONGO_URL || process.env.STAGE_MONGO_URL;

function argAfter(flag) {
  const i = process.argv.indexOf(flag);
  if (i === -1 || i + 1 >= process.argv.length) return null;
  return process.argv[i + 1];
}

if (!uri) {
  console.error("No Mongo URI in .env");
  process.exit(1);
}

const STATUS_EXCLUDED = ["CANCELLED", "REJECTED", "TEMPORARY_CANCELLED"];

function buildOrderMatch(dealerId) {
  const statusClause = onlyAccepted
    ? { orderStatus: "ACCEPTED" }
    : { orderStatus: { $nin: STATUS_EXCLUDED } };
  if (!dealerId) return statusClause;
  return {
    $and: [
      statusClause,
      {
        $or: [{ dealer: dealerId }, { salesPerson: dealerId }],
      },
    ],
  };
}

function buildPipeline(dealerId) {
  const match = buildOrderMatch(dealerId);
  return [
  {
    $match: match,
  },
  {
    $addFields: {
      linePlantTotal: {
        $add: [
          { $ifNull: ["$numberOfPlants", 0] },
          { $ifNull: ["$additionalPlants", 0] },
        ],
      },
    },
  },
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
      _id: { plantId: "$plantName", subtypeId: "$plantSubtype" },
      plantName: { $first: { $arrayElemAt: ["$plantDetails.name", 0] } },
      subtypeName: { $first: { $arrayElemAt: ["$subtypeDetails.subtypeName", 0] } },
      orderCount: { $sum: 1 },
      plantCount: { $sum: "$linePlantTotal" },
    },
  },
  {
    $project: {
      _id: 0,
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
  { $sort: { plantCount: -1, varietyLabel: 1 } },
];
}

function buildTotalsPipeline(dealerId) {
  return [
  {
    $match: buildOrderMatch(dealerId),
  },
  {
    $group: {
      _id: null,
      totalOrders: { $sum: 1 },
      totalPlants: {
        $sum: {
          $add: [
            { $ifNull: ["$numberOfPlants", 0] },
            { $ifNull: ["$additionalPlants", 0] },
          ],
        },
      },
    },
  },
];
}

async function resolveDealerUserId() {
  const id = argAfter("--dealer-user-id");
  if (id) {
    if (!mongoose.isValidObjectId(id)) {
      throw new Error(`Invalid --dealer-user-id: ${id}`);
    }
    const u = await User.findById(id).select("name jobTitle").lean();
    if (!u) throw new Error(`User not found: ${id}`);
    return { _id: new mongoose.Types.ObjectId(id), ...u };
  }
  if (dealerNewAgro && dealerUnnatiAgro) {
    throw new Error("Use only one of --dealer-new-agro or --dealer-unnati-agro (or --dealer-user-id).");
  }
  if (dealerNewAgro) {
    const list = await User.find({
      name: /^New Agro Agency \(Kundan Dusane\)\s*$/i,
      jobTitle: "DEALER",
    })
      .select("_id name jobTitle")
      .lean();
    if (list.length !== 1) {
      throw new Error(
        `Expected 1 DEALER user "New Agro Agency (Kundan Dusane)", found ${list.length}. Use --dealer-user-id.`
      );
    }
    return list[0];
  }
  if (dealerUnnatiAgro) {
    const list = await User.find({
      name: /^Unnati Agro Agency \(Mr\. Ravindra Petkar\)\s*$/i,
      jobTitle: "DEALER",
    })
      .select("_id name jobTitle")
      .lean();
    if (list.length !== 1) {
      throw new Error(
        `Expected 1 DEALER user "Unnati Agro Agency (Mr. Ravindra Petkar)", found ${list.length}. Use --dealer-user-id.`
      );
    }
    return list[0];
  }
  return null;
}

async function main() {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 20000 });

  const dealer = await resolveDealerUserId();
  const dealerOid = dealer?._id ?? null;

  const col = mongoose.connection.db.collection("orders");
  const totalsPipeline = buildTotalsPipeline(dealerOid);
  const pipeline = buildPipeline(dealerOid);

  const [totals] = await col.aggregate(totalsPipeline).toArray();
  const rows = await col.aggregate(pipeline).toArray();

  console.log("host:", mongoose.connection.host, "db:", mongoose.connection.name);
  console.log("source:", preferStage ? "stage (MONGO_URL first)" : "prod (PROD_MONGO_URL first)");
  console.log(
    "status filter:",
    onlyAccepted ? "orderStatus = ACCEPTED only" : "exclude CANCELLED / REJECTED / TEMPORARY_CANCELLED"
  );
  if (dealer) {
    console.log(
      "dealer filter: salesPerson OR dealer =",
      String(dealer._id),
      `(${dealer.name})`
    );
  } else {
    console.log("dealer filter: (none — all orders)");
  }
  console.log(
    onlyAccepted
      ? "Grand totals (ACCEPTED only):"
      : "Grand totals (excl. CANCELLED/REJECTED/TEMPORARY_CANCELLED):",
    totals || {}
  );
  console.log("Distinct plant×subtype rows:", rows.length);
  console.log("---");
  console.log(JSON.stringify(rows, null, 2));
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
