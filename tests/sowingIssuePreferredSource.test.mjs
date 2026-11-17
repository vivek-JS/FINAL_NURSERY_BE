import assert from "node:assert/strict";
import test from "node:test";
import {
  collectBiotechProductIds,
  packetsInRequestUnit,
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

test("collects unique linked Biotech products plus the request product", () => {
  const requestProduct = "6a84c382ad6e6dae322b5b79";
  const extra = "6aae78cec46acc3e25a4022b";
  const ids = collectBiotechProductIds(
    [{ productId: { _id: requestProduct } }, { productId: extra }, { productId: requestProduct }],
    requestProduct
  );
  assert.deepEqual(
    ids.map(String).sort(),
    [requestProduct, extra].sort()
  );
});

test("packetsInRequestUnit converts secondary-unit leftover into packets", () => {
  const request = {
    primaryUnit: { _id: "69da85fe39cf080b4b5f1d2e" },
    secondaryUnit: { _id: "69da85fe39cf080b4b5f1d2f" },
    conversionFactor: 50,
  };
  assert.equal(
    packetsInRequestUnit(
      { remainingQuantity: 100, unit: { _id: "69da85fe39cf080b4b5f1d2f" } },
      request
    ),
    2
  );
  assert.equal(
    packetsInRequestUnit(
      { remainingQuantity: 32, unit: { _id: "69da85fe39cf080b4b5f1d2e" } },
      request
    ),
    32
  );
});
