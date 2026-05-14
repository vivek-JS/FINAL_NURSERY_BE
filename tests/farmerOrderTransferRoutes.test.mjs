import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("farmer order transfer routes", () => {
  it("registers create/list/approve/reject transfer request endpoints", () => {
    const routeSource = readFileSync(
      resolve(process.cwd(), "routes/order.route.js"),
      "utf8"
    );
    assert.match(
      routeSource,
      /\/farmer-plant-ledger\/transfer-requests\",\s*createFarmerOrderTransferRequest/
    );
    assert.match(
      routeSource,
      /\/farmer-plant-ledger\/transfer-requests\",\s*requirePaymentAccess,\s*getFarmerOrderTransferRequests/
    );
    assert.match(
      routeSource,
      /\/farmer-plant-ledger\/transfer-requests\/:id\/approve\",\s*requirePaymentAccess,\s*approveFarmerOrderTransferRequest/
    );
    assert.match(
      routeSource,
      /\/farmer-plant-ledger\/transfer-requests\/:id\/reject\",\s*requirePaymentAccess,\s*rejectFarmerOrderTransferRequest/
    );
  });
});
