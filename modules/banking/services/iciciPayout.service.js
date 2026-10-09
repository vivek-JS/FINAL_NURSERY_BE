/**
 * Maker–checker payouts through the ICICI CIB Transaction API.
 *
 *   1. Maker (accountant) creates the payout in the ERP     → PENDING_APPROVAL
 *   2. Checker (a different user, checker role) approves    → sent to ICICI
 *   3. ICICI holds it for the authoriser in net banking     → AWAITING_BANK_APPROVAL
 *   4. Status is polled until the bank says SUCCESS/FAILED
 *
 * WORKFLOW_REQD is never sent: in the CIB spec that flag *bypasses* the bank's
 * approval workflow ("MANDATORY when to bypass the Txn Workflow. NO Approval
 * required"). Leaving it out is what keeps step 3.
 *
 * Re-sending the same UNIQUEID is safe — ICICI returns the existing reference
 * and never posts it twice — so a payout with no answer is resent with its own
 * id, never recreated.
 */

import crypto from "crypto";
import mongoose from "mongoose";
import IciciPayout, {
  PAYOUT_TERMINAL,
  PAYOUT_TXN_TYPES,
  PAYOUT_PURPOSES,
} from "../models/iciciPayout.model.js";
import IciciBeneficiary, { PAYEE_TYPES } from "../models/iciciBeneficiary.model.js";
import { iciciCorporateRequest } from "./iciciHttpClient.js";
import { getIciciCorporateConfig, assertCorporateConfig } from "../config/iciciCorporate.config.js";
import { isCibSvCryptoMode } from "../crypto/rsaEncryption.js";
import { getBankingLogger } from "../utils/logger.js";

const log = () => getBankingLogger();

/** Static IFSC for ICICI-to-ICICI (TPA) transfers. */
export const ICICI_FT_IFSC = "ICIC0000011";
export const RTGS_MIN_AMOUNT = 200000;
export const IMPS_MAX_AMOUNT = 500000;
export const NEFT_REMARKS_MAX = 32;
export const REMARKS_MAX = 255;
export const PAYEE_NAME_MAX = 80;

export const TXN_TYPE_LABEL = { RGS: "NEFT", RTG: "RTGS", IFS: "IMPS", TPA: "ICICI to ICICI" };

export const NAME_RE = /^[A-Za-z0-9 ]+$/;
const REMARKS_RE = /^[A-Za-z0-9 ]*$/;
export const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
export const ACCOUNT_RE = /^[A-Z0-9]{6,34}$/;
const AMOUNT_RE = /^\d+(\.\d{1,2})?$/;

/** Bank codes meaning "not processed yet — check status later", not a failure. */
const RETRY_LATER_CODES = new Set(["8010", "8012", "8013", "103068"]);

export const PAYOUT_VIEWS = {
  approval: ["PENDING_APPROVAL"],
  bank: ["SUBMITTING", "AWAITING_BANK_APPROVAL", "PROCESSING", "UNKNOWN"],
  done: ["SUCCESS", "FAILED", "REVERSED", "REJECTED", "CANCELLED"],
};

const POLLABLE = ["AWAITING_BANK_APPROVAL", "PROCESSING", "UNKNOWN"];
const SUBMITTING_STALE_MS = 5 * 60 * 1000;

class PayoutError extends Error {
  constructor(message, code, extra = {}) {
    super(message);
    this.code = code;
    Object.assign(this, extra);
  }
}

export function userName(user) {
  return user?.name || user?.firstName || user?.phoneNumber || "User";
}

function userRoles(user) {
  return [user?.role, user?.jobTitle].filter(Boolean);
}

export function isPayoutChecker(user, cfg = getIciciCorporateConfig()) {
  return userRoles(user).some((r) => cfg.payout.checkerRoles.includes(r));
}

export function isSuperAdmin(user) {
  return userRoles(user).some((r) => r === "SUPER_ADMIN" || r === "SUPERADMIN");
}

export function maskAccount(acc) {
  const s = String(acc || "");
  if (s.length <= 4) return s;
  return `${"•".repeat(Math.min(6, s.length - 4))}${s.slice(-4)}`;
}

/**
 * Validate and normalise a payout request the way ICICI will judge it, so the
 * maker hears about a bad IFSC now rather than after two approvals.
 *
 * @returns {{ ok: boolean, errors: Record<string,string>, value?: object }}
 */
