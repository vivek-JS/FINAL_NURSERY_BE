import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

function fileIncludes(relPath, needles) {
  const text = readFileSync(join(root, relPath), "utf8");
  const missing = needles.filter((n) => !text.includes(n));
  return { ok: missing.length === 0, missing };
}

/** Static wiring audit — shadow hooks must exist at domain write sites */
describe("Central ledger shadow integration (static)", () => {
  const sites = [
    {
      file: "utils/farmerPlantOrderLedgerHelper.js",
      hooks: ["shadowFarmerOrderCreated", "shadowFarmerPayment", "shadowFarmerOrderDelta"],
    },
    {
      file: "utils/ramAgriLedgerHelper.js",
      hooks: ["shadowAgriFromLedgerRow"],
    },
    {
      file: "utils/dealerLedgerHelper.js",
      hooks: ["shadowDealerOrderBooking", "shadowDealerReceivablePayment"],
    },
    {
      file: "models/dealerWallet.js",
      hooks: ["shadowDealerWalletMovement"],
    },
    {
      file: "controllers/commission.controller.js",
      hooks: ["shadowDealerCommissionSettlement"],
    },
    {
      file: "services/reconciliation.service.js",
      hooks: ["shadowBankPaymentVerified"],
    },
    {
      file: "controllers/farmerPlantOrderLedger.controller.js",
      hooks: [
        "shadowFarmerAdvanceTransfer",
        "shadowFarmerManualAdjustment",
        "shadowFarmerPaymentTransfer",
      ],
    },
    { file: "app.js", hooks: ["/api/v1/finance", "financeRoute"] },
  ];

  for (const { file, hooks } of sites) {
    it(file, () => {
      const { ok, missing } = fileIncludes(file, hooks);
      assert.ok(ok, `Missing hooks in ${file}: ${missing.join(", ")}`);
    });
  }

  it("factory/order paths use farmer helper (indirect shadow)", () => {
    const factory = readFileSync(join(root, "controllers/factory.controller.js"), "utf8");
    assert.ok(factory.includes("ensureFarmerPlantOrderDebit"));
    assert.ok(factory.includes("syncFarmerPlantLedgerForOrderUpdate"));
  });

  it("bulk payment uses farmer ledger helper (indirect shadow)", () => {
    const bulk = readFileSync(join(root, "controllers/bulkPayment.controller.js"), "utf8");
    assert.ok(bulk.includes("recordFarmerPlantLedgerPaymentTransition"));
  });
});
