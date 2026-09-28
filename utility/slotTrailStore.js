import mongoose from "mongoose";
import PlantSlot from "../models/slots.model.js";
import SlotTrail from "../models/slotTrail.model.js";

const INSERT_CHUNK = 400;

function asOid(id) {
  if (!id) return null;
  if (id instanceof mongoose.Types.ObjectId) return id;
  const s = String(id);
  return mongoose.Types.ObjectId.isValid(s) ? new mongoose.Types.ObjectId(s) : null;
}

function entryCreatedAt(entry) {
  const raw = entry?.createdAt || entry?.timestamp || entry?.at;
  const d = raw ? new Date(raw) : new Date();
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

function plainEntry(trail) {
  const entry =
    trail && typeof trail.toObject === "function" ? trail.toObject() : { ...(trail || {}) };
  delete entry._id;
  return entry;
}

export async function insertTrailRows(rows, session) {
  if (!rows?.length) return 0;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    const chunk = rows.slice(i, i + INSERT_CHUNK);
    const opts = { ordered: false };
    if (session) opts.session = session;
    await SlotTrail.insertMany(chunk, opts);
    inserted += chunk.length;
  }
  return inserted;
}

async function slotContext(slotId) {
  const slotOid = asOid(slotId);
  if (!slotOid) return null;
  const rows = await PlantSlot.aggregate([
    { $match: { "subtypeSlots.slots._id": slotOid } },
    { $unwind: "$subtypeSlots" },
    { $unwind: "$subtypeSlots.slots" },
    { $match: { "subtypeSlots.slots._id": slotOid } },
    {
      $project: {
        plantId: 1,
        year: 1,
        subtypeId: "$subtypeSlots.subtypeId",
        startDay: "$subtypeSlots.slots.startDay",
        endDay: "$subtypeSlots.slots.endDay",
      },
    },
    { $limit: 1 },
  ]);
  return rows[0] || null;
}

/** Write one history row outside the PlantSlot document. */
export async function recordSlotTrail(slotId, entry, session) {
  const slotOid = asOid(slotId);
  if (!slotOid || !entry) return null;
  const ctx = await slotContext(slotOid);
  const plain = plainEntry(entry);
  const doc = {
    plantSlotId: ctx?._id || null,
    plantId: ctx?.plantId || null,
    year: ctx?.year ?? null,
    subtypeId: ctx?.subtypeId || null,
    slotId: slotOid,
    startDay: ctx?.startDay || null,
    endDay: ctx?.endDay || null,
    action: plain.action || "UPDATE",
    entry: plain,
    createdAt: entryCreatedAt(plain),
  };
  const opts = session ? { session } : undefined;
  const saved = await SlotTrail.create([doc], opts);
  return saved[0];
}

/**
 * Copy in-memory slotTrail arrays onto SlotTrail, then clear them
 * so the PlantSlot save cannot grow past 16MB.
 */
export async function archiveEmbeddedTrailsFromDoc(plantSlotDoc) {
  const rows = [];
  for (const st of plantSlotDoc.subtypeSlots || []) {
    for (const sl of st.slots || []) {
      const trails = sl.slotTrail;
      if (!Array.isArray(trails) || trails.length === 0) continue;
      if (
        trails.some((t) => t?.action === "AVAILABLE_PLANTS_UPDATED") &&
        sl.availablePlantsMaterialized !== false
      ) {
        sl.availablePlantsMaterialized = true;
      }
      for (const trail of trails) {
        const entry = plainEntry(trail);
        rows.push({
          plantSlotId: plantSlotDoc._id,
          plantId: plantSlotDoc.plantId,
          year: plantSlotDoc.year,
          subtypeId: st.subtypeId,
          slotId: sl._id,
          startDay: sl.startDay,
          endDay: sl.endDay,
          action: entry.action || "UPDATE",
          entry,
          createdAt: entryCreatedAt(entry),
        });
      }
      sl.slotTrail = [];
    }
  }
  if (!rows.length) return 0;
  if (typeof plantSlotDoc.markModified === "function") {
    plantSlotDoc.markModified("subtypeSlots");
  }
  await insertTrailRows(rows);
  return rows.length;
}

