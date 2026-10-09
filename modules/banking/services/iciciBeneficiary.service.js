/**
 * Payee register for payouts, with the same maker-checker rule as payments:
 * one person adds a payee, a different approver activates it.
 *
 * The CIB payment API in our spec is ad hoc ("without any bene registration"),
 * so ICICI keeps no beneficiary list for us. The register gives the same
 * protections in the ERP: account details are checked and approved once, a
 * duplicate account cannot be added twice, and with
 * ICICI_PAYOUT_REQUIRE_BENEFICIARY=true payouts may only go to approved payees.
 */

import IciciBeneficiary, { PAYEE_TYPES } from "../models/iciciBeneficiary.model.js";
import { getIciciCorporateConfig } from "../config/iciciCorporate.config.js";
import {
  PayoutError,
  ACCOUNT_RE,
  IFSC_RE,
  NAME_RE,
  PAYEE_NAME_MAX,
  escapeRegex,
  isPayoutChecker,
  pushHistory,
  userName,
} from "./iciciPayout.service.js";

const MOBILE_RE = /^[6-9]\d{9}$/;
const NICKNAME_MAX = 40;

const dedupeKeyOf = (accountNumber, ifsc) => `${accountNumber}|${ifsc}`;

/** ICICI branch IFSCs all start with ICIC. */
export function bankKindOf(ifsc) {
  return String(ifsc || "").toUpperCase().startsWith("ICIC") ? "ICICI" : "NON_ICICI";
}

/**
 * Check a payee the way ICICI will judge the payment to it.
 *
 * @returns {{ ok: boolean, errors: Record<string,string>, value?: object }}
 */
export function validateBeneficiaryInput(input = {}, { debitAccount } = {}) {
  const errors = {};
  const name = String(input.name ?? input.payeeName ?? "").trim().replace(/\s+/g, " ");
  const accountNumber = String(input.accountNumber || "").replace(/\s+/g, "").toUpperCase();
  const confirm = input.confirmAccountNumber;
  const ifsc = String(input.ifsc || "").trim().toUpperCase();
  const type = String(input.type ?? input.payeeType ?? "VENDOR").toUpperCase();
  const nickname = String(input.nickname || "").trim();
  const mobile = String(input.mobile || "").replace(/\D/g, "").replace(/^91(?=\d{10}$)/, "");
  const bankName = String(input.bankName || "").trim();
  const declaredKind = input.bankKind ? String(input.bankKind).toUpperCase() : "";
  const debit = String(debitAccount || "").replace(/\s+/g, "").toUpperCase();

  if (!name) errors.name = "Payee name is required";
  else if (name.length > PAYEE_NAME_MAX) errors.name = `At most ${PAYEE_NAME_MAX} characters`;
  else if (!NAME_RE.test(name)) errors.name = "Letters, numbers and spaces only";

  if (!accountNumber) errors.accountNumber = "Account number is required";
  else if (!ACCOUNT_RE.test(accountNumber)) errors.accountNumber = "6 to 34 letters or digits, no symbols";
  else if (debit && accountNumber === debit) errors.accountNumber = "This is our own debit account";
  if (confirm != null && String(confirm).replace(/\s+/g, "").toUpperCase() !== accountNumber) {
    errors.confirmAccountNumber = "Account numbers do not match";
  }

  if (!ifsc) errors.ifsc = "IFSC is required";
  else if (!IFSC_RE.test(ifsc)) errors.ifsc = "IFSC looks wrong (e.g. HDFC0001234)";

  const bankKind = bankKindOf(ifsc);
  if (declaredKind && !errors.ifsc && declaredKind !== bankKind) {
    errors.ifsc =
      declaredKind === "ICICI"
        ? "An ICICI Bank account has an IFSC starting with ICIC"
        : "This IFSC belongs to ICICI Bank — choose ICICI Bank";
  }

  if (!PAYEE_TYPES.includes(type)) errors.type = "Unknown payee type";
  if (nickname.length > NICKNAME_MAX) errors.nickname = `At most ${NICKNAME_MAX} characters`;
  if (mobile && !MOBILE_RE.test(mobile)) errors.mobile = "10-digit Indian mobile number";

  const ok = Object.keys(errors).length === 0;
  return {
    ok,
    errors,
    value: ok
      ? {
          name,
          nickname,
          accountNumber,
          ifsc,
          bankName: bankName || (bankKind === "ICICI" ? "ICICI Bank" : ""),
          bankKind,
          type,
          mobile,
        }
      : undefined,
  };
}

function duplicateError(existing) {
  return new PayoutError(
    `${existing.name} is already registered with this account and IFSC (${existing.status === "ACTIVE" ? "approved" : "awaiting approval"})`,
    "DUPLICATE_BENEFICIARY",
    {
      errors: { accountNumber: "Already registered" },
      existing: { _id: existing._id, name: existing.name, status: existing.status },
    }
  );
}

