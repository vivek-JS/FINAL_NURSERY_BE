import { describe, it } from "node:test";
import assert from "node:assert";
import {
  parseClockTime,
  machineRunMinutes,
  formatClock12h,
  readMachineTimes,
} from "../utility/sowMachineTime.js";

describe("sowMachineTime", () => {
  it("parses 24h and AM/PM input to HH:mm", () => {
    assert.strictEqual(parseClockTime("09:05"), "09:05");
    assert.strictEqual(parseClockTime("9:05 am"), "09:05");
    assert.strictEqual(parseClockTime("12:00 AM"), "00:00");
    assert.strictEqual(parseClockTime("12:30 PM"), "12:30");
    assert.strictEqual(parseClockTime("1:15PM"), "13:15");
    assert.strictEqual(parseClockTime("13:15 PM"), null);
    assert.strictEqual(parseClockTime("24:00"), null);
    assert.strictEqual(parseClockTime(""), null);
  });

  it("counts minutes, wrapping past midnight", () => {
    assert.strictEqual(machineRunMinutes("09:15", "13:30"), 255);
    assert.strictEqual(machineRunMinutes("22:00", "01:00"), 180);
  });

  it("formats HH:mm as 12h", () => {
    assert.strictEqual(formatClock12h("00:10"), "12:10 AM");
    assert.strictEqual(formatClock12h("13:05"), "1:05 PM");
  });

  it("readMachineTimes: optional, but both required once one is sent", () => {
    assert.deepStrictEqual(readMachineTimes({}), { start: "", end: "", minutes: 0 });
    assert.ok(readMachineTimes({ machineStartTime: "09:00" }).error);
    assert.deepStrictEqual(
      readMachineTimes({ machineStartTime: "9:00 AM", machineEndTime: "11:30 AM" }),
      { start: "09:00", end: "11:30", minutes: 150 }
    );
  });
});
