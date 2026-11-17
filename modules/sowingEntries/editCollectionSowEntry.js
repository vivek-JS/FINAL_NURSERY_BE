import mongoose from "mongoose";
import Order from "../../models/order.model.js";
import SowingEntry from "../../models/sowingEntry.model.js";
import {
  addDays,
  fmtDDMMYYYY,
  parseLocalDate,
  resolveCmsReadyDays,
  toSowYmd,
} from "../../controllers/sowingSlotReadyHelpers.js";
import { markOrdersSowed } from "../../controllers/sowingCompleteHelpers.js";
import { restamp } from "./leftoverSowingMath.js";

const int = (value) => Math.max(0, Math.floor(Number(value) || 0));

function daysBetween(from, to) {
  const start = parseLocalDate(from);
  const end = parseLocalDate(to);
  if (!start || !end) return 0;
  return Math.max(0, Math.round((end.getTime() - start.getTime()) / 86400000));
}

/**
 * Dates for an office edit. Ready date wins over ready days.
 * Returns null when neither a ready date nor ready days were sent.
 */
export function sowEditDates({
  sowDate,
  plantReadyDate,
  plantReadyDays,
  fromSowDate = "",
  fromReadyDate = "",
} = {}) {
  const sowedAt = parseLocalDate(sowDate) || parseLocalDate(fromSowDate) || new Date();
  const sowingDate = fmtDDMMYYYY(sowedAt);
  const sowDay = toSowYmd(sowedAt);
  const readyOverride = parseLocalDate(plantReadyDate);
  const fromPlantReadyDays = daysBetween(fromSowDate, fromReadyDate);
  if (readyOverride) {
    return {
      sowedAt,
      sowingDate,
      sowDay,
      readyDate: fmtDDMMYYYY(readyOverride),
      readyDays: Math.max(0, Math.round((readyOverride.getTime() - sowedAt.getTime()) / 86400000)),
      fromPlantReadyDays,
    };
  }
  const days = Number(plantReadyDays);
  if (Number.isFinite(days) && days >= 0) {
    return {
      sowedAt,
      sowingDate,
      sowDay,
      readyDays: days,
      readyDate: fmtDDMMYYYY(addDays(sowedAt, days)),
      fromPlantReadyDays,
    };
  }
  return null;
}

/**
 * The new grid shows plants still counted after destroy.
 * The stored sow quantity is that number plus plants already destroyed.
 */
export function grossFromGridQty(currentGross, destroyed, typed) {
  const gone = int(destroyed);
  const shown = int(typed);
  const gross = shown + gone;
  return { gross, changed: gross !== int(currentGross) };
}

function applyStamp(entry) {
  const stamped = restamp(entry.toObject());
  entry.bufferPlants = stamped.bufferPlants;
  entry.sowingBufferPct = stamped.sowingBufferPct;
  entry.excessPlants = stamped.excessPlants;
  entry.remainingPlants = stamped.remainingPlants;
}

async function orderIdsForEntry(request, entry) {
  const ids = new Set();
  for (const id of request?.linkedOrderIds || []) ids.add(String(id));
  for (const id of entry?.linkedOrderIds || []) ids.add(String(id));
  for (const row of entry?.orderCovers || []) ids.add(String(row?.orderId || ""));
  const extra = await Order.find({
    $or: [
      { sowingDoneRequestId: request._id },
      { "sowingPartialCover.requestId": request._id },
      { "sowingCoverSources.sowingRequestId": request._id },
    ],
  })
    .select("_id")
    .lean();
  for (const order of extra) ids.add(String(order._id));
  return [...ids]
    .filter((id) => mongoose.Types.ObjectId.isValid(id))
    .map((id) => new mongoose.Types.ObjectId(id));
}

async function clearRequestOrderCover(requestId, orderIds) {
  if (!requestId || !orderIds?.length) return;
  await Order.updateMany(
    { _id: { $in: orderIds }, sowingDoneRequestId: requestId },
    {
      $set: { sowingDone: false, leftoverFromIncomplete: false },
      $unset: { sowingDoneAt: "", sowingDoneRequestId: "" },
    }
  );
  await Order.updateMany(
    { _id: { $in: orderIds } },
    {
      $pull: {
        sowingPartialCover: { requestId },
        sowingCoverSources: { sowingRequestId: requestId },
      },
    }
  );
}

