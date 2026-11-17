/**
 * ICICI CIB Beneficiary Validation API (POST /BeneValidation).
 *
 * Sign-off packet (failure rows name these fields):
 *   CORPID, USERID, AGGRID, URN, BENEACCNO
 * IFSC is sent when we have it. Identity is not merged on top — extras are
 * answered 8017 "Invalid request".
 *
 * Replies the ERP understands:
 *   SUCCESS / VALIDATED          account is a valid payee
 *   9906                         invalid AGGRID / URN
 *   106803                       invalid CORPID / USERID
 *   invalid account messages     INVALID_ACCOUNT
 *   8017                         BAD_REQUEST (ICICI schema mismatch)
 */

import IciciBeneficiary from "../models/iciciBeneficiary.model.js";
import { iciciCorporateRequest } from "./iciciHttpClient.js";
import { getIciciCorporateConfig, assertCorporateConfig } from "../config/iciciCorporate.config.js";
import { PayoutError, pushHistory } from "./iciciPayout.service.js";
import { getBankingLogger } from "../utils/logger.js";

const log = () => getBankingLogger();

const INVALID_LOGIN = "106803";
const NOT_REGISTERED = "9906";

function field(obj, ...keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (v != null && v !== "") return String(v).trim();
  }
  return "";
}

export function buildBeneValidationPayload(bene, cfg) {
  return {
    CORPID: cfg.corpId,
    USERID: cfg.userId,
    AGGRID: cfg.aggregatorId,
    URN: cfg.urn,
    BENEACCNO: String(bene.accountNumber || bene.BENEACCNO || "").trim(),
    ...(bene.ifsc || bene.IFSC
      ? { IFSC: String(bene.ifsc || bene.IFSC).trim().toUpperCase() }
      : {}),
  };
}

/** Normalise a /BeneValidation reply. */
export function mapBeneValidationReply(raw) {
  if (raw?.response === 8017 || raw?.response === "8017") {
    return { state: "BAD_REQUEST", code: "8017", message: raw.errormessage || "Invalid request", name: "" };
  }
  const response = field(raw, "RESPONSE", "Response", "response").toUpperCase();
  const status = field(raw, "STATUS", "Status").toUpperCase();
  const code = field(raw, "ERRORCODE", "ErrorCode", "RESPONSECODE", "ResponseCode");
  const message = field(raw, "MESSAGE", "Message", "message", "errormessage");
  const name = field(raw, "BENENAME", "BENEACCNAME", "BnfName", "PAYEENAME");

  let state = "FAILED";
  if (code === INVALID_LOGIN) state = "INVALID_LOGIN";
  else if (code === NOT_REGISTERED) state = "NOT_REGISTERED";
  else if (/invalid.*(account|acc\b|bene)/i.test(message) || /account.*(invalid|not found|does not)/i.test(message)) {
    state = "INVALID_ACCOUNT";
  } else if (
    response === "SUCCESS" ||
    status === "SUCCESS" ||
    /validat/i.test(message) ||
    /valid payee|beneficiary valid/i.test(message)
  ) {
    state = "VALIDATED";
  }

  return { state, code, message, name, raw };
}

function stubReply(bene) {
  const acc = String(bene.accountNumber || "");
  if (!acc || acc === "000000000000") {
    return { STATUS: "FAILURE", RESPONSE: "FAILURE", MESSAGE: "Invalid Beneficiary Account No.", ERRORCODE: "100019" };
  }
  if (String(bene.ifsc || "") && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(String(bene.ifsc).toUpperCase())) {
    return { STATUS: "FAILURE", RESPONSE: "FAILURE", MESSAGE: "Incorrect IFSC entered.", ERRORCODE: "101436" };
  }
  return { STATUS: "SUCCESS", RESPONSE: "SUCCESS", MESSAGE: "Beneficiary Validated", BENENAME: bene.name || "" };
}

/** Call /BeneValidation for one account. */
export async function validateBeneficiaryAtIcici(bene, { userId } = {}) {
  const acc = String(bene.accountNumber || bene.BENEACCNO || "").trim();
  if (!acc) throw new PayoutError("Account number is required", "VALIDATION", { errors: { accountNumber: "Required" } });

  const cfg = getIciciCorporateConfig();
  if (cfg.useStub) return { ...mapBeneValidationReply(stubReply({ ...bene, accountNumber: acc })), stub: true };

  assertCorporateConfig();
  const raw = await iciciCorporateRequest({
    endpointPath: cfg.endpoints.beneValidation,
    payload: buildBeneValidationPayload({ ...bene, accountNumber: acc }, cfg),
    omitIdentity: true,
    userId,
  });
  return mapBeneValidationReply(raw);
}

/** Validate an approved/pending payee and store ICICI's answer on it. */
export async function validateBeneficiaryAtBank(id, user = null) {
  const doc = await IciciBeneficiary.findById(id);
  if (!doc) throw new PayoutError("Payee not found", "NOT_FOUND");

  let mapped;
  try {
    mapped = await validateBeneficiaryAtIcici(doc, { userId: user?._id });
  } catch (err) {
    if (err instanceof PayoutError) throw err;
    mapped = { state: "UNREACHABLE", code: err.code || "", message: err.message, name: "" };
  }

  const now = new Date();
  doc.bank = doc.bank || {};
  doc.bank.validationState = mapped.state;
  doc.bank.validationMessage = mapped.message;
  doc.bank.validatedAt = now;
  if (mapped.name && !doc.bank.nickname) doc.bank.nickname = mapped.name;
  pushHistory(doc, {
    action: mapped.state === "VALIDATED" ? "BANK_VALIDATED" : "BANK_VALIDATION_FAILED",
    from: doc.status,
    to: doc.status,
    user,
    note: [mapped.state, mapped.message].filter(Boolean).join(" — "),
  });
  await doc.save();
  log().info("ICICI beneficiary validation", { payeeId: String(doc._id), state: mapped.state, code: mapped.code });
  return { payee: doc.toObject(), validated: mapped.state === "VALIDATED", bank: mapped };
}
