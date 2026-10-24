import test from "node:test";
import assert from "node:assert/strict";
import { excessFieldsForBatch, storedShownExcess } from "../utility/sowingBatchExcessStamp.js";

test("stamps CMS percent of sowed, then subtracts orders", () => {
  const fields = excessFieldsForBatch(
    { plantsSowed: 75600, orderCoveredPlants: 66700 },
    12
  );
  assert.equal(fields.sowingBufferPct, 12);
  assert.equal(fields.bufferPlants, 9072);
  assert.equal(fields.shownExcess, 0);
});

test("stored shownExcess is read back as saved", () => {
  assert.equal(
    storedShownExcess({ plantsSowed: 75600, orderCoveredPlants: 66700, sowingBufferPct: 12, shownExcess: 0 }),
    0
  );
  assert.equal(
    storedShownExcess({ plantsSowed: 10000, orderCoveredPlants: 8000 }, 12),
    800
  );
});
