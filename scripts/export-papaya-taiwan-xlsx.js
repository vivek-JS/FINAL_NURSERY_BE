/**
 * Excel: Papaya × Taiwan — Sr No, farmer, taluka, village, variety, booking date,
 * delivery date, quantity, rate.
 * Connects to PROD by default (PROD_MONGO_URL in .env). Writes under scripts/exports/.
 *
 *   node scripts/export-papaya-taiwan-xlsx.js
 *   node scripts/export-papaya-taiwan-xlsx.js --stage
 *   node scripts/export-papaya-taiwan-xlsx.js --open
 *   node scripts/export-papaya-taiwan-xlsx.js --out /tmp/papaya-taiwan.xlsx
 *
 * Default: orderStatus ACCEPTED only. Use --open for all non-cancelled / non-rejected orders.
 *
 * Delivery window: Jan 1 – Apr 20 (local calendar) for the export year (default: current year).
 *   node scripts/export-papaya-taiwan-xlsx.js --year 2026
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import mongoose from "mongoose";
import ExcelJS from "exceljs";
import PlantCms from "../models/plantCms.model.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });

const preferStage = process.argv.includes("--stage");
const openStatuses = process.argv.includes("--open");
const yearArg = argAfter("--year");
const deliveryYear = (() => {
  if (yearArg != null && yearArg !== "") {
    const y = parseInt(yearArg, 10);
    return Number.isFinite(y) ? y : new Date().getFullYear();
  }
  return new Date().getFullYear();
})();

const uri = preferStage
  ? process.env.MONGO_URL || process.env.STAGE_MONGO_URL || process.env.PROD_MONGO_URL
  : process.env.PROD_MONGO_URL || process.env.MONGO_URL || process.env.STAGE_MONGO_URL;

function argAfter(flag) {
  const i = process.argv.indexOf(flag);
  if (i === -1 || i + 1 >= process.argv.length) return null;
  return process.argv[i + 1];
}

const normalize = (s) => String(s ?? "").trim().toLowerCase();

const STATUS_EXCLUDED = ["CANCELLED", "REJECTED", "TEMPORARY_CANCELLED"];

function statusFilter() {
  if (openStatuses) {
    return { orderStatus: { $nin: STATUS_EXCLUDED } };
  }
  return { orderStatus: "ACCEPTED" };
}

if (!uri) {
  console.error("No Mongo URI in .env (set PROD_MONGO_URL for production).");
  process.exit(1);
}

/** Inclusive Jan 1 – Apr 20 for `year` (local). */
function deliveryDateRangeFilter(year) {
  return {
    deliveryDate: {
      $gte: new Date(year, 0, 1, 0, 0, 0, 0),
      $lte: new Date(year, 3, 20, 23, 59, 59, 999),
    },
  };
}

/** DD-MM-YYYY in local timezone; empty if missing/invalid. */
function formatOrderDate(value) {
  if (value == null) return "";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}-${mm}-${yyyy}`;
}

async function main() {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 30000 });

  const plant = await PlantCms.findOne({ name: /^papaya$/i }).lean();
  if (!plant) {
    console.error("Plant Papaya not found in PlantCms.");
    await mongoose.disconnect();
    process.exit(1);
  }
  const subtype = plant.subtypes.find((st) => normalize(st.name) === "taiwan");
  if (!subtype) {
    console.error(
      "Subtype Taiwan not found. Subtypes:",
      plant.subtypes.map((s) => s.name).join(", ")
    );
    await mongoose.disconnect();
    process.exit(1);
  }

  const col = mongoose.connection.db.collection("orders");
  const pipeline = [
    {
      $match: {
        plantName: plant._id,
        plantSubtype: subtype._id,
        ...statusFilter(),
        ...deliveryDateRangeFilter(deliveryYear),
      },
    },
    {
      $lookup: {
        from: "farmers",
        localField: "farmer",
        foreignField: "_id",
        as: "farmerDoc",
      },
    },
    { $unwind: { path: "$farmerDoc", preserveNullAndEmptyArrays: true } },
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
      $project: {
        orderId: 1,
        farmerName: { $ifNull: ["$farmerDoc.name", ""] },
        taluka: { $ifNull: ["$farmerDoc.talukaName", ""] },
        village: { $ifNull: ["$farmerDoc.village", ""] },
        variety: { $literal: `${plant.name} / ${subtype.name}` },
        orderBookingDate: "$orderBookingDate",
        deliveryDate: "$deliveryDate",
        quantity: "$linePlantTotal",
        rate: "$rate",
      },
    },
    { $sort: { taluka: 1, village: 1, farmerName: 1, orderId: 1 } },
  ];

  const rows = await col.aggregate(pipeline).toArray();
  await mongoose.disconnect();

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
        : path.join(outDir, `papaya-taiwan-${stamp}.xlsx`);

  const wb = new ExcelJS.Workbook();
  wb.creator = "FINAL_NURSERY_BE";
  const ws = wb.addWorksheet("Papaya Taiwan", {
    views: [{ state: "frozen", ySplit: 1 }],
  });

  const headers = [
    "Sr No",
    "Farmer name",
    "Taluka",
    "Village",
    "Variety",
    "Booking date",
    "Delivery date",
    "Quantity",
    "Rate",
  ];
  ws.addRow(headers);
  const hr = ws.getRow(1);
  hr.font = { bold: true };
  hr.alignment = { vertical: "middle", wrapText: true };

  let sr = 1;
  for (const r of rows) {
    ws.addRow([
      sr++,
      r.farmerName,
      r.taluka,
      r.village,
      r.variety,
      formatOrderDate(r.orderBookingDate),
      formatOrderDate(r.deliveryDate),
      r.quantity,
      r.rate,
    ]);
  }

  ws.columns = [
    { width: 8 },
    { width: 28 },
    { width: 18 },
    { width: 22 },
    { width: 22 },
    { width: 14 },
    { width: 14 },
    { width: 12 },
    { width: 10 },
  ];

  await wb.xlsx.writeFile(outPath);

  console.log("Wrote:", outPath);
  console.log("Rows:", rows.length);
  console.log(
    `Delivery date: Jan 1 – Apr 20, ${deliveryYear} (local date range on deliveryDate field)`
  );
  console.log(
    openStatuses
      ? "Status: open (excludes CANCELLED, REJECTED, TEMPORARY_CANCELLED)"
      : "Status: ACCEPTED only"
  );
  console.log("Mongo:", preferStage ? "stage (or fallback order in script)" : "prod (PROD_MONGO_URL first)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
