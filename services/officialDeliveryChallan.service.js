import mongoose from "mongoose";
import PlantCms from "../models/plantCms.model.js";
import InvoiceSequence, {
  DC_BILLABLE_SEQUENCE_KEY,
  DC_NON_BILLABLE_SEQUENCE_KEY,
} from "../models/invoiceSequence.model.js";

/** @deprecated kept for reading legacy keys */
export function officialDcSequenceKey(plantNameId, plantSubtypeId) {
  return `dc_ps:${String(plantNameId)}:${String(plantSubtypeId)}`;
}

/** @deprecated Plant-scoped keys — use globalDcSequenceKey */
export function plantDcSequenceKey(plantNameId, billable = true) {
  const id = String(plantNameId);
  return billable ? `dc_plant:${id}` : `dc_plant_nb:${id}`;
}

const DEFAULT_DC_PREFIX = { billable: "B", nonBillable: "BN" };

export function globalDcSequenceKey(billable = true) {
  return billable !== false ? DC_BILLABLE_SEQUENCE_KEY : DC_NON_BILLABLE_SEQUENCE_KEY;
}

function defaultDcPrefix(billable = true) {
  return billable !== false ? DEFAULT_DC_PREFIX.billable : DEFAULT_DC_PREFIX.nonBillable;
}

/**
 * Allocate next official DC from the global billable or non-billable bucket.
 */
export async function allocateOfficialDcNumber(session, billable = true) {
  const isBillable = billable !== false;
  const fullKey = globalDcSequenceKey(isBillable);
  const sess = session || undefined;

  const existing = await InvoiceSequence.findOne({ key: fullKey }).session(sess).lean();
  if (!existing) {
    await InvoiceSequence.updateOne(
      { key: fullKey },
      {
        $setOnInsert: {
          key: fullKey,
          prefix: defaultDcPrefix(isBillable),
          nextNumber: 1,
        },
      },
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
      : defaultDcPrefix(isBillable);
  return `${prefix}${seq}`;
}

function plantIdFromRef(ref) {
  if (ref == null) return null;
  const id = ref?._id ?? ref;
  return mongoose.isValidObjectId(String(id)) ? id : null;
}

function subtypeIdFromRef(ref) {
  if (ref == null) return null;
  const id = ref?._id ?? ref;
  return id != null ? String(id) : null;
}

/**
 * Resolve billable vs non-billable plant buckets for an order.
 * Uses line.isBillable snapshot when set; otherwise PlantCms subtype.isBillable (default true).
 */
export async function resolveOrderDcBillableBuckets(orderDoc, session) {
  const sess = session || undefined;
  const lines = Array.isArray(orderDoc?.plantLineItems) ? orderDoc.plantLineItems : [];

  const entries = [];
  if (lines.length > 0) {
    for (const line of lines) {
      const plantId = plantIdFromRef(line?.plantName);
      const subtypeId = subtypeIdFromRef(line?.plantSubtype);
      if (!plantId) continue;
      entries.push({
        plantId,
        subtypeId,
        lineIsBillable:
          typeof line?.isBillable === "boolean" ? line.isBillable : null,
      });
    }
  } else {
    const plantId = plantIdFromRef(orderDoc?.plantName);
    const subtypeId = subtypeIdFromRef(orderDoc?.plantSubtype);
    if (plantId) {
      entries.push({ plantId, subtypeId, lineIsBillable: null });
    }
  }

  if (entries.length === 0) {
    return { hasBillable: false, hasNonBillable: false, billablePlantId: null, nonBillablePlantId: null };
  }

  const plantIds = [...new Set(entries.map((e) => String(e.plantId)))];
  const plants = await PlantCms.find({ _id: { $in: plantIds } })
    .select("subtypes._id subtypes.isBillable")
    .session(sess)
    .lean();
  const subtypeBillable = new Map();
  for (const p of plants) {
    for (const s of p.subtypes || []) {
      subtypeBillable.set(String(s._id), s.isBillable !== false);
    }
  }

  let hasBillable = false;
  let hasNonBillable = false;
  let billablePlantId = null;
  let nonBillablePlantId = null;

  for (const e of entries) {
    let billable = true;
    if (typeof e.lineIsBillable === "boolean") {
      billable = e.lineIsBillable;
    } else if (e.subtypeId && subtypeBillable.has(e.subtypeId)) {
      billable = subtypeBillable.get(e.subtypeId);
    }
    if (billable) {
      hasBillable = true;
      if (!billablePlantId) billablePlantId = e.plantId;
    } else {
      hasNonBillable = true;
      if (!nonBillablePlantId) nonBillablePlantId = e.plantId;
    }
  }

  if (!hasBillable && !hasNonBillable) {
    hasBillable = true;
    billablePlantId = entries[0].plantId;
  }

  return { hasBillable, hasNonBillable, billablePlantId, nonBillablePlantId };
}

/**
 * Allocate billable and/or non-billable official DCs as needed (idempotent per field).
 * @returns {{ billable: string|null, nonBillable: string|null }}
 */
export async function ensureOfficialDeliveryChallansForOrder(orderDoc, session) {
  const existingBillable = String(orderDoc?.officialDeliveryChallanNumber || "").trim();
  const existingNonBillable = String(
    orderDoc?.officialNonBillableDeliveryChallanNumber || ""
  ).trim();

  let buckets;
  try {
    buckets = await resolveOrderDcBillableBuckets(orderDoc, session);
  } catch (e) {
    console.error("ensureOfficialDeliveryChallansForOrder: classify failed", e?.message || e);
    return {
      billable: existingBillable || null,
      nonBillable: existingNonBillable || null,
    };
  }

  let billable = existingBillable || null;
  let nonBillable = existingNonBillable || null;

  try {
    if (buckets.hasBillable && !billable) {
      billable = await allocateOfficialDcNumber(session, true);
    }
    if (buckets.hasNonBillable && !nonBillable) {
      nonBillable = await allocateOfficialDcNumber(session, false);
    }
  } catch (e) {
    console.error("ensureOfficialDeliveryChallansForOrder:", e?.message || e);
  }

  return { billable, nonBillable };
}

/**
 * Apply ensure result onto a `$set` object (mutates and returns setFields).
 * @returns {{ billable: string|null, nonBillable: string|null, primaryLabel: string|null, setFields: object }}
 */
export async function ensureOfficialDcSetFields(orderDoc, session) {
  const dcs = await ensureOfficialDeliveryChallansForOrder(orderDoc, session);
  const setFields = {};
  if (dcs.billable) setFields.officialDeliveryChallanNumber = dcs.billable;
  if (dcs.nonBillable) setFields.officialNonBillableDeliveryChallanNumber = dcs.nonBillable;
  const primaryLabel = dcs.billable || dcs.nonBillable || null;
  return { ...dcs, primaryLabel, setFields };
}

/**
 * @deprecated Prefer ensureOfficialDeliveryChallansForOrder / ensureOfficialDcSetFields.
 */
export async function ensureOfficialDeliveryChallanForOrder(orderDoc, session) {
  const { billable, nonBillable } = await ensureOfficialDeliveryChallansForOrder(
    orderDoc,
    session
  );
  return billable || nonBillable || null;
}
