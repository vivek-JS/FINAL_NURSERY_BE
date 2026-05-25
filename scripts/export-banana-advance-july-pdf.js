/**
 * PDF: Banana orders (delivery on/before 31 Jul) with COLLECTED + PENDING payments.
 * Excludes test/internal farmer mobiles (9823832132, 7588686452, 7588686453).
 *
 *   node scripts/export-banana-advance-july-pdf.js
 *   node scripts/export-banana-advance-july-pdf.js --stage
 *   node scripts/export-banana-advance-july-pdf.js --year 2026
 *   node scripts/export-banana-advance-july-pdf.js --all-orders
 *   node scripts/export-banana-advance-july-pdf.js --out /tmp/banana-advance.pdf
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import mongoose from "mongoose";
import PDFDocument from "pdfkit";
import PlantCms from "../models/plantCms.model.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });

const preferStage = process.argv.includes("--stage");
const includeZeroAdvance = process.argv.includes("--all-orders");
const yearArg = argAfter("--year");
const reportYear = (() => {
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

const STATUS_EXCLUDED = ["CANCELLED", "REJECTED", "TEMPORARY_CANCELLED"];

/** Farmer mobiles excluded from report (normalized 10-digit). */
const EXCLUDED_FARMER_MOBILES = new Set([
  "9823832132",
  "7588686452",
  "7588686453",
]);

const PAYMENT_STATUSES_INCLUDED = new Set(["COLLECTED", "PENDING"]);

function normalizeMobile(mobile) {
  if (mobile == null || mobile === "") return null;
  const s = String(mobile).replace(/\D/g, "");
  if (s.length >= 10) return s.slice(-10);
  return s.length ? s : null;
}

function isExcludedFarmerMobile(mobile) {
  const norm = normalizeMobile(mobile);
  return norm != null && EXCLUDED_FARMER_MOBILES.has(norm);
}

