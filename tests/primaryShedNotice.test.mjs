import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatPrimaryShedNotice,
  formatSecondaryReceiveNotice,
  canUsePrimaryShed,
  isPrimaryStaff,
  isSecondaryStaff,
  secondaryCanReceive,
} from "../utility/primaryShedNotice.js";

describe("primary shed notice", () => {
  const users = [
    { jobTitle: "PRIMARY", role: "PRIMARY" },
    { jobTitle: "SECONDARY", role: "SECONDARY" },
    { jobTitle: "SUPER_ADMIN", role: "SUPER_ADMIN" },
    { jobTitle: "PRIMARY", role: "SECONDARY" },
  ];

  it("shows the primary shed to the Primary job and Super Admin", () => {
    assert.deepEqual(users.map(isPrimaryStaff), [true, false, false, false]);
    assert.deepEqual(users.map(canUsePrimaryShed), [true, false, true, false]);
    assert.deepEqual(users.map(isSecondaryStaff), [false, true, false, true]);
  });

  it("puts lab outward, ready date, and unsown bottles in one message", () => {
    const text = formatPrimaryShedNotice({
      toReceive: [
        { batchNumber: "B-1", plant: "Banana", size: "R1", bottles: 40 },
      ],
      batches: [
        {
          batchNumber: "B-1",
          plant: "Banana",
          sows: [
            { size: "R1", readyDate: "2026-12-01", plantsNotSent: 5000 },
            { size: "R1", readyDate: "2026-12-01", plantsNotSent: 0 },
          ],
          sizes: [
            { size: "R1", bottlesLeft: 30 },
            { size: "R2", bottlesLeft: 0 },
          ],
        },
      ],
    });
    assert.match(text, /^Primary shed/);
    assert.match(text, /Lab outward/);
    assert.match(text, /40 bottles/);
    assert.match(text, /Ready date/);
    assert.match(text, /1 Dec 2026/);
    assert.match(text, /5000 plants not sent/);
    assert.match(text, /Bottles not sown/);
    assert.match(text, /R1 · 30 bottles not sown/);
    assert.equal(text.includes("R2"), false);
  });

  it("tells secondary only that plants were sent", () => {
    const text = formatSecondaryReceiveNotice({
      batchNumber: "B-1",
      plant: "Banana",
      size: "R1",
      plants: 4000,
    });
    assert.match(text, /Primary sent plants/);
    assert.match(text, /4000 plants/);
    assert.match(text, /Receive them in Secondary/);
    assert.equal(text.includes("Bottles not sown"), false);
    assert.equal(text.includes("Lab outward"), false);
  });

  it("lets secondary receive a primary send that is still available", () => {
    assert.equal(
      secondaryCanReceive({
        availableQuantity: 4000,
        totalQuantity: 4000,
        transferStatus: "available",
        secondaryAcknowledgedAt: null,
      }),
      true
    );
    assert.equal(secondaryCanReceive({ availableQuantity: 0, transferStatus: "available" }), false);
    assert.equal(
      secondaryCanReceive({ availableQuantity: 10, transferStatus: "fully_transferred" }),
      false
    );
  });
});
