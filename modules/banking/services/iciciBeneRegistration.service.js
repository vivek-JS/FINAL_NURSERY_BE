/**
 * ICICI CIB Beneficiary Registration API (POST /BeneAddition).
 *
 * Packet, as accepted by the CIB_SV sandbox (every field mandatory; a missing
 * one is answered 8017 "Invalid request"):
 *   CrpId, CrpUsr, AGGR_ID, URN, BnfName, BnfNickName, BnfAccNo,
 *   PayeeType ("W" = ICICI Bank, "O" = other bank), IFSC
 *
 * Replies seen in UAT (all with STATUS/RESPONSE "FAILURE"):
 *   "Fund transfer to the newly added payee will not be allowed immediately…"
 *             payee added; ERRORCODE differs per payee (ICICI's id for it) and
 *             payments to it are blocked for the cooling period
 *   995609    account already registered ("Counterparty already exists with bene ID n")
 *   101436    incorrect IFSC
 *   106803    invalid CORPID / USERID
 *   9906      invalid AGGRID
 */

import IciciBeneficiary from "../models/iciciBeneficiary.model.js";
import { iciciCorporateRequest } from "./iciciHttpClient.js";
import { getIciciCorporateConfig, assertCorporateConfig } from "../config/iciciCorporate.config.js";
import { PayoutError, pushHistory } from "./iciciPayout.service.js";
import { getBankingLogger } from "../utils/logger.js";

const log = () => getBankingLogger();

const ADDED_RE = /newly added payee/i;
const ALREADY_EXISTS_CODE = "995609";
const FAILURE_BY_CODE = {
  "101436": "INVALID_IFSC",
  "106803": "INVALID_LOGIN",
  "9906": "NOT_REGISTERED",
};
/** States after which ICICI holds the payee. */
export const BANK_REGISTERED_STATES = new Set(["REGISTERED", "ALREADY_EXISTS"]);
const NICK_MAX = 20;

function field(obj, ...keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (v != null && v !== "") return String(v).trim();
  }
  return "";
}

/** ICICI wants a unique nickname per payee: letters and digits only. */
export function beneNickname(bene) {
  const base = String(bene.nickname || bene.name || "PAYEE").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const tail = String(bene.accountNumber || "").slice(-4);
  return `${base.slice(0, NICK_MAX - tail.length)}${tail}` || `PAYEE${tail}`;
}

export function buildBeneAdditionPayload(bene, cfg) {
  return {
    CrpId: cfg.corpId,
    CrpUsr: cfg.userId,
    AGGR_ID: cfg.aggregatorId,
    URN: cfg.urn,
    BnfName: String(bene.name || "").trim(),
    BnfNickName: beneNickname(bene),
    BnfAccNo: String(bene.accountNumber || "").trim(),
    PayeeType: bene.bankKind === "ICICI" ? "W" : "O",
    IFSC: String(bene.ifsc || "").trim().toUpperCase(),
  };
}

/** Normalise a /BeneAddition reply into { state, code, message, beneId }. */
export function mapBeneAdditionReply(raw) {
  if (raw?.response === 8017 || raw?.response === "8017") {
    return { state: "BAD_REQUEST", code: "8017", message: raw.errormessage || "Invalid request", beneId: "" };
  }
  const response = field(raw, "RESPONSE", "Response", "response").toUpperCase();
  const status = field(raw, "STATUS", "Status").toUpperCase();
  const code = field(raw, "ERRORCODE", "ErrorCode", "RESPONSECODE");
  const message = field(raw, "MESSAGE", "Message", "message");
  const added = ADDED_RE.test(message);
  const beneId =
    field(raw, "BNF_ID", "BeneId", "BENEID") ||
    message.match(/bene ID (\d+)/i)?.[1] ||
    (added ? code : "");

  let state;
  if (added) state = "REGISTERED";
  else if (code === ALREADY_EXISTS_CODE) state = "ALREADY_EXISTS";
  else if (response === "SUCCESS" && status !== "FAILURE") state = "REGISTERED";
  else state = FAILURE_BY_CODE[code] || "FAILED";

  return { state, code: added ? "" : code, message, beneId, coolingPeriod: added };
}

function stubReply(bene) {
  if (!String(bene.ifsc || "").match(/^[A-Z]{4}0[A-Z0-9]{6}$/)) {
    return { MESSAGE: "Incorrect IFSC entered.", ERRORCODE: "101436", STATUS: "FAILURE", RESPONSE: "FAILURE" };
  }
  return {
    MESSAGE: "Fund transfer to the newly added payee will not be allowed immediately.",
    ERRORCODE: String(Math.floor(10000000 + Math.random() * 89999999)),
    STATUS: "FAILURE",
    RESPONSE: "FAILURE",
  };
}

/** Call /BeneAddition for one payee and return the mapped reply. */
export async function addBeneficiaryAtIcici(bene, { userId } = {}) {
  const cfg = getIciciCorporateConfig();
  if (cfg.useStub) return { ...mapBeneAdditionReply(stubReply(bene)), stub: true };
  assertCorporateConfig();
  const raw = await iciciCorporateRequest({
    endpointPath: cfg.endpoints.beneAddition,
    payload: buildBeneAdditionPayload(bene, cfg),
    userId,
  });
  return mapBeneAdditionReply(raw);
}

/**
 * Register an approved payee at ICICI and record the answer on it. A bank
 * refusal never undoes the ERP approval; it is shown on the payee for retry.
 */
export async function registerBeneficiaryAtBank(id, user = null) {
  const doc = await IciciBeneficiary.findById(id);
  if (!doc) throw new PayoutError("Payee not found", "NOT_FOUND");
  if (doc.status !== "ACTIVE") throw new PayoutError("Only an approved payee can be registered at ICICI", "BAD_STATE");
  if (BANK_REGISTERED_STATES.has(doc.bank?.state)) return { payee: doc.toObject(), registered: true, already: true };

  let mapped;
  try {
    mapped = await addBeneficiaryAtIcici(doc, { userId: user?._id });
  } catch (err) {
    mapped = { state: "UNREACHABLE", code: err.code || "", message: err.message, beneId: "" };
  }

  const now = new Date();
  const registered = BANK_REGISTERED_STATES.has(mapped.state);
  doc.bank = {
    state: mapped.state,
    beneId: mapped.beneId || doc.bank?.beneId || "",
    nickname: beneNickname(doc),
    code: mapped.code,
    message: mapped.message,
    coolingPeriod: Boolean(mapped.coolingPeriod),
    registeredAt: registered ? doc.bank?.registeredAt || now : doc.bank?.registeredAt,
    checkedAt: now,
    attempts: (doc.bank?.attempts || 0) + 1,
  };
  pushHistory(doc, {
    action: registered ? "BANK_REGISTERED" : "BANK_REGISTRATION_FAILED",
    from: doc.status,
    to: doc.status,
    user,
    note: [mapped.state, mapped.message].filter(Boolean).join(" — "),
  });
  await doc.save();
  log().info("ICICI beneficiary registration", { payeeId: String(doc._id), state: mapped.state, code: mapped.code });
  return { payee: doc.toObject(), registered, bank: doc.bank };
}
