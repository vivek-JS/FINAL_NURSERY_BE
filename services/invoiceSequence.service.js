import InvoiceSequence, {
  DELIVERY_CHALLAN_SEQUENCE_KEY,
  DC_BILLABLE_SEQUENCE_KEY,
  DC_NON_BILLABLE_SEQUENCE_KEY,
  INV_BILLABLE_SEQUENCE_KEY,
  INV_NON_BILLABLE_SEQUENCE_KEY,
  PLANT_DC_SEQUENCE_KEY_PREFIX,
  PLANT_NB_DC_SEQUENCE_KEY_PREFIX,
} from "../models/invoiceSequence.model.js";
import Order from "../models/order.model.js";
import { globalDcSequenceKey } from "./officialDeliveryChallan.service.js";
import { globalInvoiceSequenceKey } from "./officialInvoice.service.js";

const GLOBAL_BUCKETS = [
  { kind: "dc", billable: true, key: DC_BILLABLE_SEQUENCE_KEY, defaultPrefix: "B", legacyKeyRegex: /^dc_plant:/ },
  {
    kind: "dc",
    billable: false,
    key: DC_NON_BILLABLE_SEQUENCE_KEY,
    defaultPrefix: "BN",
    legacyKeyRegex: /^dc_plant_nb:/,
  },
  {
    kind: "invoice",
    billable: true,
    key: INV_BILLABLE_SEQUENCE_KEY,
    defaultPrefix: "INV",
    legacyKeyRegex: /^inv_plant:/,
  },
  {
    kind: "invoice",
    billable: false,
    key: INV_NON_BILLABLE_SEQUENCE_KEY,
    defaultPrefix: "INN",
    legacyKeyRegex: /^inv_plant_nb:/,
  },
];

function normalizeKind(kind) {
  const k = String(kind || "dc").trim().toLowerCase();
  return k === "invoice" || k === "inv" || k === "tax_invoice" ? "invoice" : "dc";
}

function globalKeyFor(kind, billable) {
  return kind === "invoice"
    ? globalInvoiceSequenceKey(billable)
    : globalDcSequenceKey(billable);
}

function defaultPrefixFor(kind, billable) {
  const bucket = GLOBAL_BUCKETS.find(
    (b) => b.kind === kind && b.billable === (billable !== false)
  );
  return bucket?.defaultPrefix || (billable !== false ? "B" : "BN");
}

function parseTrailingNumber(label, prefix) {
  const s = String(label || "").trim();
  const p = String(prefix || "").trim();
  if (!s) return 0;
  if (p && s.toUpperCase().startsWith(p.toUpperCase())) {
    const n = Number(s.slice(p.length));
    return Number.isFinite(n) && n > 0 ? n : 0;
  }
  const m = s.match(/(\d+)$/);
  return m ? Math.max(0, Number(m[1]) || 0) : 0;
}

async function maxIssuedFromOrders(kind, billable) {
  const fields =
    kind === "invoice"
      ? billable
        ? ["officialInvoiceNumber", "manualInvoiceNumber"]
        : ["officialNonBillableInvoiceNumber", "manualNonBillableInvoiceNumber"]
      : billable
        ? ["officialDeliveryChallanNumber", "deliveryChallanInvoiceNumber"]
        : ["officialNonBillableDeliveryChallanNumber"];

  const orders = await Order.find({
    $or: fields.map((f) => ({ [f]: { $exists: true, $nin: [null, ""] } })),
  })
    .select(fields.join(" "))
    .lean();

  let max = 0;
  for (const o of orders) {
    for (const f of fields) {
      const v = String(o[f] || "").trim();
      if (!v) continue;
      max = Math.max(max, parseTrailingNumber(v));
    }
  }
  return max;
}

/**
 * One-time migration: seed global counters from legacy plant-scoped keys and issued order numbers.
 */
