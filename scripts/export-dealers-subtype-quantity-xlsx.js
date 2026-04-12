/**
 * Excel: dealers × subtype columns = plant quantity (numberOfPlants + additionalPlants).
 * Default: orderStatus ACCEPTED only, same dealer attribution as report-all-dealers-wise.js
 *
 *   node scripts/export-dealers-subtype-quantity-xlsx.js
 *   node scripts/export-dealers-subtype-quantity-xlsx.js --stage
 *   node scripts/export-dealers-subtype-quantity-xlsx.js --out /tmp/report.xlsx
 *
 * Column titles: subtype name only when unique across plants; if same subtype name exists on
 * multiple plants, uses "Subtype (PlantName)".
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import mongoose from "mongoose";
import ExcelJS from "exceljs";
import User from "../models/user.model.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });

const preferStage = process.argv.includes("--stage");
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

/** @param {{ plantName: string, subtypeName: string }}[] pairs */
function columnHeader(pairs, plantName, subtypeName) {
  const sn = subtypeName || "?";
  const same = pairs.filter((p) => p.subtypeName === sn);
  const plants = new Set(same.map((p) => p.plantName));
  if (plants.size <= 1) return sn;
  return `${sn} (${plantName})`;
}

function pairKey(plantName, subtypeName) {
  return `${plantName}\t${subtypeName}`;
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
    console.log("No DEALER users.");
    await mongoose.disconnect();
    return;
  }

  const statusMatch = { orderStatus: "ACCEPTED" };

  const pipeline = [
    { $match: statusMatch },
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
        plantCount: { $sum: "$linePlantTotal" },
      },
    },
    {
      $project: {
        _id: 0,
        dealerId: "$_id.dealerId",
        plantName: { $ifNull: ["$plantName", "Unknown"] },
        subtypeName: { $ifNull: ["$subtypeName", "Unknown"] },
        plantCount: 1,
      },
    },
  ];

  const varietyRows = await col.aggregate(pipeline).toArray();
  await mongoose.disconnect();

  const uniquePairs = [];
  const pairSeen = new Set();
  for (const r of varietyRows) {
    const pn = r.plantName;
    const sn = r.subtypeName;
    const k = pairKey(pn, sn);
    if (!pairSeen.has(k)) {
      pairSeen.add(k);
      uniquePairs.push({ plantName: pn, subtypeName: sn });
    }
  }
  uniquePairs.sort((a, b) => {
    const c = a.plantName.localeCompare(b.plantName);
    if (c !== 0) return c;
    return a.subtypeName.localeCompare(b.subtypeName);
  });

  const columns = uniquePairs.map((p) => ({
    key: pairKey(p.plantName, p.subtypeName),
    header: columnHeader(uniquePairs, p.plantName, p.subtypeName),
  }));

  /** @type {Map<string, Map<string, number>>} */
  const dealerQty = new Map();
  for (const d of dealers) {
    dealerQty.set(String(d._id), new Map());
  }
  for (const r of varietyRows) {
    const did = String(r.dealerId);
    const m = dealerQty.get(did);
    if (!m) continue;
    const k = pairKey(r.plantName, r.subtypeName);
    m.set(k, (m.get(k) || 0) + r.plantCount);
  }

  const outArg = argAfter("--out");
  const outDir = path.join(__dirname, "exports");
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:-]/g, "");
  const outPath =
    outArg && path.isAbsolute(outArg)
      ? outArg
      : outArg
        ? path.join(process.cwd(), outArg)
        : path.join(outDir, `dealer-subtype-qty-accepted-${stamp}.xlsx`);

  const wb = new ExcelJS.Workbook();
  wb.creator = "FINAL_NURSERY_BE";
  const ws = wb.addWorksheet("Accepted qty", {
    views: [{ state: "frozen", ySplit: 1, xSplit: 2 }],
  });

  const headerRow = ["Dealer", "Phone", ...columns.map((c) => c.header), "Total plants"];
  ws.addRow(headerRow);
  const hr = ws.getRow(1);
  hr.font = { bold: true };
  hr.alignment = { vertical: "middle", wrapText: true };

  let rowNum = 2;
  for (const d of dealers) {
    const did = String(d._id);
    const q = dealerQty.get(did) || new Map();
    const cells = [d.name, d.phoneNumber ?? ""];
    let total = 0;
    for (const col of columns) {
      const v = q.get(col.key) || 0;
      cells.push(v);
      total += v;
    }
    cells.push(total);
    ws.addRow(cells);
    rowNum++;
  }

  ws.columns = [
    { width: 36 },
    { width: 14 },
    ...columns.map(() => ({ width: 12 })),
    { width: 14 },
  ];

  await wb.xlsx.writeFile(outPath);

  console.log("host: (disconnected) wrote:", outPath);
  console.log("status: ACCEPTED only");
  console.log("dealers:", dealers.length, "subtype columns:", columns.length);
  console.log(
    "subtype columns:",
    headerRow.slice(2, 2 + columns.length).join(" | ")
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