async function loadOrThrow(id) {
  const doc = await IciciBeneficiary.findById(id);
  if (!doc) throw new PayoutError("Payee not found", "NOT_FOUND");
  return doc;
}

/** Maker: add a payee awaiting approval. */
export async function createBeneficiary(input, user) {
  const cfg = getIciciCorporateConfig();
  const check = validateBeneficiaryInput(input, { debitAccount: cfg.accountNumber });
  if (!check.ok) {
    throw new PayoutError("Please fix the highlighted fields", "VALIDATION", { errors: check.errors });
  }
  const v = check.value;
  const dedupeKey = dedupeKeyOf(v.accountNumber, v.ifsc);

  const existing = await IciciBeneficiary.findOne({ dedupeKey }).lean();
  if (existing) throw duplicateError(existing);

  const doc = new IciciBeneficiary({
    ...v,
    dedupeKey,
    status: "PENDING_APPROVAL",
    makerId: user._id,
    makerName: userName(user),
  });
  pushHistory(doc, { action: "CREATED", to: "PENDING_APPROVAL", user });
  try {
    await doc.save();
  } catch (err) {
    if (err?.code !== 11000) throw err;
    throw duplicateError(await IciciBeneficiary.findOne({ dedupeKey }).lean());
  }
  return doc.toObject();
}

async function decide(id, user, { from, to, action, extra = {}, note, unsetKey = false }) {
  const now = new Date();
  const doc = await IciciBeneficiary.findOneAndUpdate(
    { _id: id, status: from },
    {
      $set: { status: to, ...extra },
      ...(unsetKey ? { $unset: { dedupeKey: 1 } } : {}),
      $push: {
        history: { at: now, action, fromStatus: from, toStatus: to, by: user._id, byName: userName(user), note },
      },
    },
    { new: true }
  ).lean();
  if (!doc) {
    const current = await loadOrThrow(id);
    throw new PayoutError(`Payee is ${current.status.toLowerCase().replace(/_/g, " ")}`, "BAD_STATE");
  }
  return doc;
}

/** Checker: approve a payee so payouts can use it. */
export async function approveBeneficiary(id, user, { note } = {}) {
  if (!isPayoutChecker(user)) throw new PayoutError("Only an approver can approve payees", "FORBIDDEN");
  const current = await loadOrThrow(id);
  if (String(current.makerId) === String(user._id)) {
    throw new PayoutError("You added this payee — another approver must approve it", "SELF_APPROVAL");
  }
  return decide(id, user, {
    from: "PENDING_APPROVAL",
    to: "ACTIVE",
    action: "APPROVED",
    note: String(note || "").trim() || undefined,
    extra: { checkerId: user._id, checkerName: userName(user), checkedAt: new Date() },
  });
}

/** Checker: reject a new payee. */
export async function rejectBeneficiary(id, user, { reason } = {}) {
  if (!isPayoutChecker(user)) throw new PayoutError("Only an approver can reject payees", "FORBIDDEN");
  const text = String(reason || "").trim();
  if (!text) throw new PayoutError("Give a reason for rejecting", "VALIDATION", { errors: { reason: "Required" } });
  return decide(id, user, {
    from: "PENDING_APPROVAL",
    to: "REJECTED",
    action: "REJECTED",
    note: text,
    unsetKey: true,
    extra: { checkerId: user._id, checkerName: userName(user), checkedAt: new Date(), rejectReason: text },
  });
}

/** Checker: stop further payouts to an approved payee. Existing payouts are not touched. */
export async function disableBeneficiary(id, user, { reason } = {}) {
  if (!isPayoutChecker(user)) throw new PayoutError("Only an approver can disable payees", "FORBIDDEN");
  return decide(id, user, {
    from: "ACTIVE",
    to: "DISABLED",
    action: "DISABLED",
    note: String(reason || "").trim() || undefined,
    unsetKey: true,
  });
}

export async function listBeneficiaries({ status = "", search = "", limit = 100, skip = 0 } = {}) {
  const filter = {};
  const statuses = String(status || "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  if (statuses.length) filter.status = { $in: statuses };
  const q = String(search || "").trim();
  if (q) {
    const re = new RegExp(escapeRegex(q), "i");
    filter.$or = [{ name: re }, { nickname: re }, { accountNumber: re }, { ifsc: re }, { bankName: re }];
  }
  const pageSize = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const offset = Math.max(Number(skip) || 0, 0);
  const [items, total] = await Promise.all([
    IciciBeneficiary.find(filter).sort({ status: 1, name: 1 }).skip(offset).limit(pageSize).lean(),
    IciciBeneficiary.countDocuments(filter),
  ]);
  return { items, total, limit: pageSize, skip: offset, hasMore: offset + items.length < total };
}

export async function beneficiaryCounts() {
  const rows = await IciciBeneficiary.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]);
  return Object.fromEntries(rows.map((r) => [r._id, r.count]));
}
