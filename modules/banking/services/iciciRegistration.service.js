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
