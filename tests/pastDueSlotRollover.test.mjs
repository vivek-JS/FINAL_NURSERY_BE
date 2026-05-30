import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildSlotRolloverIndexes,
  findRolloverTargetSlotForSubtype,
  deliveryDateForRolloverTarget,
  isSlotActive,
  isSlotContainingDate,
  findCurrentSlotIdForGroup,
} from "../services/pastDueSlotRollover.service.js";

const asOf = new Date("2026-05-30T12:00:00+05:30");

describe("pastDueSlotRollover", () => {
  it("all past-due rolls target today's slot (not next-next per expired window)", () => {
    const plantSlots = [
      {
        _id: "ps1",
        plantId: "p1",
        year: 2026,
        subtypeSlots: [
          {
            subtypeId: "st1",
            slots: [
              {
                _id: "s1",
                startDay: "15-04-2026",
                endDay: "21-04-2026",
                status: true,
              },
              {
                _id: "s2",
                startDay: "22-04-2026",
                endDay: "30-04-2026",
                status: true,
              },
              {
                _id: "s3",
                startDay: "01-05-2026",
                endDay: "14-05-2026",
                status: true,
              },
              {
                _id: "s4",
                startDay: "25-05-2026",
                endDay: "07-06-2026",
                status: true,
              },
            ],
          },
        ],
      },
    ];

    const { slotsByPlantSubtype } = buildSlotRolloverIndexes(plantSlots, asOf);
    const target = findRolloverTargetSlotForSubtype(
      slotsByPlantSubtype,
      "p1",
      "st1",
      asOf
    );
    const fromApril = findRolloverTargetSlotForSubtype(
      slotsByPlantSubtype,
      "p1",
      "st1",
      asOf
    );

    assert.equal(target.slotId, "s4");
    assert.equal(fromApril.slotId, target.slotId);
    const delivery = deliveryDateForRolloverTarget(target.slot, asOf);
    assert.ok(delivery);
    const deliveryIst = new Date(delivery).toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
      day: "numeric",
    });
    assert.equal(Number(deliveryIst), 30);
  });

  it("June 10 ended, 6 July today → slot containing 6 Jul", () => {
    const july6 = new Date("2026-07-06T12:00:00+05:30");
    const plantSlots = [
      {
        _id: "ps1",
        plantId: "p1",
        year: 2026,
        subtypeSlots: [
          {
            subtypeId: "st1",
            slots: [
              {
                _id: "jun",
                startDay: "01-06-2026",
                endDay: "10-06-2026",
                status: true,
              },
              {
                _id: "jul",
                startDay: "01-07-2026",
                endDay: "15-07-2026",
                status: true,
              },
            ],
          },
        ],
      },
    ];
    const { slotsByPlantSubtype } = buildSlotRolloverIndexes(plantSlots, july6);
    const target = findRolloverTargetSlotForSubtype(
      slotsByPlantSubtype,
      "p1",
      "st1",
      july6
    );
    assert.equal(target.slotId, "jul");
    const day = new Date(deliveryDateForRolloverTarget(target.slot, july6)).toLocaleString(
      "en-IN",
      { timeZone: "Asia/Kolkata", day: "numeric" }
    );
    assert.equal(Number(day), 6);
  });

  it("findCurrentSlotIdForGroup picks slot containing today", () => {
    const slots = [
      { _id: "old", startDay: "01-04-2026", endDay: "07-04-2026", status: true },
      { _id: "now", startDay: "25-05-2026", endDay: "07-06-2026", status: true },
    ];
    assert.equal(findCurrentSlotIdForGroup(slots, asOf), "now");
    assert.equal(isSlotContainingDate(slots[1], asOf), true);
  });

  it("isSlotActive false when end before asOf", () => {
    assert.equal(
      isSlotActive({ startDay: "01-04-2026", endDay: "07-04-2026" }, asOf),
      false
    );
    assert.equal(
      isSlotActive({ startDay: "25-05-2026", endDay: "07-06-2026" }, asOf),
      true
    );
  });
});
