import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isVehicleLoadComplete } from "../services/secondaryVehicleLoad.service.js";

describe("isVehicleLoadComplete", () => {
  it("full load is complete", () => {
    assert.equal(isVehicleLoadComplete(2001, 2001), true);
  });

  it("short within 2% is complete (vehicle 1118: 1977 / 2001)", () => {
    assert.equal(isVehicleLoadComplete(1977, 2001), true);
    assert.equal(isVehicleLoadComplete(1961, 2001), true);
  });

  it("short beyond 2% stays pending", () => {
    assert.equal(isVehicleLoadComplete(1960, 2001), false);
    assert.equal(isVehicleLoadComplete(99, 120), false);
  });

  it("nothing loaded or no need is never complete", () => {
    assert.equal(isVehicleLoadComplete(0, 2001), false);
    assert.equal(isVehicleLoadComplete(10, 0), false);
  });

  it("small vehicles get no tolerance below 50 plants", () => {
    assert.equal(isVehicleLoadComplete(48, 49), false);
    assert.equal(isVehicleLoadComplete(49, 50), true);
  });
});
