/**
 * READ-ONLY dry run: paper shed stock (scripts/data/paper-stock-2026-10-04.mjs) vs system stock on PROD.
 * Writes nothing to the database. Produces a console report + an .xlsx in ../dryrun-reports.
 *
 *   node scripts/dryrun-reconcile-shed-stock.mjs
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import mongoose from "mongoose";
import XLSX from "xlsx";
import "../models/farmer.model.js";
import { loadShedStockPayload } from "../services/capacityShedStock.service.js";
import { PAPER, AS_ON } from "./data/paper-stock-2026-10-04.mjs";
import { reconcile, fmt, short, TOL } from "./lib/paperReconcile.mjs";

const url = process.env.PROD_MONGO_URL;
if (!url) throw new Error("PROD_MONGO_URL missing");

await mongoose.connect(url, { serverSelectionTimeoutMS: 15000, readPreference: "secondaryPreferred" });
const payload = await loadShedStockPayload();
await mongoose.disconnect();

const { rows, shedTotals } = reconcile(payload, PAPER, AS_ON);

function actionFor(r) {
  const op = r.op;
  const d = op.delta;
  if (op.kind === "skip-shed") return "do NOT touch until paper for this shed is confirmed";
  if (op.kind === "move") return `move ${op.lines.map((l) => l.batch).join(",")} from ${op.lines[0].shed} to ${op.toShed}`;
  if (d === 0) return "none";
  if (op.kind === "zero") return `zero out ${fmt(-d)}`;
  if (op.kind === "dated")
    return d > 0
      ? `add ${fmt(d)}: ${op.lines.length ? "new line on same lagwad date(s)" : "create lagwad entry"} ${op.pl.dates.map(short).join(", ")}`
      : `reduce ${fmt(-d)} (correction)`;
  return d > 0 ? `add ${fmt(d)} as 'ready yesterday' entry` : `reduce ${fmt(-d)} (correction)`;
}
rows.forEach((r) => (r.action = actionFor(r)));

const sum = (a, k) => a.reduce((s, x) => s + (x[k] || 0), 0);
console.log("\n===== DRY RUN (READ ONLY) – paper as on", AS_ON, "vs PROD system =====");
console.log("\n--- SHED TOTALS ---");
console.log("shed".padEnd(34), "paper-written".padStart(14), "paper-lines".padStart(12), "system".padStart(10), "diff".padStart(10), "diff%".padStart(8));
for (const t of shedTotals)
  console.log(
    t.shed.padEnd(34),
    fmt(t.writtenTotal).padStart(14),
    fmt(t.paperLinesSum).padStart(12),
    fmt(t.system).padStart(10),
    fmt(t.diff).padStart(10),
    (t.diffPct == null ? "n/a" : t.diffPct.toFixed(1) + "%").padStart(8),
    Math.abs(t.diffPct ?? 100) > TOL * 100 ? " <-- >10%" : "",
    t.paperInternalGap ? ` (paper lines sum off written total by ${t.paperInternalGap})` : ""
  );
const gp = sum(shedTotals, "writtenTotal");
const gs = sum(shedTotals, "system");
console.log("ALL SHEDS".padEnd(34), fmt(gp).padStart(14), fmt(sum(shedTotals, "paperLinesSum")).padStart(12), fmt(gs).padStart(10), fmt(gp - gs).padStart(10), (((gp - gs) / gs) * 100).toFixed(1).padStart(7) + "%");

console.log("\n--- LINE DETAIL ---");
let cur = "";
for (const r of rows) {
  if (r.shed !== cur) {
    cur = r.shed;
    console.log(`\n## ${cur}`);
  }
  console.log(
    `${r.status.padEnd(20)} ${r.type.padEnd(15)} ${r.item.slice(0, 52).padEnd(52)} paper ${fmt(r.paper).padStart(8)} sys ${fmt(r.system).padStart(8)} diff ${fmt(r.diff).padStart(8)} ${r.diffPct == null ? "" : r.diffPct.toFixed(1) + "%"}`
  );
  if (r.status !== "OK") console.log(`   -> ${r.action}${r.note ? "  | " + r.note : ""}`);
}
console.log("\nline status counts:", rows.reduce((m, r) => ((m[r.status] = (m[r.status] || 0) + 1), m), {}));

const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(
  wb,
  XLSX.utils.json_to_sheet(
    shedTotals.map((t) => ({
      Shed: t.shed,
      "Paper total (written)": t.writtenTotal,
      "Paper lines sum": t.paperLinesSum,
      "System total": t.system,
      Difference: t.diff,
      "Difference %": t.diffPct == null ? "" : Number(t.diffPct.toFixed(1)),
      "Over 10%": Math.abs(t.diffPct ?? 100) > TOL * 100 ? "YES" : "",
    }))
  ),
  "Shed totals"
);
XLSX.utils.book_append_sheet(
  wb,
  XLSX.utils.json_to_sheet(
    rows.map((r) => ({
      Shed: r.shed,
      Type: r.type,
      Item: r.item,
      Paper: r.paper,
      System: r.system,
      Difference: r.diff,
      "Difference %": r.diffPct == null ? "" : Number(r.diffPct.toFixed(1)),
      "Within 10%": r.within10 === "" ? "" : r.within10 ? "yes" : "no",
      Status: r.status,
      "Proposed action": r.action,
      "System lines": r.systemLines,
      Note: r.note,
    }))
  ),
  "Line detail"
);
const dir = path.resolve("..", "dryrun-reports");
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `dryrun-shed-stock-${AS_ON}.xlsx`);
XLSX.writeFile(wb, file);
console.log("\nreport written:", file);
