import MeasurementUnit from "../models/measurementUnit.model.js";
import RamAgriInputsProduct from "../models/ramAgriInputsProduct.model.js";

const DEFAULT_UNIT_LOOKUP = {
  seed: [
    { abbreviation: "pks", name: "Pkt" },
    { abbreviation: "Pkt", name: "Pkt" },
    { name: "Seeds" },
  ],
  chemical: [
    { abbreviation: "Bottle", name: "Bottle" },
    { name: "Liter" },
  ],
  gift: [
    { abbreviation: "Pc", name: "Piece" },
    { name: "Piece" },
  ],
};

let cachedDefaults = null;

async function findUnitByLookup(lookup = []) {
  for (const rule of lookup) {
    const query = { isActive: { $ne: false } };
    if (rule.abbreviation) query.abbreviation = rule.abbreviation;
    if (rule.name) query.name = rule.name;
    const unit = await MeasurementUnit.findOne(query).select("_id name abbreviation").lean();
    if (unit) return unit;
  }
  return null;
}

export async function getDefaultUnitForProductType(productType = "seed") {
  if (!cachedDefaults) cachedDefaults = {};
  const key = productType || "seed";
  if (cachedDefaults[key]) return cachedDefaults[key];

  const lookup = DEFAULT_UNIT_LOOKUP[key] || DEFAULT_UNIT_LOOKUP.seed;
  const unit = await findUnitByLookup(lookup);
  cachedDefaults[key] = unit;
  return unit;
}

/** Resolve variety primary unit id; optionally persist default when missing. */
export async function resolveVarietyPrimaryUnitId(variety, crop, { persist = false, userId = null } = {}) {
  const existing =
    variety?.primaryUnit?._id ||
    variety?.primaryUnit ||
    null;
  if (existing) return existing;

  const productType = crop?.productType || "seed";
  const defaultUnit = await getDefaultUnitForProductType(productType);
  if (!defaultUnit?._id) {
    throw new Error(`No default unit configured for Ram Agri ${productType} varieties`);
  }

  if (persist && crop?._id && variety?._id) {
    await RamAgriInputsProduct.updateOne(
      { _id: crop._id, "varieties._id": variety._id },
      {
        $set: {
          "varieties.$.primaryUnit": defaultUnit._id,
          ...(variety.conversionFactor == null || variety.conversionFactor === undefined
            ? { "varieties.$.conversionFactor": 1 }
            : {}),
          ...(userId ? { updatedBy: userId } : {}),
        },
      },
      { runValidators: false }
    );
    variety.primaryUnit = defaultUnit._id;
  }

  return defaultUnit._id;
}

export async function backfillMissingVarietyUnits(userId = null) {
  const crops = await RamAgriInputsProduct.find({});
  let updated = 0;
  const details = [];

  for (const crop of crops) {
    const productType = crop.productType || "seed";
    const defaultUnit = await getDefaultUnitForProductType(productType);
    if (!defaultUnit?._id) {
      throw new Error(`No default unit for product type "${productType}"`);
    }

    let dirty = false;
    for (const variety of crop.varieties || []) {
      if (variety.primaryUnit) continue;
      variety.primaryUnit = defaultUnit._id;
      if (!variety.conversionFactor || variety.conversionFactor <= 0) {
        variety.conversionFactor = 1;
      }
      dirty = true;
      updated += 1;
      details.push({
        crop: crop.cropName,
        variety: variety.name,
        unit: defaultUnit.name,
        unitId: String(defaultUnit._id),
      });
    }
    if (dirty) {
      if (userId) crop.updatedBy = userId;
      await crop.save({ validateBeforeSave: false });
    }
  }

  const seedDefault = await getDefaultUnitForProductType("seed");
  return { updated, defaultUnit: seedDefault, details };
}
