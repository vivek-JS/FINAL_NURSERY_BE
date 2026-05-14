import mongoose from "mongoose";
import PlantCms from "../models/plantCms.model.js";
import InvoiceSequence from "../models/invoiceSequence.model.js";

export function officialDcSequenceKey(plantNameId, plantSubtypeId) {
  return `dc_ps:${String(plantNameId)}:${String(plantSubtypeId)}`;
}

function lettersOnlyUpper(s, maxLen) {
  const t = String(s || "").replace(/[^A-Za-z]/g, "").toUpperCase();
  return t.slice(0, maxLen);
}

function fallbackPrefixFromIds(plantNameId, plantSubtypeId) {
  const hex = (String(plantNameId) + String(plantSubtypeId)).replace(
    /[^a-fA-F0-9]/g,
    ""
  );
  let out = "";
  for (let i = 0; i < hex.length && out.length < 4; i += 1) {
    const n = parseInt(hex[i], 16);
    if (!Number.isFinite(n)) continue;
    out += String.fromCharCode(65 + (n % 26));
  }
  return (out + "DCXX").slice(0, 4);
}

async function resolveNamePrefix(plantNameId, plantSubtypeId, session) {
  const sess = session || undefined;
  const plant = await PlantCms.findById(plantNameId)
    .select("name subtypes")
    .session(sess)
    .lean();
  const stId = String(plantSubtypeId);
  let subName = "";
  if (plant?.subtypes?.length) {
    const st = plant.subtypes.find((x) => String(x._id) === stId);
    subName = st?.name || "";
  }
  const pLetters = lettersOnlyUpper(plant?.name || "", 3) || "PL";
  const sLetters = lettersOnlyUpper(subName || "", 2) || "ST";
  let base = `${pLetters.slice(0, 2)}${sLetters.slice(0, 2)}`.slice(0, 4);
  if (base.length < 2) {
    base = fallbackPrefixFromIds(plantNameId, plantSubtypeId);
  }
  return base;
}

async function ensureUniquePrefix(candidate, fullKey, session) {
  const sess = session || undefined;
  const candUpper = String(candidate || "DC")
    .replace(/[^A-Za-z]/g, "")
    .toUpperCase();
  let p = candUpper.slice(0, 4);
  if (p.length < 2) p = "DC";
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const clash = await InvoiceSequence.findOne({
      $and: [
        { key: { $regex: /^dc_ps:/ } },
        { prefix: p },
        { key: { $ne: fullKey } },
      ],
    })
      .session(sess)
      .select("key")
      .lean();
    if (!clash) return p;
    const suf = String.fromCharCode(65 + (attempt % 26));
    const raw = `${candUpper.slice(0, 3)}${suf}`;
    p = raw.slice(0, 4) || "DC";
  }
  const parts = String(fullKey).split(":");
  const pid = parts[1] || fullKey;
  const sid = parts[2] || fullKey;
  return fallbackPrefixFromIds(pid, sid);
}

/**
 * Allocate next official DC string for this plant+subtype bucket (PREFIX-00001).
 */
export async function allocateOfficialDcNumber(session, plantNameId, plantSubtypeId) {
  const pid = plantNameId?._id ?? plantNameId;
  const sid = plantSubtypeId?._id ?? plantSubtypeId;
  if (!mongoose.isValidObjectId(String(pid)) || !mongoose.isValidObjectId(String(sid))) {
    throw new Error("allocateOfficialDcNumber: invalid plantName or plantSubtype id");
  }
  const fullKey = officialDcSequenceKey(pid, sid);
  const sess = session || undefined;

  const existing = await InvoiceSequence.findOne({ key: fullKey })
    .session(sess)
    .lean();
  if (!existing) {
    const base = await resolveNamePrefix(pid, sid, session);
    const prefix = await ensureUniquePrefix(base, fullKey, session);
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

  if (!updated?.prefix) {
    throw new Error("allocateOfficialDcNumber: sequence document missing");
  }

  const seq = Math.max(1, Number(updated.nextNumber) - 1);
  const prefix =
    updated.prefix != null && String(updated.prefix).trim() !== ""
      ? String(updated.prefix).trim().toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4) || "DC"
      : "DC";
  const padded = String(seq).padStart(5, "0");
  return `${prefix}-${padded}`;
}

/**
 * Returns existing official DC, or allocates and returns a new one (caller persists on $set).
 * Idempotent: if order already has officialDeliveryChallanNumber, returns it without consuming a new number.
 */
export async function ensureOfficialDeliveryChallanForOrder(orderDoc, session) {
  const existing = String(orderDoc?.officialDeliveryChallanNumber || "").trim();
  if (existing) return existing;

  const plantRef = orderDoc.plantName?._id ?? orderDoc.plantName;
  const subRef = orderDoc.plantSubtype?._id ?? orderDoc.plantSubtype;
  if (!mongoose.isValidObjectId(String(plantRef)) || !mongoose.isValidObjectId(String(subRef))) {
    console.error(
      "ensureOfficialDeliveryChallanForOrder: missing plant/subtype on order",
      orderDoc?._id
    );
    return null;
  }

  try {
    return await allocateOfficialDcNumber(session, plantRef, subRef);
  } catch (e) {
    console.error("ensureOfficialDeliveryChallanForOrder:", e?.message || e);
    return null;
  }
}
