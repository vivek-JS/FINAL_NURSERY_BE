import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveIssueInventorySplit,
  resolvePreferredIssueSource,
} from "../services/sowingIssueInventory.service.js";

test("prefers Ram Agri only for an exact product or linked variety", () => {
  assert.equal(resolvePreferredIssueSource(null), "BIOTECH");
  assert.equal(resolvePreferredIssueSource({}), "BIOTECH");
  assert.equal(
    resolvePreferredIssueSource({
      cropId: "c1",
      varietyId: "v1",
      matchedBy: "plantSubtype",
    }),
    "BIOTECH"
  );
  assert.equal(
    resolvePreferredIssueSource({
      cropId: "c1",
      varietyId: "v1",
      matchedBy: "productFields",
    }),
    "RAM_AGRI"
  );
  assert.equal(
    resolvePreferredIssueSource({
      cropId: "c1",
      varietyId: "v1",
      matchedBy: "linkedProduct",
    }),
    "RAM_AGRI"
  );
});

test("issue split keeps a single Biotech or Ram Agri source", () => {
  assert.deepEqual(
    resolveIssueInventorySplit({
      companyIssueQty: 4,
      inventorySource: "BIOTECH",
    }),
    {
      source: "BIOTECH",
      packetsFromBiotech: 4,
      packetsFromRamAgri: 0,
    }
  );
  assert.deepEqual(
    resolveIssueInventorySplit({
      companyIssueQty: 3.5,
      inventorySource: "RAM_AGRI",
    }),
    {
      source: "RAM_AGRI",
      packetsFromBiotech: 0,
      packetsFromRamAgri: 3.5,
    }
  );
});