function clearEmbeddedTrailPipeline() {
  return [
    {
      $set: {
        subtypeSlots: {
          $map: {
            input: { $ifNull: ["$subtypeSlots", []] },
            as: "st",
            in: {
              $mergeObjects: [
                "$$st",
                {
                  slots: {
                    $map: {
                      input: { $ifNull: ["$$st.slots", []] },
                      as: "sl",
                      in: {
                        $mergeObjects: [
                          "$$sl",
                          {
                            slotTrail: [],
                            availablePlantsMaterialized: {
                              $cond: [
                                {
                                  $or: [
                                    { $eq: ["$$sl.availablePlantsMaterialized", true] },
                                    {
                                      $in: [
                                        "AVAILABLE_PLANTS_UPDATED",
                                        {
                                          $ifNull: [
                                            {
                                              $map: {
                                                input: { $ifNull: ["$$sl.slotTrail", []] },
                                                as: "t",
                                                in: "$$t.action",
                                              },
                                            },
                                            [],
                                          ],
                                        },
                                      ],
                                    },
                                  ],
                                },
                                true,
                                { $ifNull: ["$$sl.availablePlantsMaterialized", false] },
                              ],
                            },
                          },
                        ],
                      },
                    },
                  },
                },
              ],
            },
          },
        },
      },
    },
  ];
}

/** Move every embedded trail off one PlantSlot file, then empty those arrays. */
export async function offloadEmbeddedSlotTrails(plantSlotId) {
  const id = asOid(plantSlotId);
  if (!id) return { moved: 0, afterBytes: null };
  const doc = await PlantSlot.collection.findOne({ _id: id });
  if (!doc) return { moved: 0, afterBytes: null };

  const rows = [];
  for (const st of doc.subtypeSlots || []) {
    for (const sl of st.slots || []) {
      for (const trail of sl.slotTrail || []) {
        const entry = plainEntry(trail);
        rows.push({
          plantSlotId: doc._id,
          plantId: doc.plantId,
          year: doc.year,
          subtypeId: st.subtypeId,
          slotId: sl._id,
          startDay: sl.startDay,
          endDay: sl.endDay,
          action: entry.action || "UPDATE",
          entry,
          createdAt: entryCreatedAt(entry),
        });
      }
    }
  }

  if (!rows.length) {
    const sizeRow = await PlantSlot.collection
      .aggregate([{ $match: { _id: id } }, { $project: { bytes: { $bsonSize: "$$ROOT" } } }])
      .toArray();
    return { moved: 0, afterBytes: sizeRow[0]?.bytes ?? null };
  }

  await insertTrailRows(rows);
  await PlantSlot.collection.updateOne({ _id: id }, clearEmbeddedTrailPipeline());
  const sizeRow = await PlantSlot.collection
    .aggregate([{ $match: { _id: id } }, { $project: { bytes: { $bsonSize: "$$ROOT" } } }])
    .toArray();
  return { moved: rows.length, afterBytes: sizeRow[0]?.bytes ?? null };
}

/** History rows shaped like the old embedded slotTrail unwind. */
export async function loadSlotTrailView(slotId, limit = 400) {
  const slotOid = asOid(slotId);
  if (!slotOid) return [];
  const rows = await SlotTrail.find({ slotId: slotOid })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
  if (!rows.length) return [];

  const userIds = [
    ...new Set(
      rows
        .map((r) => r.entry?.performedBy)
        .filter((id) => id && mongoose.Types.ObjectId.isValid(String(id)))
        .map((id) => String(id))
    ),
  ].map((id) => new mongoose.Types.ObjectId(id));

  const users = userIds.length
    ? await mongoose.connection
        .collection("users")
        .find({ _id: { $in: userIds } })
        .project({ name: 1, phoneNumber: 1 })
        .toArray()
    : [];
  const byId = new Map(users.map((u) => [String(u._id), u]));

  return rows.map((r) => {
    const entry = r.entry || {};
    const info = entry.performedBy ? byId.get(String(entry.performedBy)) : null;
    return {
      slotTrail: {
        ...entry,
        createdAt: entry.createdAt || r.createdAt,
        updatedAt: entry.updatedAt || r.updatedAt || r.createdAt,
        performedByInfo: info || null,
      },
    };
  });
}
