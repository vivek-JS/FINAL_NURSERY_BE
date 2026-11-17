import test from "node:test";
import assert from "node:assert/strict";
import {
  attributedOrderPlants,
  dispatchedOrdersForEntry,
  linkedOrdersForEntry,
} from "../modules/sowingEntries/linkedOrdersForEntry.js";

const entry = {
  sourceBatchId: "batch-17",
  sowingRequestId: "req-17",
  requestNumber: "SR202610260017",
  plantReadyDate: "13-11-2026",
  linkedOrderIds: ["order-4313"],
};

test("dispatched orders are the dispatch record, separate from the cover link", () => {
  const cards = dispatchedOrdersForEntry(
    {
      linkedOrderIds: ["order-4313"],
      dispatchedOrders: [{ orderId: "order-4602", plants: 600 }],
    },
    [
      {
        _id: "order-4602",
        orderId: 4602,
        farmer: { name: "Ram" },
        numberOfPlants: 1200,
        deliveryDate: "2026-11-07T00:00:00.000Z",
      },
    ]
  );
  assert.equal(cards.length, 1);
  assert.equal(cards[0].orderNumber, 4602);
  assert.equal(cards[0].farmerName, "Ram");
  assert.equal(cards[0].plants, 600);
});

test("cover plants come from this entry's order link, other sowings stay on Also", () => {
  const [card] = linkedOrdersForEntry(entry, [
    {
      _id: "order-4313",
      orderId: 4313,
      farmer: { name: "Ramesh" },
      numberOfPlants: 40000,
      deliveryDate: "2026-11-13T00:00:00.000Z",
      orderStatus: "ACCEPTED",
      sowingDone: true,
      sowingCoverSources: [
        { batchId: "batch-17", sowingRequestId: "req-17", requestNumber: "SR202610260017", plants: 22620 },
        { batchId: "batch-2", sowingRequestId: "req-2", requestNumber: "SR202610230002", plants: 17380 },
      ],
    },
  ]);
  assert.equal(card.orderNumber, 4313);
  assert.equal(card.farmerName, "Ramesh");
  assert.equal(card.orderPlants, 40000);
  assert.equal(card.sownHere, 22620);
  assert.equal(card.stillNeed, 0);
  assert.equal(card.coverStatus, "done");
  assert.equal(card.otherCoverSources.length, 1);
  assert.equal(card.otherCoverSources[0].requestNumber, "SR202610230002");
  assert.equal(card.otherCoverSources[0].plants, 17380);
});

test("plants stored on the sowing entry are the cover for that order", () => {
  const [card] = linkedOrdersForEntry(
    {
      ...entry,
      orderCovers: [{ orderId: "order-4313", plants: 900, partial: true }],
    },
    [
      {
        _id: "order-4313",
        orderId: 4313,
        numberOfPlants: 4000,
        sowingCoverSources: [
          { batchId: "batch-17", sowingRequestId: "req-17", requestNumber: "SR202610260017", plants: 22620 },
        ],
      },
    ]
  );
  assert.equal(card.sownHere, 900);
  assert.equal(card.coverStatus, "partial");
});

test("a sibling batch on the same request is not this entry's cover", () => {
  const [card] = linkedOrdersForEntry(entry, [
    {
      _id: "order-4313",
      orderId: 4313,
      numberOfPlants: 1000,
      sowingCoverSources: [
        { batchId: "batch-other", sowingRequestId: "req-17", requestNumber: "SR202610260017", plants: 1000 },
      ],
    },
  ]);
  assert.equal(card.sownHere, 0);
  assert.equal(card.otherCoverSources[0].plants, 1000);
});

test("table cover and drawer share one split inside expected ready", () => {
  const bhujang = {
    ...entry,
    plantsSowed: 33642,
    sowingBufferPct: 12,
    bufferPlants: 4037,
    linkedOrderIds: ["order-4394", "order-4502"],
  };
  const orders = [
    {
      _id: "order-4502",
      orderId: 4502,
      numberOfPlants: 15000,
      deliveryDate: "2026-11-18T00:00:00.000Z",
      sowingDone: true,
      sowingDoneRequestId: "req-17",
      sowingCoverSources: [],
    },
    {
      _id: "order-4394",
      orderId: 4394,
      numberOfPlants: 15000,
      deliveryDate: "2026-11-17T00:00:00.000Z",
      sowingDone: true,
      sowingDoneRequestId: "req-17",
      sowingCoverSources: [],
    },
  ];
  const cards = linkedOrdersForEntry(bhujang, orders);
  const first = cards.find((row) => row.orderNumber === 4394);
  const second = cards.find((row) => row.orderNumber === 4502);
  assert.equal(first.sownHere, 0);
  assert.equal(first.remaining, 15000);
  assert.equal(first.coverStatus, "need");
  assert.equal(first.sowingDone, false);
  assert.equal(second.sownHere, 0);
  assert.equal(second.remaining, 15000);
  assert.equal(second.coverStatus, "need");
  assert.equal(second.sowingDone, false);
  assert.equal(attributedOrderPlants(bhujang, orders), null);
});

test("orders not on the entry document are left out", () => {
  const cards = linkedOrdersForEntry(entry, [
    { _id: "other", orderId: 1, numberOfPlants: 10, sowingCoverSources: [] },
  ]);
  assert.equal(cards.length, 0);
});
