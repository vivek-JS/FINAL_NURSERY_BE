import test from "node:test";
import assert from "node:assert/strict";
import { normalizeMobile10, summarizeLeadFarmers } from "../services/leadFarmerStats.service.js";

test("mobile keeps the last 10 digits", () => {
  assert.equal(normalizeMobile10("+91 98765-43210"), "9876543210");
  assert.equal(normalizeMobile10(9876543210), "9876543210");
  assert.equal(normalizeMobile10("12345"), "");
});

test("repeat farmers are phones already in old sales or current farmers", () => {
  const known = new Set(["9876543210"]);
  const stats = summarizeLeadFarmers(
    [
      { mobileNumber: "9876543210", publicLinkId: "link-a" },
      { mobileNumber: "919876543210", publicLinkId: "link-a" },
      { mobileNumber: "9000000001", publicLinkId: "link-b" },
      { mobileNumber: "bad", publicLinkId: "link-b" },
    ],
    known
  );

  assert.equal(stats.totalLeads, 4);
  assert.equal(stats.repeatFarmers, 2);
  assert.equal(stats.newFarmers, 2);
  assert.deepEqual(stats.byLink, [
    { publicLinkId: "link-a", totalLeads: 2, newFarmers: 0, repeatFarmers: 2 },
    { publicLinkId: "link-b", totalLeads: 2, newFarmers: 2, repeatFarmers: 0 },
  ]);
});
