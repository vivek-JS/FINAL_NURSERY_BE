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

  it("payment status transfer delegation receives Express next", () => {
    const controllerSource = readFileSync(
      resolve(process.cwd(), "controllers/order.controller.js"),
      "utf8"
    );
    assert.match(
      controllerSource,
      /const\s+updatePaymentStatus\s*=\s*async\s*\(\s*req\s*,\s*res\s*,\s*next\s*\)/
    );
    assert.match(
      controllerSource,
      /approveFarmerOrderTransferRequest\(req,\s*res,\s*next\)/
    );
    assert.match(
      controllerSource,
      /rejectFarmerOrderTransferRequest\(req,\s*res,\s*next\)/
    );
  });
});
