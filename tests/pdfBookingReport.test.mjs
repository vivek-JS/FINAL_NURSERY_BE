/**
 * Verifies generateTodayBookingPdf returns a real PDF buffer (no DB, no WATI).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { generateTodayBookingPdf } from "../services/pdfService.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, "output");

test("generateTodayBookingPdf produces a valid PDF buffer", async () => {
  const buf = await generateTodayBookingPdf({
    reportDateLabel: "2026-05-03 → 2026-05-03 (IST)",
    lineRows: [
      {
        farmerName: "Test Farmer",
        plantName: "Tomato",
        plantType: "",
        subtype: "Hybrid",
        quantity: 100,
      },
    ],
    summaryRows: [{ plant: "Tomato", subtype: "Hybrid", quantity: 100 }],
    stats: {
      grandTotal: 100,
      bookingLines: 1,
      uniqueFarmers: 1,
    },
    dataSourceLabel: "Test source",
    bannerTitle: "Booking Report (test)",
  });

  assert.ok(Buffer.isBuffer(buf));
  assert.ok(buf.length > 500, "PDF should be at least a few hundred bytes");
  const head = buf.subarray(0, 5).toString("utf8");
  assert.equal(head, "%PDF-", "PDF magic bytes");
});

test("optional: write sample PDF to tests/output for manual open", async () => {
  const buf = await generateTodayBookingPdf({
    reportDateLabel: "2026-05-03 (IST)",
    lineRows: [
      {
        farmerName: "Demo",
        plantName: "Papaya",
        plantType: "",
        subtype: "Taiwan",
        quantity: 50,
      },
    ],
    summaryRows: [{ plant: "Papaya", subtype: "Taiwan", quantity: 50 }],
    stats: { grandTotal: 50, bookingLines: 1, uniqueFarmers: 1 },
  });
  try {
    mkdirSync(outDir, { recursive: true });
  } catch {
    /* exists */
  }
  const outPath = join(outDir, "sample-booking-report.pdf");
  writeFileSync(outPath, buf);
  assert.ok(true, `wrote ${outPath}`);
});