export function validatePayoutInput(input = {}, { debitAccount } = {}) {
  const errors = {};
  const txnType = String(input.txnType || "").trim().toUpperCase();
  const name = String(input.payeeName ?? input.payee?.name ?? "")
    .trim()
    .replace(/\s+/g, " ");
  const accountNumber = String(input.accountNumber ?? input.payee?.accountNumber ?? "")
    .replace(/\s+/g, "")
    .toUpperCase();
  let ifsc = String(input.ifsc ?? input.payee?.ifsc ?? "")
    .trim()
    .toUpperCase();
  const amountRaw = String(input.amount ?? "").trim();
  const remarks = String(input.remarks || "")
    .trim()
    .replace(/\s+/g, " ");
  const purpose = String(input.purpose || "OTHER").toUpperCase();
  const payeeType = String(input.payeeType ?? input.payee?.type ?? "VENDOR").toUpperCase();
  const referenceNo = String(input.referenceNo || "").trim();
  const bankName = String(input.bankName ?? input.payee?.bankName ?? "").trim();
  const debit = String(debitAccount || "").replace(/\s+/g, "").toUpperCase();

  if (!PAYOUT_TXN_TYPES.includes(txnType)) {
    errors.txnType = "Choose NEFT, RTGS, IMPS or ICICI to ICICI";
  }
  if (txnType === "TPA") ifsc = ICICI_FT_IFSC;

  if (!name) errors.payeeName = "Payee name is required";
  else if (name.length > PAYEE_NAME_MAX) errors.payeeName = `At most ${PAYEE_NAME_MAX} characters`;
  else if (!NAME_RE.test(name)) errors.payeeName = "Letters, numbers and spaces only";

  if (!accountNumber) errors.accountNumber = "Account number is required";
  else if (!ACCOUNT_RE.test(accountNumber)) {
    errors.accountNumber = "6 to 34 letters or digits, no spaces or symbols";
  } else if (debit && accountNumber === debit) {
    errors.accountNumber = "Cannot pay into the account the money is coming from";
  }

  if (!ifsc) errors.ifsc = "IFSC is required";
  else if (!IFSC_RE.test(ifsc)) errors.ifsc = "IFSC looks wrong (e.g. HDFC0001234)";

  let amount = NaN;
  if (!AMOUNT_RE.test(amountRaw)) {
    errors.amount = "Enter an amount with at most 2 decimals";
  } else {
    amount = Number(amountRaw);
    if (!(amount > 0)) errors.amount = "Amount must be more than zero";
    else if (txnType === "RTG" && amount < RTGS_MIN_AMOUNT) {
      errors.amount = "RTGS needs at least ₹2,00,000 — use NEFT or IMPS";
    } else if (txnType === "IFS" && amount > IMPS_MAX_AMOUNT) {
      errors.amount = "IMPS allows at most ₹5,00,000 — use NEFT or RTGS";
    }
  }

  const remarksMax = txnType === "RGS" ? NEFT_REMARKS_MAX : REMARKS_MAX;
  if (!REMARKS_RE.test(remarks)) errors.remarks = "Letters, numbers and spaces only";
  else if (remarks.length > remarksMax) {
    errors.remarks = `At most ${remarksMax} characters${txnType === "RGS" ? " for NEFT" : ""}`;
  }

  if (!PAYOUT_PURPOSES.includes(purpose)) errors.purpose = "Unknown purpose";
  if (!PAYEE_TYPES.includes(payeeType)) errors.payeeType = "Unknown payee type";
  if (referenceNo.length > 40) errors.referenceNo = "At most 40 characters";
  if (!debit) errors.debitAccount = "No debit account configured (ICICI_ACCOUNT_ID)";

  const ok = Object.keys(errors).length === 0;
  return {
    ok,
    errors,
    value: ok
      ? {
          payee: { name, accountNumber, ifsc, bankName, type: payeeType },
          amount,
          txnType,
          remarks,
          purpose,
          referenceNo,
          debitAccount: debit,
        }
      : undefined,
  };
}

function pick(obj, ...keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (v != null && String(v).trim() !== "") return String(v).trim();
  }
  return "";
}

/**
 * Translate a Transaction or Transaction Inquiry response into a payout status.
 *
 * @returns {{ status: string, bankStatus: string, response: string, message: string, errorCode: string, utr: string, reqId: string }}
 */
