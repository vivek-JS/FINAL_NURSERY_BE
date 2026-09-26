import PlantSlot from "../models/slots.model.js";

/** Newest-first trails. Keep enough history for the UI without crossing the 16MB BSON cap. */
export const SLOT_TRAIL_KEEP = 40;

export function isResultingDocumentTooLarge(err) {
  const msg = String(err?.message || err?.errmsg || "");
  return msg.includes("larger than 16777216") || Number(err?.code) === 17419;
}

/**
 * Slice every slot's slotTrail on one PlantSlot document.
 * The update result is smaller than the current document, so it still succeeds
 * when the slot file is already near MongoDB's 16MB limit.
 */
function trailSliceExpression(keep) {
  if (keep <= 0) return [];
  return { $slice: [{ $ifNull: ["$$sl.slotTrail", []] }, keep] };
}

async function runTrailShrink(plantSlotId, keep, opts) {
  await PlantSlot.updateOne(
    { _id: plantSlotId },
    [
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
                            { slotTrail: trailSliceExpression(keep) },
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
    ],
    opts
  );
}

export async function shrinkPlantSlotTrails(plantSlotId, { session, keep = SLOT_TRAIL_KEEP } = {}) {
  if (!plantSlotId) return;
  const limit = Math.max(0, Number(keep) || SLOT_TRAIL_KEEP);
  const opts = session ? { session } : {};
  const attempts = [...new Set([limit, 10, 1, 0])].filter((n) => n <= limit);
  let lastErr;
  for (const n of attempts) {
    try {
      await runTrailShrink(plantSlotId, n, opts);
      return;
    } catch (err) {
      if (!isResultingDocumentTooLarge(err)) throw err;
      lastErr = err;
    }
  }
  if (lastErr) throw lastErr;
}

async function plantSlotIdFromFilter(filter, session) {
  if (!filter || typeof filter !== "object") return null;
  if (filter._id) return filter._id;
  const slotId = filter["subtypeSlots.slots._id"];
  if (!slotId) return null;
  let q = PlantSlot.findOne({ "subtypeSlots.slots._id": slotId }).select("_id");
  if (session) q = q.session(session);
  const doc = await q.lean();
  return doc?._id || null;
}

/** Run a PlantSlot update. If the slot file would exceed 16MB, trim trails and retry once. */
export async function updatePlantSlotCapped(filter, update, options = {}) {
  try {
    return await PlantSlot.updateOne(filter, update, options);
  } catch (err) {
    if (!isResultingDocumentTooLarge(err)) throw err;
    const plantSlotId = await plantSlotIdFromFilter(filter, options.session);
    if (!plantSlotId) throw err;
    await shrinkPlantSlotTrails(plantSlotId, {
      session: options.session,
      keep: Math.min(20, SLOT_TRAIL_KEEP),
    });
    return await PlantSlot.updateOne(filter, update, options);
  }
}

export function slotTrailPush(entry, keep = SLOT_TRAIL_KEEP) {
  return {
    $each: [entry],
    $position: 0,
    $slice: keep,
  };
}