function formatDate(value) {
  if (value == null) return "—";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}-${mm}-${yyyy}`;
}

function sumByPaymentStatus(paymentArr, status) {
  if (!Array.isArray(paymentArr)) return 0;
  return paymentArr
    .filter((p) => p && p.paymentStatus === status)
    .reduce((s, p) => s + (Number(p.paidAmount) || 0), 0);
}

function sumCollectedAndPending(paymentArr) {
  return {
    collected: sumByPaymentStatus(paymentArr, "COLLECTED"),
    pending: sumByPaymentStatus(paymentArr, "PENDING"),
  };
}

function formatPaymentLines(paymentArr) {
  if (!Array.isArray(paymentArr) || !paymentArr.length) return "—";
  const lines = paymentArr
    .filter(
      (p) =>
        p &&
        Number(p.paidAmount) > 0 &&
        PAYMENT_STATUSES_INCLUDED.has(p.paymentStatus)
    )
    .map((p) => {
      const amt = Number(p.paidAmount) || 0;
      const st = p.paymentStatus || "";
      const dt = formatDate(p.paymentDate);
      const mode = p.modeOfPayment || "";
      const bank = p.bankName ? ` / ${p.bankName}` : "";
      const chq = p.chequeNumber ? ` CH:${p.chequeNumber}` : "";
      const rm = p.remark ? ` (${String(p.remark).slice(0, 40)})` : "";
      return `₹${amt.toLocaleString("en-IN")} ${st} ${dt} ${mode}${bank}${chq}${rm}`.trim();
    });
  return lines.length ? lines.join("\n") : "—";
}

function firstDispatchDate(row) {
  const hist = row.dispatchHistory;
  if (Array.isArray(hist) && hist.length) {
    const dates = hist
      .map((h) => h?.date)
      .filter(Boolean)
      .map((d) => new Date(d))
      .filter((d) => !Number.isNaN(d.getTime()));
    if (dates.length) {
      dates.sort((a, b) => a - b);
      return dates[0];
    }
  }
  const changes = row.statusChanges;
  if (Array.isArray(changes)) {
    const dispatched = changes
      .filter((c) => c?.newStatus === "DISPATCHED" && c?.createdAt)
      .map((c) => new Date(c.createdAt))
      .filter((d) => !Number.isNaN(d.getTime()));
    if (dispatched.length) {
      dispatched.sort((a, b) => a - b);
      return dispatched[0];
    }
  }
  if (row.dispatchTargetDate) return new Date(row.dispatchTargetDate);
  return null;
}

function remarksText(row) {
  const parts = [];
  if (Array.isArray(row.orderRemarks) && row.orderRemarks.length) {
    parts.push(...row.orderRemarks.map(String));
  }
  if (row.notes) parts.push(String(row.notes));
  return parts.length ? parts.join(" | ").slice(0, 120) : "—";
}

function deliveryThroughJulyFilter(year) {
  return {
    deliveryDate: {
      $ne: null,
      $lte: new Date(year, 6, 31, 23, 59, 59, 999),
    },
  };
}

async function fetchRows(plant) {
  const col = mongoose.connection.db.collection("orders");
  const pipeline = [
    {
      $match: {
        plantName: plant._id,
        dealerOrder: { $ne: true },
        orderStatus: { $nin: STATUS_EXCLUDED },
        ...deliveryThroughJulyFilter(reportYear),
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
      $lookup: {
        from: "users",
        localField: "salesPerson",
        foreignField: "_id",
        as: "salesDoc",
      },
    },
    { $unwind: { path: "$salesDoc", preserveNullAndEmptyArrays: true } },
    {
      $addFields: {
        linePlantTotal: {
          $add: [
            { $ifNull: ["$numberOfPlants", 0] },
            { $ifNull: ["$additionalPlants", 0] },
          ],
        },
        subtypeName: {
          $let: {
            vars: {
              hit: {
                $arrayElemAt: [
                  {
                    $filter: {
                      input: { $literal: plant.subtypes },
                      as: "st",
                      cond: { $eq: ["$$st._id", "$plantSubtype"] },
                    },
                  },
                  0,
                ],
              },
            },
            in: { $ifNull: ["$$hit.name", ""] },
          },
        },
      },
    },
    {
      $project: {
        orderId: 1,
        numberOfPlants: 1,
        additionalPlants: 1,
        linePlantTotal: 1,
        rate: 1,
        orderStatus: 1,
        orderPaymentStatus: 1,
        orderBookingDate: 1,
        deliveryDate: 1,
        remainingPlants: 1,
        payment: 1,
        dispatchHistory: 1,
        statusChanges: 1,
        dispatchTargetDate: 1,
        orderRemarks: 1,
        notes: 1,
        farmerName: { $ifNull: ["$farmerDoc.name", ""] },
        farmerMobile: { $ifNull: ["$farmerDoc.mobileNumber", ""] },
        taluka: {
          $ifNull: ["$farmerDoc.talukaName", { $ifNull: ["$farmerDoc.taluka", ""] }],
        },
        village: { $ifNull: ["$farmerDoc.village", ""] },
        salesPersonName: { $ifNull: ["$salesDoc.name", ""] },
        variety: {
          $concat: [
            { $literal: plant.name },
            " / ",
            { $ifNull: ["$subtypeName", ""] },
          ],
        },
      },
    },
    { $sort: { taluka: 1, village: 1, farmerName: 1, orderId: 1 } },
  ];

  return col.aggregate(pipeline).toArray();
}

function buildPdf(outPath, meta, tableRows) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      layout: "landscape",
      margins: { top: 36, bottom: 36, left: 28, right: 28 },
    });
    const stream = fs.createWriteStream(outPath);
    doc.pipe(stream);

    doc.fontSize(14).font("Helvetica-Bold").text(meta.title, { align: "center" });
    doc.moveDown(0.3);
    doc.fontSize(9).font("Helvetica").text(meta.subtitle, { align: "center" });
    doc.moveDown(0.5);
    doc.fontSize(8).text(
      `Orders: ${tableRows.length}  |  Plants: ${meta.totalPlants.toLocaleString("en-IN")}  |  Order value: ₹${meta.totalOrderValue.toLocaleString("en-IN")}  |  Collected: ₹${meta.totalCollected.toLocaleString("en-IN")}  |  Pending: ₹${meta.totalPending.toLocaleString("en-IN")}`,
      { align: "center" }
    );
    doc.moveDown(0.6);

    const cols = [
      { key: "sr", label: "Sr", w: 22 },
      { key: "orderId", label: "Order #", w: 38 },
      { key: "farmer", label: "Farmer", w: 72 },
      { key: "taluka", label: "Taluka", w: 52 },
      { key: "village", label: "Village", w: 52 },
      { key: "sales", label: "Salesperson", w: 58 },
      { key: "qty", label: "Plants", w: 36 },
      { key: "collected", label: "Collected", w: 40 },
      { key: "pending", label: "Pending", w: 40 },
      { key: "paySt", label: "Pay status", w: 44 },
      { key: "ordSt", label: "Order status", w: 52 },
      { key: "book", label: "Booking", w: 48 },
      { key: "del", label: "Delivery", w: 48 },
      { key: "disp", label: "Dispatch", w: 48 },
      { key: "payments", label: "Payment details", w: 130 },
      { key: "remark", label: "Remark", w: 70 },
    ];

    const tableLeft = doc.page.margins.left;
    const headerY = doc.y;
    const rowH = 11;
    const headerH = 22;

    function drawHeader(y) {
      let x = tableLeft;
      doc.font("Helvetica-Bold").fontSize(6);
      for (const c of cols) {
        doc.rect(x, y, c.w, headerH).stroke();
        doc.text(c.label, x + 2, y + 3, { width: c.w - 4, lineGap: 0 });
        x += c.w;
      }
    }

    function drawRow(y, r, sr) {
      let x = tableLeft;
      doc.font("Helvetica").fontSize(5.5);
      const cells = [
        String(sr),
        String(r.orderId),
        r.farmerName.slice(0, 28),
        r.taluka.slice(0, 22),
        r.village.slice(0, 22),
        r.salesPersonName.slice(0, 24),
        String(r.plants),
        r.collected > 0 ? `₹${r.collected.toLocaleString("en-IN")}` : "—",
        r.pending > 0 ? `₹${r.pending.toLocaleString("en-IN")}` : "—",
        r.orderPaymentStatus,
        r.orderStatus,
        r.bookingDate,
        r.deliveryDate,
        r.dispatchDate,
        r.paymentDetails,
        r.remark,
      ];
      const lineCounts = cells.map((text, i) => {
        const h = doc.heightOfString(String(text), { width: cols[i].w - 4, lineGap: 0 });
        return Math.max(1, Math.ceil(h / (rowH - 1)));
      });
      const maxLines = Math.max(...lineCounts, 1);
      const cellH = Math.max(headerH * 0.85, maxLines * rowH);

      for (let i = 0; i < cols.length; i++) {
        doc.rect(x, y, cols[i].w, cellH).stroke();
        doc.text(String(cells[i]), x + 2, y + 2, {
          width: cols[i].w - 4,
          lineGap: 0,
        });
        x += cols[i].w;
      }
      return cellH;
    }

    drawHeader(headerY);
    let y = headerY + headerH;

    let sr = 1;
    for (const r of tableRows) {
      const estH = 28;
      if (y + estH > doc.page.height - doc.page.margins.bottom) {
        doc.addPage({ size: "A4", layout: "landscape", margins: doc.page.margins });
        y = doc.page.margins.top;
        drawHeader(y);
        y += headerH;
      }
      const h = drawRow(y, r, sr++);
      y += h;
    }

    doc.end();
    stream.on("finish", resolve);
    stream.on("error", reject);
  });
}

async function main() {
  if (!uri) {
    console.error("No Mongo URI in .env (set PROD_MONGO_URL for production).");
    process.exit(1);
  }

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 30000 });

  let bananaPlant = await PlantCms.findOne({ name: /^banana$/i }).lean();
  if (!bananaPlant) {
    bananaPlant = await PlantCms.findOne({ name: /banana|keli/i }).lean();
  }
  if (!bananaPlant) {
    console.error("Banana plant not found in PlantCms.");
    await mongoose.disconnect();
    process.exit(1);
  }

  const raw = await fetchRows(bananaPlant);

  const tableRows = [];
  let totalPlants = 0;
  let totalOrderValue = 0;
  let totalCollected = 0;
  let totalPending = 0;
  let excludedByMobile = 0;

  for (const row of raw) {
    if (isExcludedFarmerMobile(row.farmerMobile)) {
      excludedByMobile += 1;
      continue;
    }

    const plants =
      Number(row.linePlantTotal) ||
      (Number(row.numberOfPlants) || 0) + (Number(row.additionalPlants) || 0);
    const rate = Number(row.rate) || 0;
    const orderValue = plants * rate;
    const { collected, pending } = sumCollectedAndPending(row.payment);

    if (!includeZeroAdvance && collected <= 0 && pending <= 0) continue;

    totalPlants += plants;
    totalOrderValue += orderValue;
    totalCollected += collected;
    totalPending += pending;

    tableRows.push({
      orderId: row.orderId,
      farmerName: row.farmerName || "—",
      taluka: row.taluka || "—",
      village: row.village || "—",
      salesPersonName: row.salesPersonName || "—",
      variety: row.variety || "Banana",
      plants,
      rate,
      orderValue,
      collected,
      pending,
      orderPaymentStatus: row.orderPaymentStatus || "—",
      orderStatus: row.orderStatus || "—",
      bookingDate: formatDate(row.orderBookingDate),
      deliveryDate: formatDate(row.deliveryDate),
      dispatchDate: formatDate(firstDispatchDate(row)),
      paymentDetails: formatPaymentLines(row.payment),
      remark: remarksText(row),
      remainingPlants: row.remainingPlants,
    });
  }

  await mongoose.disconnect();

  const outArg = argAfter("--out");
  const outDir = path.join(__dirname, "exports");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:-]/g, "");
  const outPath =
    outArg && path.isAbsolute(outArg)
      ? outArg
      : outArg
        ? path.join(process.cwd(), outArg)
        : path.join(outDir, `banana-advance-july-${reportYear}-${stamp}.pdf`);

  const meta = {
    title: "Banana — Payments (COLLECTED + PENDING)",
    subtitle: `Delivery on or before 31-Jul-${reportYear} · Excl. farmers ${[...EXCLUDED_FARMER_MOBILES].join(", ")} · ${includeZeroAdvance ? "all orders" : "with payment only"}`,
    totalPlants,
    totalOrderValue,
    totalCollected,
    totalPending,
  };

  await buildPdf(outPath, meta, tableRows);

  console.log("Wrote:", outPath);
  console.log("Rows:", tableRows.length);
  console.log("Excluded orders (farmer mobile):", excludedByMobile);
  console.log("Total COLLECTED: ₹", totalCollected.toLocaleString("en-IN"));
  console.log("Total PENDING: ₹", totalPending.toLocaleString("en-IN"));
  console.log(
    "Mongo:",
    preferStage ? "stage" : "prod (PROD_MONGO_URL)"
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