export function mapBankResult(raw) {
  const response = pick(raw, "RESPONSE", "Response", "response").toUpperCase();
  const bankStatus = pick(raw, "STATUS", "Status", "status");
  const message = pick(raw, "MESSAGE", "Message", "message");
  const errorCode =
    pick(raw, "ERRORCODE", "ErrorCode", "errorCode", "RESPONSECODE", "ResponseCode") ||
    (message.match(/^(\d{3,6})\s*-/) || [])[1] ||
    "";
  const utr = pick(raw, "UTRNUMBER", "UtrNumber", "UTR", "utr");
  const reqId = pick(raw, "REQID", "ReqId", "reqId");
  const s = bankStatus.toUpperCase();

  const out = (status) => ({ status, bankStatus, response, message, errorCode, utr, reqId });

  if (
    RETRY_LATER_CODES.has(errorCode) ||
    /check status after|do not re-?initiate|connection to rib failed/i.test(message)
  ) {
    return out("UNKNOWN");
  }
  if (s === "SUCCESS") return out("SUCCESS");
  if (s.includes("PENDING FOR APPROVAL") || s.includes("PENDING FOR AUTHORI")) {
    return out("AWAITING_BANK_APPROVAL");
  }
  if (s.startsWith("PENDING") || s === "PROCESSING") return out("PROCESSING");
  if (s === "REVERSED") return out("REVERSED");
  if (s === "FAILURE" || s === "FAILED") return out("FAILED");
  if (s === "DUPLICATE" || s === "UNCERTAIN") return out("UNKNOWN");

  if (!s) {
    if (response === "FAILURE") return out("FAILED");
    if (response === "SUCCESS") {
      if (/processed successfully/i.test(message)) return out("SUCCESS");
      return out("AWAITING_BANK_APPROVAL");
    }
  }
  return out("UNKNOWN");
}

/** 15 characters, all of them unique — ICICI shows only the first 15 in the statement. */
export function generatePayoutUniqueId(now = new Date()) {
  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const rand = BigInt(`0x${crypto.randomBytes(6).toString("hex")}`)
    .toString(36)
    .toUpperCase()
    .padStart(7, "0")
    .slice(-7);
  return `RB${yy}${mm}${dd}${rand}`;
}

function bankPayload(p) {
  return {
    UNIQUEID: p.uniqueId,
    DEBITACC: p.debitAccount,
    CREDITACC: p.payee.accountNumber,
    IFSC: p.payee.ifsc,
    AMOUNT: Number(p.amount).toFixed(2),
    CURRENCY: "INR",
    TXNTYPE: p.txnType,
    PAYEENAME: p.payee.name,
    REMARKS: p.remarks || "",
  };
}

function stubReqId() {
  return String(crypto.randomInt(10 ** 10, 10 ** 11));
}

/** Test bank: holds every payment for approval; remarks "STUBFAIL" makes it fail. */
function stubSubmit(p) {
  return {
    RESPONSE: "SUCCESS",
    STATUS: "Pending For approval",
    UNIQUEID: p.uniqueId,
    URN: "STUB",
    REQID: p.bank?.reqId || stubReqId(),
    UTRNUMBER: "",
    MESSAGE: `Transaction with reference id ${p.uniqueId} submitted successfully and is pending for Processing`,
  };
}

function stubInquiry(p) {
  if (/STUBFAIL/i.test(p.remarks || "")) {
    return { RESPONSE: "SUCCESS", STATUS: "FAILURE", UNIQUEID: p.uniqueId, MESSAGE: "Stub failure" };
  }
  return {
    RESPONSE: "SUCCESS",
    STATUS: "SUCCESS",
    UNIQUEID: p.uniqueId,
    UTRNUMBER: p.bank?.utr || `STUBUTR${p.uniqueId.slice(-8)}`,
  };
}

export function pushHistory(doc, { action, from, to, user, note }) {
  doc.history.push({
    at: new Date(),
    action,
    fromStatus: from,
    toStatus: to,
    by: user?._id || null,
    byName: user ? userName(user) : "System",
    note: note || undefined,
  });
}

/**
 * Record a bank answer on the payout.
 *
 * Status only moves forward: a terminal payout stays terminal (apart from
 * SUCCESS → REVERSED), and an inquiry that fails without naming a status keeps
 * the current one — "could not look it up" is not "the payment failed".
 */
