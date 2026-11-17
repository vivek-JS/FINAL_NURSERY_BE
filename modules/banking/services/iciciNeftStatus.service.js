/**
 * NEFT Incremental Status API — where a NEFT payout is after ICICI posted it.
 *
 * The Transaction Inquiry API stops at SUCCESS once ICICI hands the payment to
 * RBI. This API, asked by UTR, follows it to the beneficiary bank:
 *   Posted to RBI → Paid → Amount credited to Beneficiary
 *                       ↘ Amount refunded to Remitter / REVERSED (returned)
 * A returned NEFT moves the payout SUCCESS → REVERSED.
 */

import IciciPayout from "../models/iciciPayout.model.js";
import { iciciCorporateRequest } from "./iciciHttpClient.js";
import { getIciciCorporateConfig, assertCorporateConfig } from "../config/iciciCorporate.config.js";
import { pushHistory, PayoutError } from "./iciciPayout.service.js";
import { getBankingLogger } from "../utils/logger.js";

const log = () => getBankingLogger();

export const NEFT_FINAL_STATES = new Set(["CREDITED", "REFUNDED", "REVERSED"]);
const RETURNED_STATES = new Set(["REFUNDED", "REVERSED"]);
const INVALID_UTR_CODE = "999922";
const TRACK_DAYS = Number(process.env.ICICI_NEFT_TRACK_DAYS || 3);

function field(obj, ...keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (v != null && v !== "") return String(v).trim();
  }
  return "";
}

/** Normalise the bank reply into one of POSTED, PAID, CREDITED, REFUNDED, REVERSED, INVALID_UTR, FAILURE, UNKNOWN. */
export function mapNeftStatus(raw) {
  const status = field(raw, "STATUS", "Status", "status");
  const response = field(raw, "Response", "RESPONSE", "response").toUpperCase();
  const errorCode = field(raw, "ErrorCode", "ERRORCODE", "errorCode");
  const message = field(raw, "Message", "MESSAGE", "message");
  const s = status.toUpperCase();

  let state = "UNKNOWN";
  if (errorCode === INVALID_UTR_CODE || /INVALID TRANSACTION ID/i.test(message)) state = "INVALID_UTR";
  else if (s.startsWith("REVERSED")) state = "REVERSED";
  else if (s.includes("REFUNDED")) state = "REFUNDED";
  else if (s.includes("CREDITED")) state = "CREDITED";
  else if (s.includes("POSTED")) state = "POSTED";
  else if (s === "PAID") state = "PAID";
  else if (response === "FAILURE" || s === "FAILURE") state = "FAILURE";

  return {
    state,
    status,
    response,
    errorCode,
    message,
    utr: field(raw, "UTRNUMBER", "UTRNumber", "utr"),
    creditDate: field(raw, "CreditDate", "CREDITDATE", "creditDate"),
    reason: field(raw, "REASON", "Reason", "reason"),
    raw,
  };
}

function stubReply(utr) {
  if (/REFUND/i.test(utr)) {
    return { STATUS: "Amount refunded to Remitter.", UTRNUMBER: utr, CreditDate: "", Response: "SUCCESS", Reason: "ACCOUNT CLOSED" };
  }
  return { STATUS: "Amount credited to Beneficiary.", UTRNUMBER: utr, CreditDate: "", Response: "SUCCESS" };
}

/** Ask ICICI about one NEFT by UTR. */
export async function fetchNeftIncrementalStatus({ utr, userId } = {}) {
  const value = String(utr || "").trim();
  if (!value) throw new PayoutError("UTR number is required", "VALIDATION", { errors: { utr: "Required" } });
  const cfg = getIciciCorporateConfig();
  if (cfg.useStub) return mapNeftStatus(stubReply(value));

  assertCorporateConfig();
  const raw = await iciciCorporateRequest({
    endpointPath: cfg.endpoints.neftIncrementalStatus,
    payload: { UTRNUMBER: value },
    userId,
  });
  return mapNeftStatus(raw);
}

/** Record a NEFT reply on a payout; a returned NEFT reverses it. Returns true when the status changed. */
export function applyNeftResult(doc, mapped) {
  doc.bank = doc.bank || {};
  const neft = doc.bank.neft || {};
  doc.bank.neft = {
    state: mapped.state,
    status: mapped.status || mapped.message || neft.status,
    reason: mapped.reason || neft.reason,
    creditDate: mapped.creditDate || neft.creditDate,
    checkedAt: new Date(),
    checks: (neft.checks || 0) + 1,
  };

  if (doc.status !== "SUCCESS" || !RETURNED_STATES.has(mapped.state)) return false;
  pushHistory(doc, {
    action: "BANK_STATUS",
    from: "SUCCESS",
    to: "REVERSED",
    note: ["NEFT returned", mapped.status, mapped.reason].filter(Boolean).join(" — "),
  });
  doc.status = "REVERSED";
  doc.bank.message = mapped.reason ? `NEFT returned: ${mapped.reason}` : "NEFT returned to our account";
  return true;
}

/** Check one payout's NEFT now (Payouts → "Check NEFT"). */
export async function refreshPayoutNeft(id, user = null) {
  const doc = await IciciPayout.findById(id);
  if (!doc) throw new PayoutError("Payment not found", "NOT_FOUND");
  if (doc.txnType !== "RGS" || !doc.bank?.utr) {
    return { payout: doc.toObject(), checked: false, warning: "Only a NEFT payment with a UTR can be tracked" };
  }
  const mapped = await fetchNeftIncrementalStatus({ utr: doc.bank.utr, userId: user?._id });
  const changed = applyNeftResult(doc, mapped);
  await doc.save();
  return { payout: doc.toObject(), checked: true, changed, neft: mapped };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Cron: follow NEFT payouts paid in the last ICICI_NEFT_TRACK_DAYS until the
 * beneficiary bank credits or returns them. Sequential, ICICI allows 1–2 req/s.
 */
export async function trackNeftPayouts({ gapMs = 700, limit = 50 } = {}) {
  const cfg = getIciciCorporateConfig();
  const now = Date.now();
  const due = await IciciPayout.find({
    txnType: "RGS",
    status: "SUCCESS",
    "bank.utr": { $nin: [null, ""] },
    "bank.completedAt": { $gte: new Date(now - TRACK_DAYS * 24 * 60 * 60 * 1000) },
    "bank.neft.state": { $nin: [...NEFT_FINAL_STATES] },
    $or: [
      { "bank.neft.checkedAt": null },
      { "bank.neft.checkedAt": { $lt: new Date(now - cfg.payout.minCheckIntervalMs) } },
    ],
  })
    .sort({ "bank.completedAt": 1 })
    .limit(limit);

  let reversed = 0;
  let failed = 0;
  for (const doc of due) {
    try {
      const mapped = await fetchNeftIncrementalStatus({ utr: doc.bank.utr });
      if (applyNeftResult(doc, mapped)) reversed += 1;
      await doc.save();
    } catch (e) {
      failed += 1;
      log().warn("NEFT status check failed", { payoutId: String(doc._id), error: e.message });
    }
    if (gapMs) await sleep(gapMs);
  }
  return { checked: due.length, reversed, failed };
}
