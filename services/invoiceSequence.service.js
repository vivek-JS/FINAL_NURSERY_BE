import InvoiceSequence, { DELIVERY_CHALLAN_SEQUENCE_KEY } from "../models/invoiceSequence.model.js";
import PlantCms from "../models/plantCms.model.js";
import mongoose from "mongoose";
import { plantDcSequenceKey } from "./officialDeliveryChallan.service.js";

/**
 * Atomically reserve `count` consecutive invoice numbers. Returns formatted strings, e.g. ["R640","R641"].
 * Does not change already-issued values on orders; only moves the global counter.
 */
export async function allocateNextInvoiceNumbers(session, count) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  if (n < 1) return [];

  const sess = session || undefined;

  await InvoiceSequence.updateOne(
    { key: DELIVERY_CHALLAN_SEQUENCE_KEY },
    { $setOnInsert: { prefix: "R", nextNumber: 1 } },
    { upsert: true, session: sess }
  );

  const updated = await InvoiceSequence.findOneAndUpdate(
    { key: DELIVERY_CHALLAN_SEQUENCE_KEY },
    { $inc: { nextNumber: n } },
    { new: true, session: sess }
  ).lean();

  if (!updated) {
    throw new Error("Failed to reserve invoice numbers");
  }

  const endExclusive = updated.nextNumber;
  const start = endExclusive - n;
  const prefix =
    updated.prefix != null && String(updated.prefix).trim() !== ""
      ? String(updated.prefix).trim()
      : "R";

  const out = [];
  for (let v = start; v < endExclusive; v += 1) {
    out.push(`${prefix}${v}`);
  }
  return out;
}

export async function getInvoiceSequenceSettings() {
  const doc = await InvoiceSequence.findOne({ key: DELIVERY_CHALLAN_SEQUENCE_KEY }).lean();
  if (!doc) {
    return { key: DELIVERY_CHALLAN_SEQUENCE_KEY, prefix: "R", nextNumber: 1 };
  }
  return {
    key: doc.key,
    prefix: doc.prefix != null && String(doc.prefix).trim() !== "" ? String(doc.prefix).trim() : "R",
    nextNumber: Number(doc.nextNumber) || 1,
    updatedAt: doc.updatedAt,
  };
}

export async function setInvoiceSequenceSettings({ prefix, nextNumber }) {
  const p =
    prefix != null && String(prefix).trim() !== ""
      ? String(prefix).trim().slice(0, 24)
      : "R";
  const nn = Math.max(1, Math.floor(Number(nextNumber) || 1));

  const updated = await InvoiceSequence.findOneAndUpdate(
    { key: DELIVERY_CHALLAN_SEQUENCE_KEY },
    { $set: { prefix: p, nextNumber: nn } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  ).lean();

  return {
    key: updated.key,
    prefix: updated.prefix,
    nextNumber: updated.nextNumber,
    updatedAt: updated.updatedAt,
  };
}

function defaultPrefixFromPlantName(name) {
  const t = String(name || "").replace(/[^A-Za-z]/g, "").toUpperCase();
  return (t.slice(0, 3) || "PL").slice(0, 8);
}

/**
 * List all PlantCms plants with their dc_plant:* sequence (defaults if missing).
 */
export async function listPlantInvoiceSequences() {
  const plants = await PlantCms.find({}).select("name").sort({ name: 1 }).lean();
  const keys = plants.map((p) => plantDcSequenceKey(p._id));
  const seqDocs = keys.length
    ? await InvoiceSequence.find({ key: { $in: keys } }).lean()
    : [];
  const byKey = new Map(seqDocs.map((d) => [d.key, d]));

  return plants.map((p) => {
    const key = plantDcSequenceKey(p._id);
    const doc = byKey.get(key);
    const prefix =
      doc?.prefix != null && String(doc.prefix).trim() !== ""
        ? String(doc.prefix).trim()
        : defaultPrefixFromPlantName(p.name);
    const nextNumber = doc ? Math.max(1, Number(doc.nextNumber) || 1) : 1;
    return {
      plantId: String(p._id),
      plantName: p.name || "—",
      key,
      prefix,
      nextNumber,
      preview: `${prefix}${nextNumber}`,
      exists: Boolean(doc),
      updatedAt: doc?.updatedAt || null,
    };
  });
}

/**
 * Upsert prefix + nextNumber for one plant sequence. Does not rewrite issued order numbers.
 */
export async function setPlantInvoiceSequence({ plantId, prefix, nextNumber }) {
  if (!mongoose.isValidObjectId(String(plantId))) {
    const err = new Error("Invalid plantId");
    err.statusCode = 400;
    throw err;
  }
  const plant = await PlantCms.findById(plantId).select("name").lean();
  if (!plant) {
    const err = new Error("Plant not found");
    err.statusCode = 404;
    throw err;
  }
  const key = plantDcSequenceKey(plantId);
  const p =
    prefix != null && String(prefix).trim() !== ""
      ? String(prefix).trim().slice(0, 24)
      : defaultPrefixFromPlantName(plant.name);
  const nn = Math.max(1, Math.floor(Number(nextNumber) || 1));

  const prefixClash = await InvoiceSequence.findOne({
    $and: [
      { key: { $regex: /^dc_plant:/ } },
      { prefix: p },
      { key: { $ne: key } },
    ],
  })
    .select("key")
    .lean();

  if (prefixClash) {
    const err = new Error(`Prefix "${p}" is already used by another plant sequence`);
    err.statusCode = 400;
    throw err;
  }

  const updated = await InvoiceSequence.findOneAndUpdate(
    { key },
    { $set: { prefix: p, nextNumber: nn }, $setOnInsert: { key } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  ).lean();

  return {
    plantId: String(plantId),
    plantName: plant.name || "—",
    key: updated.key,
    prefix: updated.prefix,
    nextNumber: updated.nextNumber,
    preview: `${updated.prefix}${updated.nextNumber}`,
    exists: true,
    updatedAt: updated.updatedAt,
  };
}