function applyBankResult(doc, mapped, { source, user }) {
  const from = doc.status;
  let next = mapped.status;

  if (source === "INQUIRY" && !mapped.bankStatus && next === "FAILED") next = from;
  if (from === "SUCCESS" && next !== "REVERSED") next = "SUCCESS";
  if (PAYOUT_TERMINAL.has(from) && from !== "SUCCESS") next = from;

  const now = new Date();
  doc.bank = doc.bank || {};
  if (mapped.reqId) doc.bank.reqId = mapped.reqId;
  if (mapped.utr) doc.bank.utr = mapped.utr;
  if (mapped.bankStatus) doc.bank.status = mapped.bankStatus;
  if (mapped.response) doc.bank.response = mapped.response;
  doc.bank.errorCode = mapped.errorCode || undefined;
  doc.bank.message = mapped.message || doc.bank.message;
  doc.bank.lastCheckedAt = now;
  if (source === "SUBMIT" || source === "RESEND") doc.bank.submittedAt = doc.bank.submittedAt || now;
  if (source === "INQUIRY") doc.bank.checks = (doc.bank.checks || 0) + 1;
  if (PAYOUT_TERMINAL.has(next) && !PAYOUT_TERMINAL.has(from)) doc.bank.completedAt = now;

  doc.status = next;
  if (from !== next || source !== "INQUIRY") {
    pushHistory(doc, {
      action:
        source === "SUBMIT" ? "SENT_TO_BANK" : source === "RESEND" ? "RESENT_TO_BANK" : "BANK_STATUS",
      from,
      to: next,
      user: source === "INQUIRY" ? null : user,
      note: [mapped.bankStatus, mapped.message].filter(Boolean).join(" — ") || undefined,
    });
  }
}

async function sendToBank(doc, user, source) {
  const cfg = getIciciCorporateConfig();
  let raw;
  try {
    raw = cfg.useStub
      ? stubSubmit(doc)
      : await iciciCorporateRequest({
          endpointPath: cfg.endpoints.transaction,
          payload: bankPayload(doc),
          idempotencyKey: `payout-${doc.uniqueId}`,
          userId: user?._id,
        });
  } catch (err) {
    const http = err.response?.status;
    const rejected = http && http < 500 && http !== 408 && http !== 429;
    raw = rejected
      ? { RESPONSE: "FAILURE", MESSAGE: `ICICI rejected the request (HTTP ${http}): ${err.message}` }
      : {
          RESPONSE: "FAILURE",
          ERRORCODE: "8013",
          MESSAGE: `No answer from ICICI (${err.message}). Status will be checked — do not create a new payment.`,
        };
    log().warn("Payout submit error", { uniqueId: doc.uniqueId, http, error: err.message });
  }

  if (cfg.useStub) doc.bank.stub = true;
  applyBankResult(doc, mapBankResult(raw), { source, user });
  await doc.save();
  log().info("Payout sent to ICICI", { uniqueId: doc.uniqueId, status: doc.status });
  return doc;
}

/** Same payee account and amount in the last 7 days, still alive. */
async function findPossibleDuplicate(value) {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  return IciciPayout.findOne({
    "payee.accountNumber": value.payee.accountNumber,
    amount: value.amount,
    createdAt: { $gte: since },
    status: { $nin: ["REJECTED", "CANCELLED", "FAILED"] },
  })
    .sort({ createdAt: -1 })
    .lean();
}

function defaultDebitAccount(cfg) {
  return cfg.accountNumber || (cfg.useStub ? "STUBDEBIT0001" : "");
}

export function getPayoutConfig(user) {
  const cfg = getIciciCorporateConfig();
  const debit = defaultDebitAccount(cfg);
  return {
    stub: cfg.useStub,
    environment: cfg.envType,
    debitAccount: maskAccount(debit),
    debitConfigured: Boolean(debit),
    canApprove: isPayoutChecker(user, cfg),
    requireBeneficiary: cfg.payout.requireBeneficiary,
    checkerRoles: cfg.payout.checkerRoles,
    limits: {
      rtgsMin: RTGS_MIN_AMOUNT,
      impsMax: IMPS_MAX_AMOUNT,
      neftRemarksMax: NEFT_REMARKS_MAX,
      remarksMax: REMARKS_MAX,
      payeeNameMax: PAYEE_NAME_MAX,
    },
    ftIfsc: ICICI_FT_IFSC,
    txnTypes: TXN_TYPE_LABEL,
    purposes: PAYOUT_PURPOSES,
    payeeTypes: PAYEE_TYPES,
  };
}

