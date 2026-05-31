import test from "node:test";
import assert from "node:assert/strict";
import { normalizeSlotTrailInPlantSlot } from "../utility/normalizeSlotTrail.js";
import { SLOT_TRAIL_ACTIONS } from "../constants/slotTrailActions.js";

test("normalizeSlotTrailInPlantSlot backfills missing reason and activityName", () => {
  const doc = {
    subtypeSlots: [
      {
        slots: [
          {
            slotTrail: [
              {
                action: SLOT_TRAIL_ACTIONS.EARLY_DISPATCH_OUT,
                quantity: 100,
                previousTotalPlants: 0,
                newTotalPlants: 0,
                previousAvailablePlants: 500,
                newAvailablePlants: 400,
              },
              {
                action: SLOT_TRAIL_ACTIONS.AVAILABLE_PLANTS_UPDATED,
                activityName: "Available Plants Updated",
                quantity: 50,
                notes: "Manual stock correction",
                previousTotalPlants: 0,
                newTotalPlants: 0,
                previousAvailablePlants: 400,
                newAvailablePlants: 450,
              },
            ],
          },
        ],
      },
    ],
  };

  const fixed = normalizeSlotTrailInPlantSlot(doc);

  assert.equal(fixed, 3);
  assert.equal(
    doc.subtypeSlots[0].slots[0].slotTrail[0].activityName,
    "Released for cross-slot dispatch"
  );
  assert.equal(
    doc.subtypeSlots[0].slots[0].slotTrail[0].reason,
    "Released for cross-slot dispatch"
  );
  assert.equal(
    doc.subtypeSlots[0].slots[0].slotTrail[1].reason,
    "Manual stock correction"
  );
});
