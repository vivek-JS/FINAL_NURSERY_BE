import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  allocateSecondaryFifoPlants,
  allocateMultiShedFifoLoads,
  allocateManualSecondaryLoads,
  normalizeInwardSelections,
  groupPolyhouseStockByBatch,
  normalizeShedLoadInputs,
  normalizeShedLoads,
  pollyhouseMatchesFilter,
  splitPlantsAcrossOrdersFifo,
  resolveOrderAllocationsForSelection,
} from "../services/secondaryVehicleLoad.service.js";

describe("secondaryVehicleLoad — FIFO allocation", () => {
  const suggestions = [
    {
      batchId: "b1",
      secondaryInwardId: "s1",
      batchNumber: "100",
      cavity: 8,
      size: "R1",
      remainingPlants: 400,
      pollyhouse: "Shed (13)",
    },
    {
      batchId: "b2",
      secondaryInwardId: "s2",
      batchNumber: "200",
      cavity: 8,
      size: "R1",
      remainingPlants: 240,
      pollyhouse: "Shed (13)",
    },
  ];

  it("splits across two lines FIFO full-tray", () => {
    const r = allocateSecondaryFifoPlants(suggestions, 480);
    assert.equal(r.ok, true);
    assert.equal(r.totalAllocated, 480);
    assert.equal(r.allocations.length, 2);
    assert.equal(r.allocations[0].plants, 400);
    assert.equal(r.allocations[1].plants, 80);
  });

  it("rejects when not enough full-tray stock", () => {
    const r = allocateSecondaryFifoPlants(suggestions, 700);
    assert.equal(r.ok, false);
    assert.equal(r.partial, true);
    assert.equal(r.totalAllocated, 640);
  });

  it("rejects zero plants", () => {
    const r = allocateSecondaryFifoPlants(suggestions, 0);
    assert.equal(r.ok, false);
  });

  it("allocates partial last tray when need is not a full-tray multiple", () => {
    const r = allocateSecondaryFifoPlants(
      [
        {
          batchId: "b1",
          secondaryInwardId: "s1",
          batchNumber: "786",
          cavity: 8,
          size: "R1",
          remainingPlants: 400,
          numberOfTrays: 50,
          numberOfBottles: 200,
          pollyhouse: "Shed (13)",
        },
      ],
      100
    );
    assert.equal(r.ok, true);
    assert.equal(r.totalAllocated, 100);
    assert.equal(r.allocations.length, 1);
    assert.equal(r.allocations[0].plants, 100);
    assert.equal(r.allocations[0].numberOfFullTrays, 12);
    assert.equal(r.allocations[0].partialTrayPlants, 4);
    assert.equal(r.allocations[0].numberOfTrays, 13);
  });
});

describe("secondaryVehicleLoad — pollyhouse filter", () => {
  it("matches shed names case-insensitively", () => {
    assert.equal(pollyhouseMatchesFilter("Shed (13)", "shed (13)"), true);
    assert.equal(pollyhouseMatchesFilter("R1 House", "house"), true);
    assert.equal(pollyhouseMatchesFilter("A", "B"), false);
  });
});

describe("secondaryVehicleLoad — multi-shed loads", () => {
  const suggestions = [
    {
      batchId: "b1",
      secondaryInwardId: "s1",
      batchNumber: "100",
      cavity: 8,
      size: "R1",
      remainingPlants: 400,
      dispatchEligible: true,
      pollyhouse: "Shed (13)",
    },
    {
      batchId: "b2",
      secondaryInwardId: "s2",
      batchNumber: "200",
      cavity: 8,
      size: "R1",
      remainingPlants: 240,
      dispatchEligible: true,
      pollyhouse: "Shed (14)",
    },
  ];

  it("normalizes legacy single shed body", () => {
    const rows = normalizeShedLoads({ pollyhouse: "Shed (13)", plants: 80 });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].plants, 80);
  });

  it("normalizes multi-shed body", () => {
    const rows = normalizeShedLoads({
      shedLoads: [
        { pollyhouse: "Shed (13)", plants: 80 },
        { pollyhouse: "Shed (14)", plants: 160 },
      ],
    });
    assert.equal(rows.length, 2);
    assert.equal(rows[1].pollyhouse, "Shed (14)");
  });

  it("allocates FIFO per shed and tags allocations", () => {
    const r = allocateMultiShedFifoLoads(suggestions, [
      { pollyhouse: "Shed (13)", plants: 80 },
      { pollyhouse: "Shed (14)", plants: 160 },
    ]);
    assert.equal(r.ok, true);
    assert.equal(r.totalAllocated, 240);
    assert.equal(r.allocations.length, 2);
    assert.equal(r.allocations[0].pollyhouse, "Shed (13)");
    assert.equal(r.allocations[1].pollyhouse, "Shed (14)");
    assert.equal(r.byShed.length, 2);
  });

  it("allocates FIFO per shed and size (R1/R2/R3)", () => {
    const sized = [
      {
        batchId: "b1",
        secondaryInwardId: "s1",
        batchNumber: "100",
        cavity: 8,
        size: "R1",
        remainingPlants: 400,
        dispatchEligible: true,
        pollyhouse: "Shed (13)",
      },
      {
        batchId: "b2",
        secondaryInwardId: "s2",
        batchNumber: "200",
        cavity: 8,
        size: "R2",
        remainingPlants: 240,
        dispatchEligible: true,
        pollyhouse: "Shed (13)",
      },
    ];
    const inputs = normalizeShedLoadInputs({
      shedLoads: [{ pollyhouse: "Shed (13)", sizeSplit: { R1: 80, R2: 160, R3: 0 } }],
    });
    const r = allocateMultiShedFifoLoads(sized, inputs);
    assert.equal(r.ok, true);
    assert.equal(r.totalAllocated, 240);
    assert.equal(r.allocations.length, 2);
    assert.equal(r.allocations[0].size, "R1");
    assert.equal(r.allocations[1].size, "R2");
  });
});

