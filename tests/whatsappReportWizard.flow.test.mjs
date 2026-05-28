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
  parseDeliveryWindowChoice,
  parseDeliveryDueFilterChoice,
  parseAvailabilityModeChoice,
} from "../utility/whatsappReportWizardParsers.js";
import {
  extractInboundMessage,
  extractInboundMessageId,
} from "../utility/watiInboundPayload.js";
import { formatPaymentStatsWhatsApp } from "../services/whatsappReportData.service.js";
import { isPhoneAllowedForReportWizard } from "../utility/whatsappReportWizardAllowlist.js";
import { normalizeWhatsAppNumberForWati } from "../utility/watiInboundPayload.js";

test("report wizard allowlist (default numbers)", () => {
  assert.equal(isPhoneAllowedForReportWizard("7588686453"), true);
  assert.equal(isPhoneAllowedForReportWizard("7588686452"), true);
  assert.equal(isPhoneAllowedForReportWizard("9595996452"), true);
  assert.equal(isPhoneAllowedForReportWizard("919595996452"), true);
  assert.equal(isPhoneAllowedForReportWizard("917588686453"), true);
  assert.equal(isPhoneAllowedForReportWizard("917588686452"), true);
  assert.equal(
    isPhoneAllowedForReportWizard(normalizeWhatsAppNumberForWati("7588686453")),
    true
  );
  assert.equal(
    isPhoneAllowedForReportWizard(normalizeWhatsAppNumberForWati("9595996452")),
    true
  );
  assert.equal(isPhoneAllowedForReportWizard("9999999999"), false);
  assert.equal(isPhoneAllowedForReportWizard("7588686450"), false);
});

test("isReportEntry recognises starter phrases", () => {
  assert.equal(isReportEntry("get report"), true);
  assert.equal(isReportEntry("Report"), true);
  assert.equal(isReportEntry("nursery report"), true);
  assert.equal(isReportEntry("booking report"), true);
  assert.equal(isReportEntry("delivery report"), true);
  assert.equal(isReportEntry("random hello"), false);
  assert.equal(isReportEntry("x".repeat(101)), false);
});

test("parseDeliveryWindowChoice — presets", () => {
  const t = parseDeliveryWindowChoice("1");
  assert.equal(t.ok, true);
  assert.ok(t.range?.start instanceof Date);
  const w7 = parseDeliveryWindowChoice("2");
  assert.equal(w7.ok, true);
  assert.ok(w7.range?.start <= w7.range?.end);
  const w14 = parseDeliveryWindowChoice("3");
  assert.equal(w14.ok, true);
  const c = parseDeliveryWindowChoice("4");
  assert.equal(c.pendingCustom, true);
});

test("parseDeliveryDueFilterChoice", () => {
  const a = parseDeliveryDueFilterChoice("1");
  assert.equal(a.ok, true);
  assert.equal(a.mode, "due_in_window");
  const b = parseDeliveryDueFilterChoice("2");
  assert.equal(b.ok, true);
  assert.equal(b.mode, "no_due");
  const c = parseDeliveryDueFilterChoice("3");
  assert.equal(c.ok, true);
  assert.equal(c.mode, "both");
  assert.equal(parseDeliveryDueFilterChoice("maybe").ok, false);
});

test("extractInboundMessageId", () => {
  assert.equal(
    extractInboundMessageId({ whatsappMessageId: "wamid.HBgM..." }),
    "wamid.HBgM..."
  );
  assert.equal(extractInboundMessageId({}), "");
});

test("guessReportTypeFromText", () => {
  assert.equal(guessReportTypeFromText("booking report"), "booking");
  assert.equal(guessReportTypeFromText("delivery summary"), "delivery");
  assert.equal(guessReportTypeFromText("availability report"), "availability");
  assert.equal(guessReportTypeFromText("stock avail"), "availability");
  assert.equal(guessReportTypeFromText("flow report"), null);
  assert.equal(guessReportTypeFromText("get report"), null);
});

test("parseReportTypeChoice", () => {
  assert.equal(parseReportTypeChoice("1"), "booking");
  assert.equal(parseReportTypeChoice("2"), "delivery");
  assert.equal(parseReportTypeChoice("3"), "availability");
  assert.equal(parseReportTypeChoice("maybe"), null);
});

test("parseAvailabilityModeChoice", () => {
  assert.equal(parseAvailabilityModeChoice("1"), "by_plant");
  assert.equal(parseAvailabilityModeChoice("2"), "by_month");
  assert.equal(parseAvailabilityModeChoice("plant"), "by_plant");
  assert.equal(parseAvailabilityModeChoice("month"), "by_month");
  assert.equal(parseAvailabilityModeChoice("x"), null);
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
    buttonText: "",
  });
  assert.deepEqual(
    extractInboundMessage({ data: { text: "1", waId: "9876543210" } }),
    { text: "1", waId: "9876543210", buttonText: "" }
  );
});
