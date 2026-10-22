import test from "node:test";
import assert from "node:assert/strict";
import { baseOrderLinks } from "../services/sowDispatchOrderLinks.js";

const OID = {
  s15: "650000000000000000000015",
  s17: "650000000000000000000017",
  b15: "650000000000000000000115",
  b17: "650000000000000000000117",
  r15: "650000000000000000000215",
  order: "650000000000000000000a02",
};

function batchIndex() {
  return new Map([
    [
      OID.b15,
      {
        slotId: OID.s15,
        batch: {
          _id: OID.b15,
          sowingRequestId: OID.r15,
          linkedOrderIds: [],
        },
      },
    ],
    [
      OID.b17,
      {
        slotId: OID.s17,
        batch: {
          _id: OID.b17,
          sowingRequestId: "650000000000000000000217",
          linkedOrderIds: [OID.order],
        },
      },
    ],
  ]);
}

test("partly sown order completed from excess keeps both batch links", () => {
  const order = {
    _id: OID.order,
    numberOfPlants: 1000,
    sowingDone: true,
    sowingPartialCover: [{ requestId: OID.r15, plants: 700 }],
    sowingCoverSources: [{ slotId: OID.s17, batchId: OID.b17, plants: 300 }],
  };

  assert.deepEqual(baseOrderLinks(order, batchIndex()), [
    { slotId: OID.s15, batchId: OID.b15, plants: 700 },
    { slotId: OID.s17, batchId: OID.b17, plants: 300 },
  ]);
});