export async function migrateGlobalSequencesFromPlantKeys() {
  const legacyDocs = await InvoiceSequence.find({
    $or: [
      { key: { $regex: /^dc_plant(_nb)?:/ } },
      { key: { $regex: /^inv_plant(_nb)?:/ } },
      { key: DELIVERY_CHALLAN_SEQUENCE_KEY },
    ],
  }).lean();

  const legacyDeliveryChallan = legacyDocs.find((d) => d.key === DELIVERY_CHALLAN_SEQUENCE_KEY);

  for (const bucket of GLOBAL_BUCKETS) {
    const existing = await InvoiceSequence.findOne({ key: bucket.key }).lean();
    if (existing) continue;

    const matchingLegacy = legacyDocs.filter((d) => bucket.legacyKeyRegex.test(d.key));
    let maxNext = 1;
    let prefix = bucket.defaultPrefix;

    for (const doc of matchingLegacy) {
      maxNext = Math.max(maxNext, Number(doc.nextNumber) || 1);
      if (doc.prefix && String(doc.prefix).trim()) {
        prefix = String(doc.prefix).trim();
      }
    }

    if (bucket.kind === "dc" && bucket.billable && legacyDeliveryChallan) {
      maxNext = Math.max(maxNext, Number(legacyDeliveryChallan.nextNumber) || 1);
      if (legacyDeliveryChallan.prefix && String(legacyDeliveryChallan.prefix).trim()) {
        prefix = String(legacyDeliveryChallan.prefix).trim();
      }
    }

    const issuedMax = await maxIssuedFromOrders(bucket.kind, bucket.billable);
    maxNext = Math.max(maxNext, issuedMax + 1);

    await InvoiceSequence.updateOne(
      { key: bucket.key },
      {
        $setOnInsert: {
          key: bucket.key,
          prefix,
          nextNumber: Math.max(1, maxNext),
        },
      },
      { upsert: true }
    );
  }
}

function serializeBucket(kind, billable, doc) {
  const key = globalKeyFor(kind, billable);
  const prefix =
    doc?.prefix != null && String(doc.prefix).trim() !== ""
      ? String(doc.prefix).trim()
      : defaultPrefixFor(kind, billable);
  const nextNumber = doc ? Math.max(1, Number(doc.nextNumber) || 1) : 1;
  return {
    key,
    kind,
    billable: billable !== false,
    prefix,
    nextNumber,
    preview: `${prefix}${nextNumber}`,
    exists: Boolean(doc),
    updatedAt: doc?.updatedAt || null,
  };
}

/**
 * List all 4 global document sequences (DC + invoice × billable/non-billable).
 */
export async function listGlobalDocumentSequences() {
  await migrateGlobalSequencesFromPlantKeys();

  const keys = GLOBAL_BUCKETS.map((b) => b.key);
  const docs = await InvoiceSequence.find({ key: { $in: keys } }).lean();
  const byKey = new Map(docs.map((d) => [d.key, d]));

  return {
    dc: {
      billable: serializeBucket("dc", true, byKey.get(DC_BILLABLE_SEQUENCE_KEY)),
      nonBillable: serializeBucket("dc", false, byKey.get(DC_NON_BILLABLE_SEQUENCE_KEY)),
    },
    invoice: {
      billable: serializeBucket("invoice", true, byKey.get(INV_BILLABLE_SEQUENCE_KEY)),
      nonBillable: serializeBucket(
        "invoice",
        false,
        byKey.get(INV_NON_BILLABLE_SEQUENCE_KEY)
      ),
    },
  };
}

/**
 * Upsert prefix + nextNumber for one global sequence bucket.
 */
export async function setGlobalDocumentSequence({
  kind,
  billable = true,
  prefix,
  nextNumber,
}) {
  const seqKind = normalizeKind(kind);
  const isBillable = billable !== false && billable !== "false" && billable !== "nonBillable";
  const key = globalKeyFor(seqKind, isBillable);
  const p =
    prefix != null && String(prefix).trim() !== ""
      ? String(prefix).trim().slice(0, 24)
      : defaultPrefixFor(seqKind, isBillable);
  const nn = Math.max(1, Math.floor(Number(nextNumber) || 1));

  const updated = await InvoiceSequence.findOneAndUpdate(
    { key },
    { $set: { prefix: p, nextNumber: nn }, $setOnInsert: { key } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  ).lean();

  return serializeBucket(seqKind, isBillable, updated);
}

/** @deprecated Use listGlobalDocumentSequences */
export async function getInvoiceSequenceSettings() {
  const data = await listGlobalDocumentSequences();
  return data.dc.billable;
}

/** @deprecated Use setGlobalDocumentSequence */
export async function setInvoiceSequenceSettings({ prefix, nextNumber, kind, billable }) {
  return setGlobalDocumentSequence({
    kind: kind || "dc",
    billable: billable !== false,
    prefix,
    nextNumber,
  });
}

/** @deprecated Plant-scoped sequences removed */
export async function listPlantInvoiceSequences() {
  return [];
}

/** @deprecated Plant-scoped sequences removed — redirects to global */
export async function setPlantInvoiceSequence({ kind, billable, prefix, nextNumber }) {
  return setGlobalDocumentSequence({ kind, billable, prefix, nextNumber });
}

export {
  PLANT_DC_SEQUENCE_KEY_PREFIX,
  PLANT_NB_DC_SEQUENCE_KEY_PREFIX,
};
