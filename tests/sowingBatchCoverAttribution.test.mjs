import assert from "node:assert/strict";
import {
  attributedCoverPlants,
  plantsFromOrderForRequest,
  coverStampDrift,
} from "../utility/sowingBatchCoverAttribution.js";

const rid = "req-1";

{
  const o = {
    _id: "o1",
    numberOfPlants: 18000,
    sowingDoneRequestId: rid,
    sowingCoverSources: [],
  };
  assert.equal(plantsFromOrderForRequest(o, { requestId: rid }), 18000);
}

{
  const o = {
    _id: "o2",
    numberOfPlants: 8000,
    sowingCoverSources: [{ sowingRequestId: rid, requestNumber: "SR1", plants: 7244 }],
  };
  assert.equal(plantsFromOrderForRequest(o, { requestId: rid, requestNumber: "SR1" }), 7244);
}

{
  const batch = {
    orderCoveredPlants: 54775,
    excessAllocations: [{ orderId: "o2", plants: 7244 }],
    linkedOrderIds: ["o1", "o2"],
  };
  const orders = [
    { _id: "o1", numberOfPlants: 18000, sowingDoneRequestId: rid },
    {
      _id: "o2",
      numberOfPlants: 8000,
      sowingCoverSources: [{ sowingRequestId: rid, plants: 7244 }],
    },
  ];
  const attr = attributedCoverPlants({
    requestId: rid,
    requestNumber: "SR1",
    batch,
    orders,
  });
  assert.equal(attr, 25244);
  const drift = coverStampDrift(batch, attr);
  assert.equal(drift.delta, 54775 - 25244);
}

console.log("sowingBatchCoverAttribution.test.mjs ok");