describe("secondaryVehicleLoad — manual inward selection", () => {
  const suggestions = [
    {
      batchId: "b1",
      secondaryInwardId: "s1",
      batchNumber: "786",
      cavity: 8,
      size: "R1",
      remainingPlants: 400,
      numberOfTrays: 50,
      numberOfBottles: 200,
      dispatchEligible: true,
      pollyhouse: "Shed (13)",
    },
    {
      batchId: "b2",
      secondaryInwardId: "s2",
      batchNumber: "787",
      cavity: 8,
      size: "R2",
      remainingPlants: 240,
      numberOfTrays: 30,
      numberOfBottles: 120,
      dispatchEligible: true,
      pollyhouse: "Shed (14)",
    },
  ];

  it("dedups + aggregates selections by inward id", () => {
    const rows = normalizeInwardSelections([
      { secondaryInwardId: "s1", batchId: "b1", plants: 100 },
      { secondaryInwardId: "s1", batchId: "b1", plants: 24 },
      { secondaryInwardId: "s2", plants: 0 },
    ]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].plants, 124);
  });

  it("allocates exactly the picked entries within cap", () => {
    const r = allocateManualSecondaryLoads(
      suggestions,
      [
        { secondaryInwardId: "s1", batchId: "b1", plants: 100 },
        { secondaryInwardId: "s2", batchId: "b2", plants: 200 },
      ],
      { capPlants: 1300 }
    );
    assert.equal(r.ok, true);
    assert.equal(r.totalAllocated, 300);
    assert.equal(r.allocations.length, 2);
    assert.equal(r.allocations[0].plants, 100);
    assert.equal(r.allocations[0].numberOfFullTrays, 12);
    assert.equal(r.allocations[0].partialTrayPlants, 4);
    assert.equal(r.allocations[0].numberOfTrays, 13);
    assert.equal(r.allocations[1].plants, 200);
    assert.equal(r.allocations[1].numberOfFullTrays, 25);
    assert.equal(r.allocations[1].partialTrayPlants, 0);
  });

  it("rejects when a selection exceeds the inward available", () => {
    const r = allocateManualSecondaryLoads(
      suggestions,
      [{ secondaryInwardId: "s1", batchId: "b1", plants: 500 }],
      { capPlants: 1300 }
    );
    assert.equal(r.ok, false);
    assert.match(r.error, /only 400 available/);
  });

  it("rejects when total exceeds the remaining need cap", () => {
    const r = allocateManualSecondaryLoads(
      suggestions,
      [
        { secondaryInwardId: "s1", batchId: "b1", plants: 400 },
        { secondaryInwardId: "s2", batchId: "b2", plants: 240 },
      ],
      { capPlants: 500 }
    );
    assert.equal(r.ok, false);
    assert.match(r.error, /exceeds remaining need/);
  });

  it("rejects unknown inward id", () => {
    const r = allocateManualSecondaryLoads(
      suggestions,
      [{ secondaryInwardId: "missing", plants: 10 }],
      { capPlants: 1300 }
    );
    assert.equal(r.ok, false);
    assert.match(r.error, /not found/);
  });
});

describe("secondaryVehicleLoad — byBatch rollup", () => {
  it("groups lines by batch", () => {
    const rows = groupPolyhouseStockByBatch([
      { batchId: "b1", batchNumber: "786", availableQuantity: 200 },
      { batchId: "b1", batchNumber: "786", availableQuantity: 200 },
      { batchId: "b2", batchNumber: "787", availableQuantity: 100 },
    ]);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].totalPlants, 400);
    assert.equal(rows[0].lineCount, 2);
  });
});