/** The approved payee a payout names, or null for a one-time payee (if allowed). */
async function resolveBeneficiary(input, cfg) {
  const id = input?.beneficiaryId;
  if (!id) {
    if (cfg.payout.requireBeneficiary) {
      throw new PayoutError("Choose an approved payee — one-time payees are turned off", "VALIDATION", {
        errors: { beneficiaryId: "Choose an approved payee" },
      });
    }
    return null;
  }
  const bene = mongoose.isValidObjectId(id) ? await IciciBeneficiary.findById(id).lean() : null;
  if (!bene || bene.status !== "ACTIVE") {
    throw new PayoutError("That payee is not approved", "VALIDATION", {
      errors: { beneficiaryId: bene ? `Payee is ${bene.status.toLowerCase().replace(/_/g, " ")}` : "Payee not found" },
    });
  }
  return bene;
}

/** Maker: create a payout awaiting ERP approval. */
export async function createPayout(input, user, { confirmDuplicate = false } = {}) {
  const cfg = getIciciCorporateConfig();
  const bene = await resolveBeneficiary(input, cfg);
  const fields = bene
    ? {
        ...input,
        payeeName: bene.name,
        accountNumber: bene.accountNumber,
        ifsc: bene.ifsc,
        bankName: bene.bankName,
        payeeType: bene.type,
      }
    : input;
  const check = validatePayoutInput(fields, { debitAccount: defaultDebitAccount(cfg) });
  if (bene && check.value?.txnType === "TPA" && bene.bankKind !== "ICICI") {
    check.ok = false;
    check.errors.txnType = "ICICI to ICICI needs a payee with an ICICI Bank account";
  }
  if (!check.ok) {
    throw new PayoutError("Please fix the highlighted fields", "VALIDATION", { errors: check.errors });
  }
  if (bene) check.value.beneficiaryId = bene._id;

  const dup = await findPossibleDuplicate(check.value);
  if (dup && !confirmDuplicate) {
    throw new PayoutError(
      `A payment of ₹${dup.amount} to this account already exists (${dup.uniqueId}, ${dup.status})`,
      "POSSIBLE_DUPLICATE",
      { duplicate: { _id: dup._id, uniqueId: dup.uniqueId, status: dup.status, createdAt: dup.createdAt } }
    );
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const doc = new IciciPayout({
      ...check.value,
      uniqueId: generatePayoutUniqueId(),
      status: "PENDING_APPROVAL",
      makerId: user._id,
      makerName: userName(user),
      bank: { stub: cfg.useStub },
    });
    pushHistory(doc, {
      action: "CREATED",
      to: "PENDING_APPROVAL",
      user,
      note: dup ? `Created despite possible duplicate ${dup.uniqueId}` : undefined,
    });
    try {
      await doc.save();
      return doc.toObject();
    } catch (err) {
      if (err?.code !== 11000) throw err;
    }
  }
  throw new PayoutError("Could not allocate a unique payment reference, try again", "UNIQUE_ID");
}

async function loadOrThrow(id) {
  const doc = await IciciPayout.findById(id);
  if (!doc) throw new PayoutError("Payout not found", "NOT_FOUND");
  return doc;
}

/** Checker: approve in the ERP and send to ICICI for the net-banking approval. */
export async function approvePayout(id, user, { note } = {}) {
  const cfg = getIciciCorporateConfig();
  if (!isPayoutChecker(user, cfg)) {
    throw new PayoutError("Only an approver can approve payments", "FORBIDDEN");
  }
  const current = await loadOrThrow(id);
  if (String(current.makerId) === String(user._id)) {
    throw new PayoutError("You created this payment — another approver must approve it", "SELF_APPROVAL");
  }
  if (current.status !== "PENDING_APPROVAL") {
    throw new PayoutError(`Payment is already ${current.status}`, "BAD_STATE");
  }
  if (current.beneficiaryId) {
    const bene = await IciciBeneficiary.findById(current.beneficiaryId).select("status").lean();
    if (bene?.status !== "ACTIVE") {
      throw new PayoutError("The payee was disabled after this payment was created — reject it", "BAD_STATE");
    }
  }
  if (!cfg.useStub) {
    try {
      assertCorporateConfig();
    } catch (err) {
      throw new PayoutError(err.message, "BANK_NOT_CONFIGURED");
    }
  }

  const now = new Date();
  const doc = await IciciPayout.findOneAndUpdate(
    { _id: id, status: "PENDING_APPROVAL", makerId: { $ne: user._id } },
    {
      $set: {
        status: "SUBMITTING",
        checkerId: user._id,
        checkerName: userName(user),
        checkedAt: now,
        checkerNote: note || undefined,
      },
      $push: {
        history: {
          at: now,
          action: "APPROVED",
          fromStatus: "PENDING_APPROVAL",
          toStatus: "SUBMITTING",
          by: user._id,
          byName: userName(user),
          note: note || undefined,
        },
      },
    },
    { new: true }
  );
  if (!doc) throw new PayoutError("Payment was approved or changed by someone else", "BAD_STATE");

  await sendToBank(doc, user, "SUBMIT");
  return doc.toObject();
}