async function stampCoverSourceDates(requestId, sowingDate, readyDate) {
  await Order.updateMany(
    { "sowingCoverSources.sowingRequestId": requestId },
    {
      $set: {
        "sowingCoverSources.$[src].sowingDate": sowingDate,
        "sowingCoverSources.$[src].plantReadyDate": readyDate,
      },
    },
    { arrayFilters: [{ "src.sowingRequestId": requestId }] }
  );
}

function coversOrders(request, entry) {
  if (request?.isExcessiveSowing) return false;
  if (entry?.entryKind === "komb" || entry?.entryKind === "excess") return false;
  return (
    (entry?.linkedOrderIds || []).length > 0 ||
    (entry?.orderCovers || []).length > 0 ||
    (request?.linkedOrderIds || []).length > 0
  );
}

/**
 * Office edit for a sowing that was saved on sowingentries only.
 * New completes do not write a calendar slot batch.
 */
export async function editCollectionSowEntry(request, opts = {}) {
  const entry = await SowingEntry.findOne({ sowingRequestId: request._id });
  if (!entry) throw new Error("No sowing entry found for this request");

  const fromReadyDate = entry.plantReadyDate || "";
  const fromSowDate = entry.sowingDate || entry.sowDay || "";
  let dates = sowEditDates({
    sowDate: opts.sowDate,
    plantReadyDate: opts.plantReadyDate || opts.readyDate,
    plantReadyDays: opts.plantReadyDays,
    fromSowDate,
    fromReadyDate,
  });
  if (!dates) {
    const cmsReady = await resolveCmsReadyDays(request.plantId, request.subtypeId);
    const days = Math.max(0, Number(cmsReady) || 0);
    dates = sowEditDates({
      sowDate: opts.sowDate,
      plantReadyDays: days,
      fromSowDate,
      fromReadyDate,
    });
  }

  const { gross, changed } =
    opts.plantsSowed != null && Number(opts.plantsSowed) > 0
      ? grossFromGridQty(entry.plantsSowed, entry.destroyedPlants, opts.plantsSowed)
      : { gross: int(entry.plantsSowed), changed: false };

  const oldReady = String(entry.plantReadyDate || "");
  const outFollowsReady = !entry.out || entry.out === oldReady;
  const bufferPct = entry.noMortalityReserve ? 0 : Number(entry.sowingBufferPct) || 0;

  let orderResult = null;
  if (changed && coversOrders(request, entry)) {
    const orderIds = await orderIdsForEntry(request, entry);
    await clearRequestOrderCover(request._id, orderIds);
    orderResult = await markOrdersSowed(request, {
      sowedAt: dates.sowedAt,
      plantsSowed: gross,
      plantReadyDays: dates.readyDays,
      sowingBufferPct: bufferPct,
      orderIds,
    });
  }

  // Cover writes bump the document version. Reload so the final save is not rejected.
  const saved = orderResult ? await SowingEntry.findById(entry._id) : entry;
  if (!saved) throw new Error("No sowing entry found for this request");
  if (outFollowsReady) saved.out = dates.readyDate;
  saved.sowingDate = dates.sowingDate;
  saved.sowDay = dates.sowDay;
  saved.plantReadyDate = dates.readyDate;
  const year = Number(String(dates.sowDay).slice(0, 4));
  if (Number.isFinite(year) && year > 2000) saved.year = year;
  if (changed) {
    saved.plantsSowed = gross;
    if (orderResult) {
      saved.orderCoveredPlants = int(orderResult.orderPlantsCovered);
      saved.orderCovers = orderResult.orderCovers || [];
      saved.linkedOrderIds = orderResult.batchLinkedIds || [];
    }
    applyStamp(saved);
  }

  await stampCoverSourceDates(request._id, dates.sowingDate, dates.readyDate);
  await saved.save();

  request.sowedQuantity = int(saved.plantsSowed);
  request.sowingCompletedDate = dates.sowedAt;

  return {
    slotChanged: false,
    fromSlotId: null,
    toSlotId: null,
    fromReadyDate,
    toReadyDate: dates.readyDate,
    fromPlantReadyDays: dates.fromPlantReadyDays,
    toPlantReadyDays: dates.readyDays,
    sowingDate: dates.sowingDate,
    plantsSowed: int(saved.plantsSowed),
    orderCoveredPlants: int(saved.orderCoveredPlants),
    excessPlants: int(saved.excessPlants),
    ordersMarked: orderResult?.marked || 0,
    partialPlants: orderResult?.partial?.addPlants || 0,
    ordersMoved: { moved: 0, plants: 0, orderIds: [] },
  };
}