describe("secondaryVehicleLoad — order loaded flags", () => {
  it("documents fullyLoaded when shed qty meets dispatch qty", () => {
    const dispatchQuantity = 400;
    const shedLoadedQuantity = 400;
    const fullyLoaded = dispatchQuantity > 0 && shedLoadedQuantity >= dispatchQuantity;
    assert.equal(fullyLoaded, true);
  });

  it("partial load is not fully loaded", () => {
    const dispatchQuantity = 400;
    const shedLoadedQuantity = 200;
    const fullyLoaded = dispatchQuantity > 0 && shedLoadedQuantity >= dispatchQuantity;
    assert.equal(fullyLoaded, false);
  });
});

describe("secondaryVehicleLoad — order ↔ batch allocations", () => {
  it("normalizeInwardSelections keeps orderAllocations and orderIds", () => {
    const rows = normalizeInwardSelections([
      {
        secondaryInwardId: "s1",
        batchId: "b1",
        plants: 100,
        orderIds: ["o1", "o2"],
        orderAllocations: [
          { orderId: "o1", plants: 60 },
          { orderId: "o2", plants: 40 },
        ],
      },
      {
        secondaryInwardId: "s1",
        plants: 20,
        orderAllocations: [{ orderId: "o1", plants: 20 }],
      },
    ]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].plants, 120);
    assert.deepEqual(rows[0].orderIds, ["o1", "o2"]);
    assert.equal(rows[0].orderAllocations.length, 2);
    assert.equal(
      rows[0].orderAllocations.find((a) => a.orderId === "o1").plants,
      80
    );
  });

  it("allocateManualSecondaryLoads carries orderAllocations onto lines", () => {
    const r = allocateManualSecondaryLoads(
      [
        {
          batchId: "b1",
          secondaryInwardId: "s1",
          batchNumber: "100",
          cavity: 8,
          remainingPlants: 400,
          dispatchEligible: true,
          pollyhouse: "Shed A",
        },
      ],
      [
        {
          secondaryInwardId: "s1",
          batchId: "b1",
          plants: 100,
          orderAllocations: [
            { orderId: "o1", plants: 70 },
            { orderId: "o2", plants: 30 },
          ],
        },
      ],
      { capPlants: 400 }
    );
    assert.equal(r.ok, true);
    assert.equal(r.allocations[0].orderAllocations.length, 2);
  });

  it("splitPlantsAcrossOrdersFifo respects remaining need", () => {
    const rem = new Map([
      ["o1", 50],
      ["o2", 80],
    ]);
    const parts = splitPlantsAcrossOrdersFifo(100, ["o1", "o2"], rem);
    assert.equal(parts.length, 2);
    assert.equal(parts[0].orderId, "o1");
    assert.equal(parts[0].plants, 50);
    assert.equal(parts[1].orderId, "o2");
    assert.equal(parts[1].plants, 50);
    const total = parts.reduce((s, p) => s + p.plants, 0);
    assert.equal(total, 100);
  });

  it("splitPlantsAcrossOrdersFifo does not exceed order caps", () => {
    const rem = new Map([
      ["o1", 50],
      ["o2", 30],
    ]);
    const parts = splitPlantsAcrossOrdersFifo(100, ["o1", "o2"], rem);
    assert.equal(parts[0].plants, 50);
    assert.equal(parts[1].plants, 30);
    assert.equal(parts.reduce((s, p) => s + p.plants, 0), 80);
  });

  it("resolveOrderAllocationsForSelection errors when sums mismatch", () => {
    const r = resolveOrderAllocationsForSelection({
      plants: 100,
      orderAllocations: [{ orderId: "o1", plants: 40 }],
    });
    assert.match(r.error || "", /must equal/);
  });

  it("resolveOrderAllocationsForSelection uses linkedOrderId fallback", () => {
    const r = resolveOrderAllocationsForSelection(
      { plants: 25 },
      { linkedOrderId: "o9" }
    );
    assert.deepEqual(r.allocations, [{ orderId: "o9", plants: 25 }]);
  });

  it("complete autofill joins unique shedLoadedBatches numbers", () => {
    const batches = [
      { batchNumber: "12" },
      { batchNumber: "15" },
      { batchNumber: "12" },
      { batchNumber: "  " },
    ];
    const seen = new Set();
    const ordered = [];
    for (const b of batches) {
      const n = String(b?.batchNumber ?? "").trim();
      if (!n || seen.has(n)) continue;
      seen.add(n);
      ordered.push(n);
    }
    assert.equal(ordered.join(", "), "12, 15");
  });
});