/** Checker: reject in the ERP. Nothing reaches the bank. */
export async function rejectPayout(id, user, { reason } = {}) {
  if (!isPayoutChecker(user)) {
    throw new PayoutError("Only an approver can reject payments", "FORBIDDEN");
  }
  const text = String(reason || "").trim();
  if (!text) throw new PayoutError("Give a reason for rejecting", "VALIDATION", { errors: { reason: "Required" } });

  const now = new Date();
  const doc = await IciciPayout.findOneAndUpdate(
    { _id: id, status: "PENDING_APPROVAL" },
    {
      $set: {
        status: "REJECTED",
        checkerId: user._id,
        checkerName: userName(user),
        checkedAt: now,
        rejectReason: text,
      },
      $push: {
        history: {
          at: now,
          action: "REJECTED",
          fromStatus: "PENDING_APPROVAL",
          toStatus: "REJECTED",
          by: user._id,
          byName: userName(user),
          note: text,
        },
      },
    },
    { new: true }
  ).lean();
  if (!doc) {
    await loadOrThrow(id);
    throw new PayoutError("Only a payment awaiting approval can be rejected", "BAD_STATE");
  }
  return doc;
}

/** Maker (or a super admin): withdraw before approval. */
export async function cancelPayout(id, user, { reason } = {}) {
  const current = await loadOrThrow(id);
  if (String(current.makerId) !== String(user._id) && !isSuperAdmin(user)) {
    throw new PayoutError("Only the person who created it can cancel this payment", "FORBIDDEN");
  }
  const now = new Date();
  const doc = await IciciPayout.findOneAndUpdate(
    { _id: id, status: "PENDING_APPROVAL" },
    {
      $set: { status: "CANCELLED" },
      $push: {
        history: {
          at: now,
          action: "CANCELLED",
          fromStatus: "PENDING_APPROVAL",
          toStatus: "CANCELLED",
          by: user._id,
          byName: userName(user),
          note: String(reason || "").trim() || undefined,
        },
      },
    },
    { new: true }
  ).lean();
  if (!doc) throw new PayoutError("Only a payment awaiting approval can be cancelled", "BAD_STATE");
  return doc;
}

/** Ask ICICI where a sent payout is now. */
export async function refreshPayoutStatus(id, user = null) {
  const doc = await loadOrThrow(id);
  if (!POLLABLE.includes(doc.status)) return { payout: doc.toObject(), checked: false };

  const cfg = getIciciCorporateConfig();
  let raw;
  try {
    if (cfg.useStub) {
      raw = stubInquiry(doc);
    } else {
      assertCorporateConfig();
      raw = await iciciCorporateRequest({
        endpointPath: isCibSvCryptoMode()
          ? cfg.endpoints.transactionInquiry
          : cfg.endpoints.transactionStatus,
        payload: { UNIQUEID: doc.uniqueId },
        idempotencyKey: `payout-status-${doc.uniqueId}-${Date.now()}`,
        userId: user?._id,
      });
    }
  } catch (err) {
    doc.bank.lastCheckedAt = new Date();
    doc.bank.message = `Status check failed: ${err.message}`;
    await doc.save();
    return { payout: doc.toObject(), checked: false, warning: doc.bank.message };
  }

  applyBankResult(doc, mapBankResult(raw), { source: "INQUIRY", user });
  await doc.save();
  return { payout: doc.toObject(), checked: true };
}

