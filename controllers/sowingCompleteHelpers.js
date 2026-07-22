import mongoose from "mongoose";
import PlantSlot from "../models/slots.model.js";
import Order from "../models/order.model.js";
import InventoryOutward from "../models/inventoryOutward.model.js";
import ReturnRequest from "../models/returnRequest.model.js";
import PlantCms from "../models/plantCms.model.js";

export function parseNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function pushEvent(request, evt) {
  if (!Array.isArray(request.completionEvents)) request.completionEvents = [];
  request.completionEvents.push({
    at: new Date(),
    ...evt,
  });
}

function toObjectIds(ids) {
  return (ids || [])
    .map((id) => {
      try {
        return new mongoose.Types.ObjectId(id);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function fmtDDMMYYYY(d) {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}-${mm}-${yyyy}`;
}

function addDays(date, days) {
  const d = new Date(date.getTime());
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + Math.max(0, Number(days) || 0));
  return d;
}

function quickReturnRequestNumber(seq = 0) {
  const d = new Date();
  const ymd =
    String(d.getFullYear()).slice(-2) +
    String(d.getMonth() + 1).padStart(2, "0") +
    String(d.getDate()).padStart(2, "0");
  const tail = `${Date.now().toString(36)}${seq.toString(36)}${Math.random()
    .toString(36)
    .slice(2, 4)}`.toUpperCase();
  return `RR${ymd}${tail}`;
}

async function resolveCmsReadyDays(plantId, subtypeId) {
  if (!plantId || !subtypeId) return 0;
  try {
    const plant = await PlantCms.findById(plantId).select("subtypes").lean();
    const st = (plant?.subtypes || []).find(
      (s) => String(s._id || s.subtypeId) === String(subtypeId)
    );
    return Number(st?.plantReadyDays) || 0;
  } catch {
    return 0;
  }
}

/**
 * Fast path: lean weight read + atomic $inc/$set/$push/$pull.
 * Immediate availablePlants; also stamps sowingDate / plantReadyDate + sowingBatches.
 */
export async function applyPlantsToLinkedSlots(request, plantsSowed, meta = {}) {
  const slotIds = toObjectIds(request.linkedSlotIds);
  if (!slotIds.length || plantsSowed <= 0) return { slotsUpdated: 0 };

  const packetsUsedTotal = Math.max(0, Number(meta.packetsUsed) || 0);
  const requestNumber = meta.requestNumber || request.requestNumber || "";
  const shedName = String(meta.shedName || request.shedName || "").trim();
  const linkedOrderIds = toObjectIds(
    meta.linkedOrderIds || request.linkedOrderIds || []
  );
  const isExcess = Boolean(
    meta.isExcessiveSowing ?? request.isExcessiveSowing
  );

  const rows = await PlantSlot.aggregate([
    { $match: { "subtypeSlots.slots._id": { $in: slotIds } } },
    { $unwind: "$subtypeSlots" },
    { $unwind: "$subtypeSlots.slots" },
    { $match: { "subtypeSlots.slots._id": { $in: slotIds } } },
    {
      $project: {
        slotId: "$subtypeSlots.slots._id",
        plantId: "$plantId",
        subtypeId: "$subtypeSlots.subtypeId",
        plantReadyDays: "$subtypeSlots.slots.plantReadyDays",
        totalBookedPlants: "$subtypeSlots.slots.totalBookedPlants",
        primarySowed: "$subtypeSlots.slots.primarySowed",
        officeSowed: "$subtypeSlots.slots.officeSowed",
      },
    },
  ]);

  if (!rows.length) {
    throw new Error("No linked slots found to apply sowing");
  }

  const byId = new Map(rows.map((r) => [String(r.slotId), r]));
  const ordered = [];
  for (const id of slotIds) {
    const row = byId.get(String(id));
    if (row) ordered.push(row);
  }
  if (!ordered.length) ordered.push(...rows);

  let cmsReadyDays = null;
  const needsCms = ordered.some((r) => !(Number(r.plantReadyDays) > 0));
  if (needsCms) {
    cmsReadyDays = await resolveCmsReadyDays(
      request.plantId || ordered[0]?.plantId,
      request.subtypeId || ordered[0]?.subtypeId
    );
  }

  const sowedAt = new Date();
  const sowingDateStr = fmtDDMMYYYY(sowedAt);

  let weightSum = 0;
  const weights = ordered.map((row) => {
    let w = 1;
    if (!isExcess) {
      const booked = Number(row.totalBookedPlants) || 0;
      const sowed =
        (Number(row.primarySowed) || 0) + (Number(row.officeSowed) || 0);
      w = Math.max(1, booked - sowed);
    }
    weightSum += w;
    const readyDays =
      Number(row.plantReadyDays) > 0
        ? Number(row.plantReadyDays)
        : cmsReadyDays || 0;
    return { slotId: row.slotId, w, readyDays };
  });

  let remainingPlants = plantsSowed;
  let remainingPackets = packetsUsedTotal;
  const updates = [];

  for (let i = 0; i < weights.length; i++) {
    const row = weights[i];
    const isLast = i === weights.length - 1;
    const plantShare = isLast
      ? remainingPlants
      : Math.max(0, Math.round((plantsSowed * row.w) / weightSum));
    const addPlants = Math.min(plantShare, remainingPlants);
    remainingPlants -= addPlants;

    const pktShare = isLast
      ? remainingPackets
      : packetsUsedTotal > 0 && plantsSowed > 0
        ? Math.round((packetsUsedTotal * addPlants) / plantsSowed)
        : 0;
    const addPackets = Math.min(pktShare, remainingPackets);
    remainingPackets -= addPackets;

    if (addPlants <= 0) continue;

    const plantReadyDateStr = fmtDDMMYYYY(addDays(sowedAt, row.readyDays));

    const inc = {
      "subtypeSlots.$[st].slots.$[sl].primarySowed": addPlants,
      "subtypeSlots.$[st].slots.$[sl].availablePlants": addPlants,
      "subtypeSlots.$[st].slots.$[sl].totalPlants": addPlants,
      "subtypeSlots.$[st].slots.$[sl].plantsSowed": addPlants,
    };
    if (isExcess) {
      inc["subtypeSlots.$[st].slots.$[sl].excessiveSowing.plants"] = addPlants;
    }

    updates.push(
      PlantSlot.updateOne(
        { "subtypeSlots.slots._id": row.slotId },
        {
          $inc: inc,
          $set: {
            "subtypeSlots.$[st].slots.$[sl].sowingDate": sowingDateStr,
            "subtypeSlots.$[st].slots.$[sl].plantReadyDate": plantReadyDateStr,
            ...(row.readyDays > 0
              ? {
                  "subtypeSlots.$[st].slots.$[sl].plantReadyDays":
                    row.readyDays,
                }
              : {}),
          },
          $push: {
            "subtypeSlots.$[st].slots.$[sl].sowingBatches": {
              $each: [
                {
                  sowedAt,
                  sowingDate: sowingDateStr,
                  plantReadyDate: plantReadyDateStr,
                  plantReadyDays: row.readyDays,
                  plantsSowed: addPlants,
                  packetsUsed: addPackets,
                  shedName,
                  sowingRequestId: request._id,
                  requestNumber,
                  isExcessiveSowing: isExcess,
                  linkedOrderIds,
                },
              ],
              $position: 0,
              $slice: 200,
            },
          },
          $addToSet: {
            "subtypeSlots.$[st].slots.$[sl].linkedSowingRequests": request._id,
          },
          $pull: {
            "subtypeSlots.$[st].slots.$[sl].sowingInProgress": {
              sowingRequestId: request._id,
            },
          },
        },
        {
          arrayFilters: [
            { "st.slots._id": row.slotId },
            { "sl._id": row.slotId },
          ],
        }
      )
    );
  }

  if (updates.length) await Promise.all(updates);
  return { slotsUpdated: updates.length, sowingDate: sowingDateStr };
}

/**
 * Mark outward used + create pending ReturnRequest for inventory manager approval.
 */
export async function settleOutwardAndReturns(
  request,
  packetsUsed,
  packetsToReturn,
  userId
) {
  if (!request.outwardId) {
    return { used: 0, returned: 0, returnRequestIds: [], events: [] };
  }
  const companyShare =
    Number(request.packetsFromCompany) ||
    (request.seedSource === "RAISING" ? 0 : Number(request.packetsRequested) || 0);
  const canReturn = request.seedSource !== "RAISING" && companyShare > 0;

  const outward = await InventoryOutward.findById(request.outwardId)
    .select("items")
    .exec();
  if (!outward?.items?.length) {
    return { used: 0, returned: 0, returnRequestIds: [], events: [] };
  }

  let leftToUse = Math.max(0, packetsUsed);
  let leftToReturn = canReturn ? Math.max(0, packetsToReturn) : 0;
  let usedTotal = 0;
  let returnedTotal = 0;
  const returnDocs = [];
  const events = [];
  let rrSeq = 0;

  for (const item of outward.items) {
    const qty = Number(item.quantity) || 0;
    const already = Number(item.usedQuantity) || 0;
    const available = Math.max(0, qty - already);
    if (available <= 0) continue;

    const useNow = Math.min(available, leftToUse);
    if (useNow > 0) {
      item.usedQuantity = already + useNow;
      leftToUse -= useNow;
      usedTotal += useNow;
    }

    const stillAvail = Math.max(0, qty - (Number(item.usedQuantity) || 0));
    const retNow = Math.min(stillAvail, leftToReturn);
    if (retNow > 0.001) {
      const productId = item.product || request.productId;
      if (!productId) {
        throw new Error("Product missing for packet return");
      }
      if (!item.unit) {
        throw new Error("Outward item missing unit for packet return");
      }

      const requestNumber = quickReturnRequestNumber(rrSeq++);
      returnDocs.push({
        requestNumber,
        returnType: "sowing",
        product: productId,
        batch: item.batch || null,
        quantity: retNow,
        unit: item.unit,
        referenceType: "Sowing",
        referenceId: request._id,
        referenceNumber: request.requestNumber,
        outwardId: outward._id,
        itemId: item._id,
        originalQuantity: qty,
        usedQuantity: Number(item.usedQuantity) || 0,
        remainingQuantity: retNow,
        reason: "Sowing complete — unused company packets",
        remarks: `Pending return ${retNow} pkt from ${request.requestNumber}`,
        status: "pending",
        requestedBy: userId,
        metadata: {
          sowingRequestId: request._id,
          requestNumber: request.requestNumber,
          fromCompleteSow: true,
        },
      });

      item.usedQuantity = qty;
      leftToReturn -= retNow;
      returnedTotal += retNow;
    }
  }

  const [inserted] = await Promise.all([
    returnDocs.length
      ? ReturnRequest.insertMany(returnDocs, { ordered: false })
      : Promise.resolve([]),
    (usedTotal > 0 || returnedTotal > 0)
      ? (() => {
          outward.markModified("items");
          return outward.save();
        })()
      : Promise.resolve(null),
  ]);

  const returnRequestIds = (inserted || []).map((d) => d._id);
  for (const rr of inserted || []) {
    events.push({
      type: "PACKETS_RETURNED",
      by: userId,
      quantity: rr.quantity,
      unit: "pkt",
      message: `${rr.quantity} pkt return request created (pending inventory approval)`,
      meta: {
        returnRequestId: String(rr._id),
        returnRequestNumber: rr.requestNumber,
        status: "pending",
      },
    });
  }

  if (usedTotal > 0) {
    events.push({
      type: "PACKETS_USED",
      by: userId,
      quantity: usedTotal,
      unit: "pkt",
      message: `${usedTotal} packets used for sowing`,
    });
  }

  return { used: usedTotal, returned: returnedTotal, returnRequestIds, events };
}

export async function markOrdersSowed(request) {
  if (request.isExcessiveSowing) return { marked: 0 };
  const ids = request.linkedOrderIds || [];
  if (!ids.length) return { marked: 0 };

  const result = await Order.updateMany(
    {
      _id: { $in: ids },
      sowingDone: { $ne: true },
    },
    {
      $set: {
        sowingDone: true,
        sowingDoneAt: new Date(),
        sowingDoneRequestId: request._id,
      },
    }
  );
  return { marked: result.modifiedCount || 0 };
}

export async function uploadCompleteSowPhotos(files) {
  if (!files?.length) return [];
  try {
    const { uploadMultipleImagesToLocalStorage } = await import(
      "../utils/localStorageUtils.js"
    );
    const uploads = await uploadMultipleImagesToLocalStorage(
      files,
      "sowing-complete"
    );
    return (uploads || [])
      .filter((u) => u?.url)
      .map((u) => ({
        url: u.url,
        caption: "sowing-complete",
        uploadedAt: new Date(),
      }));
  } catch (err) {
    console.warn("[complete-sow] photo upload failed:", err.message);
    return [];
  }
}
