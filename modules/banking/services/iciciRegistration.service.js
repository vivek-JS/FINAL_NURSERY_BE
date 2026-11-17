import crypto from "crypto";
import { iciciCorporateRequest } from "./iciciHttpClient.js";
import { getIciciCorporateConfig, assertCorporateConfig } from "../config/iciciCorporate.config.js";
import IciciRegistration from "../models/iciciRegistration.model.js";
import { getBankingLogger } from "../utils/logger.js";

const log = () => getBankingLogger();

/**
 * STEP 1 — Corporate API Registration
 * POST /api/Corporate/CIB/v1/Registration
 *
 * Registers your RSA public certificate with ICICI. Run once per cert rotation.
 */
export async function registerWithIcici({ publicCertPem, userId } = {}) {
  const cfg = getIciciCorporateConfig();

  if (cfg.useStub) {
    const stub = {
      status: "SUCCESS",
      registrationId: `STUB-REG-${Date.now()}`,
      message: "Stub registration — set ICICI_CORPORATE_USE_STUB=false for live",
      registeredAt: new Date().toISOString(),
    };
    await IciciRegistration.create({
      registrationId: stub.registrationId,
      status: "ACTIVE",
      environment: cfg.envType,
      publicCertFingerprint: "stub",
      response: stub,
    });
    return stub;
  }

  assertCorporateConfig(true);

  const fs = await import("fs");
  const pem =
    publicCertPem ||
    (cfg.keys.publicCertPath && fs.existsSync(cfg.keys.publicCertPath)
      ? fs.readFileSync(cfg.keys.publicCertPath, "utf8")
      : null);

  if (!pem) {
    const err = new Error("Public certificate PEM required for registration");
    err.code = "ICICI_REGISTRATION_NO_CERT";
    throw err;
  }

  const fingerprint = crypto.createHash("sha256").update(pem).digest("hex").slice(0, 32);

  const payload = {
    AGGR_ID: cfg.aggregatorId,
    CORPID: cfg.corpId,
    USERID: cfg.userId,
    PUBLIC_KEY: pem.replace(/\r\n/g, "\n").trim(),
    ALIAS: process.env.ICICI_CERT_ALIAS || "ERP_PRIMARY",
  };

  const response = await iciciCorporateRequest({
    endpointPath: cfg.endpoints.registration,
    payload,
    idempotencyKey: `reg-${fingerprint}`,
    userId,
  });

  const registrationId =
    response?.registrationId ||
    response?.REG_ID ||
    response?.requestId ||
    `REG-${Date.now()}`;

  await IciciRegistration.findOneAndUpdate(
    { publicCertFingerprint: fingerprint },
    {
      registrationId,
      status: "ACTIVE",
      environment: cfg.envType,
      publicCertFingerprint: fingerprint,
      registeredAt: new Date(),
      response,
    },
    { upsert: true, new: true }
  );

  log().info("ICICI registration completed", { registrationId, fingerprint });
  return { registrationId, fingerprint, response };
}

export async function getLatestRegistration() {
  return IciciRegistration.findOne({ status: "ACTIVE" })
    .sort({ registeredAt: -1 })
    .lean();
}

function field(obj, ...keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (v != null && v !== "") return String(v).trim();
  }
  return "";
}

/** Normalise a Registration Status / Deregistration reply. */
export function mapRegistrationReply(raw) {
  const response = field(raw, "Response", "RESPONSE", "response").toUpperCase();
  const bankStatus = field(raw, "Status", "STATUS", "status");
  const code = field(raw, "ResponseCode", "RESPONSECODE", "ErrorCode", "errorCode");
  const message = field(raw, "Message", "MESSAGE", "message");
  const s = bankStatus.toUpperCase();
  const state =
    response === "FAILURE" && !s
      ? "FAILURE"
      : s.startsWith("REGISTERED")
        ? "REGISTERED"
        : s.startsWith("DEREGISTER") || s.startsWith("DE-REGISTER")
          ? "DEREGISTERED"
          : s.startsWith("PENDING")
            ? "PENDING_SELF_APPROVAL"
            : s.startsWith("REJECT")
              ? "REJECTED"
              : response === "FAILURE"
                ? "FAILURE"
                : s || "UNKNOWN";
  return { state, bankStatus, response, code, message, raw };
}

/**
 * Registration Status Inquiry API — AGGRID, CORPID, USERID, URN (+AGGRNAME).
 * Status: Registered / Rejected / Pending for Self Approval / Deregistered.
 */
async function callOrStub(endpointKey, stubReply, { userId, idempotencyKey } = {}) {
  const cfg = getIciciCorporateConfig();
  if (cfg.useStub) return { cfg, raw: stubReply };
  assertCorporateConfig();
  const raw = await iciciCorporateRequest({
    endpointPath: cfg.endpoints[endpointKey],
    payload: {},
    idempotencyKey,
    userId,
  });
  return { cfg, raw };
}

export async function fetchRegistrationStatus({ userId } = {}) {
  const { raw } = await callOrStub(
    "registrationStatus",
    { Status: "Registered", Response: "SUCCESS", ResponseCode: "0" },
    { userId }
  );

  const result = mapRegistrationReply(raw);
  await IciciRegistration.updateMany(
    { status: "ACTIVE" },
    {
      $set: {
        bankStatus: result.bankStatus || result.state,
        bankStatusCheckedAt: new Date(),
        ...(result.state === "DEREGISTERED" ? { status: "REVOKED" } : {}),
      },
    }
  );
  log().info("ICICI registration status", { state: result.state, code: result.code });
  return result;
}

/**
 * CIB De-registration API — revokes the partner link for this CORPID/USERID/URN.
 * After this every CIB call fails until the user registers again.
 */
export async function deregisterFromIcici({ userId } = {}) {
  const { raw } = await callOrStub(
    "deregistration",
    { Status: "Deregistered", Response: "SUCCESS", ResponseCode: "0" },
    { userId, idempotencyKey: `dereg-${Date.now()}` }
  );

  const result = mapRegistrationReply(raw);
  const ok = result.response === "SUCCESS" || result.state === "DEREGISTERED";
  if (ok) {
    const now = new Date();
    await IciciRegistration.updateMany(
      { status: "ACTIVE" },
      { $set: { status: "REVOKED", bankStatus: "Deregistered", bankStatusCheckedAt: now, deregisteredAt: now } }
    );
  }
  log().info("ICICI deregistration", { ok, state: result.state, code: result.code });
  return { ok, ...result };
}