/** Checker: resend a payout ICICI never answered, with its own UNIQUEID. */
export async function resendPayout(id, user) {
  if (!isPayoutChecker(user)) {
    throw new PayoutError("Only an approver can resend payments", "FORBIDDEN");
  }
  const doc = await loadOrThrow(id);
  if (doc.status !== "UNKNOWN") {
    throw new PayoutError("Only a payment with no bank answer can be resent", "BAD_STATE");
  }
  await sendToBank(doc, user, "RESEND");
  return doc.toObject();
}

export async function getPayout(id) {
  return (await loadOrThrow(id)).toObject();
}

export function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function listPayouts({ view = "all", search = "", limit = 50, skip = 0 } = {}) {
  const filter = {};
  if (PAYOUT_VIEWS[view]) filter.status = { $in: PAYOUT_VIEWS[view] };
  const q = String(search || "").trim();
  if (q) {
    const re = new RegExp(escapeRegex(q), "i");
    filter.$or = [
      { "payee.name": re },
      { uniqueId: re },
      { referenceNo: re },
      { "bank.utr": re },
      { "payee.accountNumber": re },
    ];
  }

  const pageSize = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const offset = Math.max(Number(skip) || 0, 0);
  const [items, total] = await Promise.all([
    IciciPayout.find(filter).sort({ createdAt: -1 }).skip(offset).limit(pageSize).lean(),
    IciciPayout.countDocuments(filter),
  ]);

  return { items, total, limit: pageSize, skip: offset, hasMore: offset + items.length < total };
}

/** Counts and amounts for the summary cards. */
export async function payoutSummary() {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const since30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const [byStatus, paidToday] = await Promise.all([
    IciciPayout.aggregate([
      { $match: { $or: [{ status: { $nin: [...PAYOUT_VIEWS.done] } }, { updatedAt: { $gte: since30 } }] } },
      { $group: { _id: "$status", count: { $sum: 1 }, amount: { $sum: "$amount" } } },
    ]),
    IciciPayout.aggregate([
      { $match: { status: "SUCCESS", "bank.completedAt": { $gte: startOfDay } } },
      { $group: { _id: null, count: { $sum: 1 }, amount: { $sum: "$amount" } } },
    ]),
  ]);

  const get = (statuses) =>
    byStatus
      .filter((r) => statuses.includes(r._id))
      .reduce((acc, r) => ({ count: acc.count + r.count, amount: acc.amount + r.amount }), {
        count: 0,
        amount: 0,
      });

  return {
    awaitingApproval: get(PAYOUT_VIEWS.approval),
    withBank: get(PAYOUT_VIEWS.bank),
    awaitingBankApproval: get(["AWAITING_BANK_APPROVAL"]),
    needsAttention: get(["UNKNOWN"]),
    paidToday: paidToday[0] ? { count: paidToday[0].count, amount: paidToday[0].amount } : { count: 0, amount: 0 },
    failed30d: get(["FAILED", "REVERSED"]),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Cron: re-check every payout that is with the bank. Sequential and spaced out,
 * because ICICI allows 1–2 requests per second per account.
 */
export async function pollOpenPayouts({ gapMs = 700 } = {}) {
  const cfg = getIciciCorporateConfig();

  const staleCutoff = new Date(Date.now() - SUBMITTING_STALE_MS);
  const stuck = await IciciPayout.find({ status: "SUBMITTING", updatedAt: { $lt: staleCutoff } });
  for (const doc of stuck) {
    pushHistory(doc, {
      action: "BANK_STATUS",
      from: "SUBMITTING",
      to: "UNKNOWN",
      note: "No bank answer was recorded for this submission; checking status",
    });
    doc.status = "UNKNOWN";
    await doc.save();
  }

  const due = new Date(Date.now() - cfg.payout.minCheckIntervalMs);
  const open = await IciciPayout.find({
    status: { $in: POLLABLE },
    $or: [{ "bank.lastCheckedAt": null }, { "bank.lastCheckedAt": { $lt: due } }],
  })
    .select("_id")
    .limit(50)
    .lean();

  let changed = 0;
  for (const { _id } of open) {
    const before = await IciciPayout.findById(_id).select("status").lean();
    const res = await refreshPayoutStatus(_id);
    if (res.payout.status !== before?.status) changed += 1;
    if (gapMs) await sleep(gapMs);
  }
  return { checked: open.length, changed, recoveredStuck: stuck.length };
}

export { PayoutError };
