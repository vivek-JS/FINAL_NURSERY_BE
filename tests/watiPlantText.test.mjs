import test from "node:test";
import assert from "node:assert/strict";
import {
  formatWhatsappPlantMarathiShort,
  resolveEmbeddedSubtypeName,
} from "../utility/watiPlantText.js";

test("formatWhatsappPlantMarathiShort — Banana → केळी", () => {
  assert.equal(formatWhatsappPlantMarathiShort("Banana"), "केळी");
});

test("resolveEmbeddedSubtypeName — embedded PlantCms subtype", () => {
  const plant = {
    name: "Banana",
    subtypes: [
      { _id: "507f1f77bcf86cd799439011", name: "G9" },
      { _id: "507f1f77bcf86cd799439012", name: "Grand Naine" },
    ],
  };
  assert.equal(
    resolveEmbeddedSubtypeName(plant, "507f1f77bcf86cd799439011"),
    "G9"
  );
  assert.equal(resolveEmbeddedSubtypeName(plant, "missing"), "");
});
