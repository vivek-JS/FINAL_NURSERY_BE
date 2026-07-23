import mongoose from "mongoose";
import PlantCms from "../models/plantCms.model.js";
import InvoiceSequence from "../models/invoiceSequence.model.js";

/** @deprecated kept for reading legacy keys; new allocations use plantDcSequenceKey */
export function officialDcSequenceKey(plantNameId, plantSubtypeId) {
  return `dc_ps:${String(plantNameId)}:${String(plantSubtypeId)}`;
}

export function plantDcSequenceKey(plantNameId) {
  return `dc_plant:${String(plantNameId)}`;
}

function lettersOnlyUpper(s, maxLen) {
  const t = String(s || "").replace(/[^A-Za-z]/g, "").toUpperCase();
  return t.slice(0, maxLen);
}

function fallbackPrefixFromPlantId(plantNameId) {
  const hex = String(plantNameId).replace(/[^a-fA-F0-9]/g, "");
  let out = "";
  for (let i = 0; i < hex.length && out.length < 3; i += 1) {
    const n = parseInt(hex[i], 16);
    if (!Number.isFinite(n)) continue;
    out += String.fromCharCode(65 + (n % 26));
  }
  return (out + "PL").slice(0, 3);
}

async function resolvePlantPrefix(plantNameId, session) {
  const sess = session || undefined;
  const plant = await PlantCms.findById(plantNameId).select("name").session(sess).lean();
  const letters = lettersOnlyUpper(plant?.name || "", 3) || fallbackPrefixFromPlantId(plantNameId);
  return letters.slice(0, 3) || "PL";
}

async function ensureUniquePlantPrefix(candidate, fullKey, session) {
  const sess = session || undefined;
  const candUpper = String(candidate || "PL")
    .replace(/[^A-Za-z]/g, "")
    .toUpperCase();
  let p = candUpper.slice(0, 8);
  if (!p) p = "PL";
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const clash = await InvoiceSequence.findOne({
      $and: [
        { key: { $regex: /^dc_plant:/ } },
        { prefix: p },
        { key: { $ne: fullKey } },
      ],
    })
      .session(sess)
      .select("key")
      .lean();
    if (!clash) return p;
    const suf = String.fromCharCode(65 + (attempt % 26));
    p = `${candUpper.slice(0, 7)}${suf}`.slice(0, 8) || "PL";
  }
  return fallbackPrefixFromPlantId(String(fullKey).split(":")[1] || fullKey);
}

/**
 * Allocate next official DC for this plant bucket (PREFIX + number, e.g. B640).
 */
export async function allocateOfficialDcNumber(session, plantNameId, _plantSubtypeIdIgnored) {
  const pid = plantNameId?._id ?? plantNameId;
  if (!mongoose.isValidObjectId(String(pid))) {
    throw new Error("allocateOfficialDcNumber: invalid plantName id");
  }
  const fullKey = plantDcSequenceKey(pid);
  const sess = session || undefined;

  const existing = await InvoiceSequence.findOne({ key: fullKey }).session(sess).lean();
  if (!existing) {
    const base = await resolvePlantPrefix(pid, session);
    const prefix = await ensureUniquePlantPrefix(base, fullKey, session);
    await InvoiceSequence.updateOne(
      { key: fullKey },
      { $setOnInsert: { key: fullKey, prefix, nextNumber: 1 } },
      { upsert: true, session: sess }
    );
  }

  const updated = await InvoiceSequence.findOneAndUpdate(
    { key: fullKey },
    { $inc: { nextNumber: 1 } },
    { new: true, session: sess }
  ).lean();

  if (!updated) {
    throw new Error("allocateOfficialDcNumber: sequence document missing");
  }

  const seq = Math.max(1, Number(updated.nextNumber) - 1);
  const prefix =
    updated.prefix != null && String(updated.prefix).trim() !== ""
      ? String(updated.prefix).trim()
      : "PL";
  return `${prefix}${seq}`;
}

function resolvePlantIdFromOrder(orderDoc) {
  const lines = Array.isArray(orderDoc?.plantLineItems) ? orderDoc.plantLineItems : [];
  if (lines.length > 0) {
    const first = lines[0];
    const fromLine = first?.plantName?._id ?? first?.plantName;
    if (mongoose.isValidObjectId(String(fromLine))) return fromLine;
  }
  return orderDoc?.plantName?._id ?? orderDoc?.plantName;
}

/**
 * Returns existing official DC, or allocates and returns a new one (caller persists on $set).
 * Idempotent: if order already has officialDeliveryChallanNumber, returns it without consuming a new number.
 * Scope: one sequence per plant (Banana / Papaya / …); first line wins for multi-plant instant orders.
 */
export async function ensureOfficialDeliveryChallanForOrder(orderDoc, session) {
  const existing = String(orderDoc?.officialDeliveryChallanNumber || "").trim();
  if (existing) return existing;

  const plantRef = resolvePlantIdFromOrder(orderDoc);
  if (!mongoose.isValidObjectId(String(plantRef))) {
    console.error(
      "ensureOfficialDeliveryChallanForOrder: missing plant on order",
      orderDoc?._id
    );
    return null;
  }

  try {
    return await allocateOfficialDcNumber(session, plantRef);
  } catch (e) {
    console.error("ensureOfficialDeliveryChallanForOrder:", e?.message || e);
    return null;
  }
}
