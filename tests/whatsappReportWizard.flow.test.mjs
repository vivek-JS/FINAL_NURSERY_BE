/**
 * Automated checks for WhatsApp report wizard parsing (no DB / WATI).
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  isReportEntry,
  guessReportTypeFromText,
  parseReportTypeChoice,
  parseDateChoice,
  parseCustomRangeText,
} from "../utility/whatsappReportWizardParsers.js";
import { extractInboundMessage } from "../utility/watiInboundPayload.js";
import { formatPaymentStatsWhatsApp } from "../services/whatsappReportData.service.js";

test("isReportEntry recognises starter phrases", () => {
  assert.equal(isReportEntry("get report"), true);
  assert.equal(isReportEntry("nursery report"), true);
  assert.equal(isReportEntry("booking report"), true);
  assert.equal(isReportEntry("delivery report"), true);
  assert.equal(isReportEntry("random hello"), false);
  assert.equal(isReportEntry("x".repeat(101)), false);
});

test("guessReportTypeFromText", () => {
  assert.equal(guessReportTypeFromText("booking report"), "booking");
  assert.equal(guessReportTypeFromText("delivery summary"), "delivery");
  assert.equal(guessReportTypeFromText("sowing stats"), "sowing");
  assert.equal(guessReportTypeFromText("get report"), null);
});

test("parseReportTypeChoice", () => {
  assert.equal(parseReportTypeChoice("1"), "booking");
  assert.equal(parseReportTypeChoice("2"), "delivery");
  assert.equal(parseReportTypeChoice("3"), "sowing");
  assert.equal(parseReportTypeChoice("maybe"), null);
});

test("parseDateChoice — presets", () => {
  const today = parseDateChoice("1");
  assert.equal(today.ok, true);
  assert.ok(today.range?.start instanceof Date);
  assert.ok(today.range?.end instanceof Date);

  const customPrompt = parseDateChoice("4");
  assert.equal(customPrompt.ok, true);
  assert.equal(customPrompt.pendingCustom, true);
});

test("parseCustomRangeText ISO", () => {
  const r = parseCustomRangeText("2026-05-01 to 2026-05-03");
  assert.ok(r);
  assert.ok(r.start <= r.end);
});

test("parseCustomRangeText DD-MM-YYYY", () => {
  const r = parseCustomRangeText("01-05-2026 to 03-05-2026");
  assert.ok(r);
});

test("formatPaymentStatsWhatsApp shape", () => {
  const text = formatPaymentStatsWhatsApp(
    {
      summary: {
        orders: 5,
        totalDue: 10000,
        totalCollected: 4000,
        totalOutstanding: 6000,
        pendingPaymentOrders: 3,
        completedPaymentOrders: 2,
        partialPaidOrders: 1,
        bankVerifiedPendingOrders: 0,
      },
      byPlant: [{ _id: "Tomato", outstanding: 6000, collected: 4000, orders: 5 }],
    },
    "Test heading"
  );
  assert.ok(text.includes("₹"));
  assert.ok(text.includes("PENDING"));
});

test("extractInboundMessage (webhook shapes)", () => {
  assert.deepEqual(extractInboundMessage({ text: "get report", waId: "919998887766" }), {
    text: "get report",
    waId: "919998887766",
  });
  assert.deepEqual(
    extractInboundMessage({ data: { text: "1", waId: "9876543210" } }),
    { text: "1", waId: "9876543210" }
  );
});
