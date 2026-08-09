import mongoose from "mongoose";
import Order from "../models/order.model.js";
import PlantSlot from "../models/slots.model.js";
import { ORDER_COVER_WINDOW_DAYS } from "./sowingCompleteHelpers.js";
import {
  parseLocalDate,
  fmtDDMMYYYY,
  findSlotByPlantReadyDate,
} from "./sowingSlotReadyHelpers.js";
import { writeTransferAudit } from "./sowingTransferAudit.helpers.js";

/** Look back N days from delivery (inclusive of delivery day). No future days. */
const LOOKBACK_DAYS = ORDER_COVER_WINDOW_DAYS;

export function isOfficeOrSuper(user) {
  const t = String(user?.jobTitle || user?.role || "").toUpperCase();
  return (
    t === "SUPER_ADMIN" ||
    t === "SUPERADMIN" ||
    t === "OFFICE_ADMIN" ||
    t === "OFFICEADMIN"
  );
}

export function orderPlantsNeed(order) {
  return (
    (Number(order?.numberOfPlants) || 0) + (Number(order?.additionalPlants) || 0)
  );
}

function slotLabel(slot) {
  if (!slot) return "—";
  if (!slot.endDay || slot.startDay === slot.endDay) return slot.startDay || "—";
  return `${slot.startDay} → ${slot.endDay}`;
}

function dayStartMs(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x.getTime();
}

function offsetLabel(off) {
  if (off === 0) return "delivery day";
  if (off > 0) return `+${off}d`;
  return `${off}d`;
}

/**
 * Resolve destination day slot: bookingSlot if present, else calendar slot for delivery date.
 */
export async function resolveDestinationSlot({
  plantId,
  subtypeId,
  deliveryDate,
  bookingSlotId,
}) {
  if (bookingSlotId && mongoose.Types.ObjectId.isValid(String(bookingSlotId))) {
    const sid = new mongoose.Types.ObjectId(bookingSlotId);
    const rows = await PlantSlot.aggregate([
      { $match: { plantId: new mongoose.Types.ObjectId(plantId) } },
      { $unwind: "$subtypeSlots" },
      {
        $match: {
          "subtypeSlots.subtypeId": new mongoose.Types.ObjectId(subtypeId),
        },
      },
      { $unwind: "$subtypeSlots.slots" },
      { $match: { "subtypeSlots.slots._id": sid } },
      {
        $project: {
          slotId: "$subtypeSlots.slots._id",
          startDay: "$subtypeSlots.slots.startDay",
          endDay: "$subtypeSlots.slots.endDay",
          availablePlants: {
            $ifNull: ["$subtypeSlots.slots.availablePlants", 0],
          },
          orderReservedPlants: {
            $ifNull: ["$subtypeSlots.slots.orderReservedPlants", 0],
          },
        },
      },
      { $limit: 1 },
    ]);
    if (rows[0]) {
      return {
        slotId: rows[0].slotId,
        startDay: rows[0].startDay,
        endDay: rows[0].endDay,
        availablePlants: Number(rows[0].availablePlants) || 0,
        orderReservedPlants: Number(rows[0].orderReservedPlants) || 0,
        label: slotLabel(rows[0]),
        fromBooking: true,
      };
    }
  }

  const found = await findSlotByPlantReadyDate(
    plantId,
    subtypeId,
    deliveryDate
  );
  if (!found?.slotId) return null;

  const rows = await PlantSlot.aggregate([
    { $match: { plantId: new mongoose.Types.ObjectId(plantId) } },
    { $unwind: "$subtypeSlots" },
    {
      $match: {
        "subtypeSlots.subtypeId": new mongoose.Types.ObjectId(subtypeId),
      },
    },
    { $unwind: "$subtypeSlots.slots" },
    { $match: { "subtypeSlots.slots._id": found.slotId } },
    {
      $project: {
        slotId: "$subtypeSlots.slots._id",
        startDay: "$subtypeSlots.slots.startDay",
        endDay: "$subtypeSlots.slots.endDay",
        availablePlants: {
          $ifNull: ["$subtypeSlots.slots.availablePlants", 0],
        },
        orderReservedPlants: {
          $ifNull: ["$subtypeSlots.slots.orderReservedPlants", 0],
        },
      },
    },
    { $limit: 1 },
  ]);
  const row = rows[0];
  if (!row) {
    return {
      slotId: found.slotId,
      startDay: found.startDay || null,
      endDay: found.endDay || null,
      availablePlants: 0,
      orderReservedPlants: 0,
      label: found.startDay || "—",
      fromBooking: false,
    };
  }
  return {
    slotId: row.slotId,
    startDay: row.startDay,
    endDay: row.endDay,
    availablePlants: Number(row.availablePlants) || 0,
    orderReservedPlants: Number(row.orderReservedPlants) || 0,
    label: slotLabel(row),
    fromBooking: false,
  };
}

/**
 * Saleable slots for plant+subtype with startDay in [delivery−lookback, delivery]
 * (offsets −lookback … 0 only).
 */
async function loadSourceSlotsInLookback({
  plantId,
  subtypeId,
  deliveryDate,
  bookingSlotId,
  lookbackDays = LOOKBACK_DAYS,
}) {
  if (!plantId || !subtypeId || !deliveryDate) {
    return {
      slots: [],
      windowDays: LOOKBACK_DAYS,
      coverFrom: "—",
      coverTo: "—",
      deliveryAnchor: "—",
    };
  }

  const anchor = parseLocalDate(deliveryDate) || new Date(deliveryDate);
  if (!anchor || Number.isNaN(anchor.getTime())) {
    return {
      slots: [],
      windowDays: LOOKBACK_DAYS,
      coverFrom: "—",
      coverTo: "—",
      deliveryAnchor: "—",
    };
  }

  const win = Math.max(0, Math.floor(Number(lookbackDays) || 0));
  const from = new Date(anchor);
  from.setHours(0, 0, 0, 0);
  from.setDate(from.getDate() - win);
  const to = new Date(anchor);
  to.setHours(23, 59, 59, 999);

  const fromMs = dayStartMs(from);
  const toMs = dayStartMs(to);
  const anchorMs = dayStartMs(anchor);
  const bookingStr = bookingSlotId ? String(bookingSlotId) : null;

  const rows = await PlantSlot.aggregate([
    {
      $match: {
        plantId: new mongoose.Types.ObjectId(plantId),
      },
    },
    { $unwind: "$subtypeSlots" },
    {
      $match: {
        "subtypeSlots.subtypeId": new mongoose.Types.ObjectId(subtypeId),
      },
    },
    { $unwind: "$subtypeSlots.slots" },
    {
      $project: {
        slotId: "$subtypeSlots.slots._id",
        startDay: "$subtypeSlots.slots.startDay",
        endDay: "$subtypeSlots.slots.endDay",
        availablePlants: {
          $ifNull: ["$subtypeSlots.slots.availablePlants", 0],
        },
        orderReservedPlants: {
          $ifNull: ["$subtypeSlots.slots.orderReservedPlants", 0],
        },
        excessivePlants: {
          $ifNull: ["$subtypeSlots.slots.excessiveSowing.plants", 0],
        },
      },
    },
  ]);

  const inWindow = [];
  for (const sl of rows) {
    const start = parseLocalDate(sl.startDay);
    if (!start) continue;
    const ms = dayStartMs(start);
    if (ms < fromMs || ms > toMs) continue;
    const offsetDays = Math.round((ms - anchorMs) / 86400000);
    // Only delivery day and earlier (no +Nd)
    if (offsetDays > 0 || offsetDays < -win) continue;
    const available = Math.max(0, Number(sl.availablePlants) || 0);
    inWindow.push({
      slotId: sl.slotId,
      startDay: sl.startDay,
      endDay: sl.endDay,
      availablePlants: available,
      orderReservedPlants: Number(sl.orderReservedPlants) || 0,
      excessivePlants: Number(sl.excessivePlants) || 0,
      offsetDays,
      isBookingSlot: bookingStr && String(sl.slotId) === bookingStr,
      label: slotLabel(sl),
    });
  }

  // Booking/same-day first, then latest prior (closest to 0 among negatives), then higher available
  inWindow.sort((a, b) => {
    if (a.isBookingSlot !== b.isBookingSlot) return a.isBookingSlot ? -1 : 1;
    if (a.offsetDays === 0 && b.offsetDays !== 0) return -1;
    if (b.offsetDays === 0 && a.offsetDays !== 0) return 1;
    // Both prior: prefer closer to delivery (less negative)
    if (a.offsetDays !== b.offsetDays) return b.offsetDays - a.offsetDays;
    return b.availablePlants - a.availablePlants;
  });

  return {
    slots: inWindow,
    windowDays: win,
    coverFrom: fmtDDMMYYYY(from),
    coverTo: fmtDDMMYYYY(anchor),
    deliveryAnchor: fmtDDMMYYYY(anchor),
  };
}

/**
 * All saleable slots for plant+subtype (any date). Optional delivery anchor for offsetDays.
 */
export async function loadAllAvailableSourceSlots({
  plantId,
  subtypeId,
  deliveryDate,
  bookingSlotId,
}) {
  if (!plantId || !subtypeId) {
    return {
      slots: [],
      windowDays: 0,
      coverFrom: "—",
      coverTo: "—",
      deliveryAnchor: "—",
      allAvailable: true,
    };
  }

  const anchor = deliveryDate
    ? parseLocalDate(deliveryDate) || new Date(deliveryDate)
    : null;
  const anchorMs = anchor && !Number.isNaN(anchor.getTime()) ? dayStartMs(anchor) : null;
  const bookingStr = bookingSlotId ? String(bookingSlotId) : null;

  const rows = await PlantSlot.aggregate([
    { $match: { plantId: new mongoose.Types.ObjectId(plantId) } },
    { $unwind: "$subtypeSlots" },
    {
      $match: {
        "subtypeSlots.subtypeId": new mongoose.Types.ObjectId(subtypeId),
      },
    },
    { $unwind: "$subtypeSlots.slots" },
    {
      $project: {
        slotId: "$subtypeSlots.slots._id",
        startDay: "$subtypeSlots.slots.startDay",
        endDay: "$subtypeSlots.slots.endDay",
        availablePlants: {
          $ifNull: ["$subtypeSlots.slots.availablePlants", 0],
        },
        orderReservedPlants: {
          $ifNull: ["$subtypeSlots.slots.orderReservedPlants", 0],
        },
        excessivePlants: {
          $ifNull: ["$subtypeSlots.slots.excessiveSowing.plants", 0],
        },
      },
    },
  ]);

  const out = [];
  for (const sl of rows) {
    const available = Math.max(0, Number(sl.availablePlants) || 0);
    if (available <= 0) continue;
    const start = parseLocalDate(sl.startDay);
    const ms = start ? dayStartMs(start) : null;
    const offsetDays =
      anchorMs != null && ms != null
        ? Math.round((ms - anchorMs) / 86400000)
        : null;
    out.push({
      slotId: sl.slotId,
      startDay: sl.startDay,
      endDay: sl.endDay,
      availablePlants: available,
      orderReservedPlants: Number(sl.orderReservedPlants) || 0,
      excessivePlants: Number(sl.excessivePlants) || 0,
      offsetDays,
      isBookingSlot: bookingStr && String(sl.slotId) === bookingStr,
      label: slotLabel(sl),
    });
  }

  out.sort((a, b) => {
    if (a.isBookingSlot !== b.isBookingSlot) return a.isBookingSlot ? -1 : 1;
    if (a.offsetDays != null && b.offsetDays != null && a.offsetDays !== b.offsetDays) {
      return b.offsetDays - a.offsetDays;
    }
    return b.availablePlants - a.availablePlants;
  });

  return {
    slots: out,
    windowDays: 0,
    coverFrom: "any",
    coverTo: anchorMs != null ? fmtDDMMYYYY(anchor) : "—",
    deliveryAnchor: anchorMs != null ? fmtDDMMYYYY(anchor) : "—",
    allAvailable: true,
  };
}

/** Load specific source slots by id (validates plant+subtype + availablePlants). */
export async function loadSourceSlotsByIds({
  plantId,
  subtypeId,
  slotIds,
  deliveryDate,
  bookingSlotId,
}) {
  const ids = [...new Set((slotIds || []).map(String).filter(Boolean))].filter(
    (id) => mongoose.Types.ObjectId.isValid(id)
  );
  if (!ids.length) return [];

  const anchor = deliveryDate
    ? parseLocalDate(deliveryDate) || new Date(deliveryDate)
    : null;
  const anchorMs = anchor && !Number.isNaN(anchor.getTime()) ? dayStartMs(anchor) : null;
  const bookingStr = bookingSlotId ? String(bookingSlotId) : null;
  const oid = ids.map((id) => new mongoose.Types.ObjectId(id));

  const rows = await PlantSlot.aggregate([
    { $match: { plantId: new mongoose.Types.ObjectId(plantId) } },
    { $unwind: "$subtypeSlots" },
    {
      $match: {
        "subtypeSlots.subtypeId": new mongoose.Types.ObjectId(subtypeId),
      },
    },
    { $unwind: "$subtypeSlots.slots" },
    { $match: { "subtypeSlots.slots._id": { $in: oid } } },
    {
      $project: {
        slotId: "$subtypeSlots.slots._id",
        startDay: "$subtypeSlots.slots.startDay",
        endDay: "$subtypeSlots.slots.endDay",
        availablePlants: {
          $ifNull: ["$subtypeSlots.slots.availablePlants", 0],
        },
        orderReservedPlants: {
          $ifNull: ["$subtypeSlots.slots.orderReservedPlants", 0],
        },
        excessivePlants: {
          $ifNull: ["$subtypeSlots.slots.excessiveSowing.plants", 0],
        },
      },
    },
  ]);

  return rows.map((sl) => {
    const start = parseLocalDate(sl.startDay);
    const ms = start ? dayStartMs(start) : null;
    const offsetDays =
      anchorMs != null && ms != null
        ? Math.round((ms - anchorMs) / 86400000)
        : null;
    return {
      slotId: sl.slotId,
      startDay: sl.startDay,
      endDay: sl.endDay,
      availablePlants: Math.max(0, Number(sl.availablePlants) || 0),
      orderReservedPlants: Number(sl.orderReservedPlants) || 0,
      excessivePlants: Number(sl.excessivePlants) || 0,
      offsetDays,
      isBookingSlot: bookingStr && String(sl.slotId) === bookingStr,
      label: slotLabel(sl),
    };
  });
}

export function planTransfers(slots, need, destination) {
  let remaining = Math.max(0, Math.floor(Number(need) || 0));
  const transfers = [];
  const destId = destination?.slotId ? String(destination.slotId) : null;
  const destLabel = destination?.label || "delivery slot";

  for (const sl of slots) {
    if (remaining <= 0) break;
    const take = Math.min(
      remaining,
      Math.max(0, Number(sl.availablePlants) || 0)
    );
    if (take <= 0) continue;
    transfers.push({
      fromSlotId: sl.slotId,
      fromLabel: sl.label,
      toSlotId: destination?.slotId || sl.slotId,
      toLabel: destLabel,
      offsetDays: sl.offsetDays,
      take,
      availableBefore: sl.availablePlants,
      excessDec: Math.min(take, Math.max(0, Number(sl.excessivePlants) || 0)),
      sameSlot: destId && String(sl.slotId) === destId,
    });
    remaining -= take;
  }
  return { transfers, remaining, covered: need - remaining };
}

/**
 * Build transfers from client picks: [{ fromSlotId, plants }].
 * Multi source slots → one destination.
 */
function resolveManualTransfers(picks, slots, need, destination, { allowAnySource = false } = {}) {
  const destId = destination?.slotId ? String(destination.slotId) : null;
  const destLabel = destination?.label || "delivery slot";
  const byId = new Map((slots || []).map((s) => [String(s.slotId), s]));
  const transfers = [];
  let remaining = Math.max(0, Math.floor(Number(need) || 0));
  let taken = 0;

  const list = Array.isArray(picks) ? picks : [];
  for (const raw of list) {
    const id = String(raw?.fromSlotId || raw?.slotId || "");
    const want = Math.max(0, Math.floor(Number(raw?.plants ?? raw?.take) || 0));
    if (!id || want <= 0) continue;
    const sl = byId.get(id);
    if (!sl) {
      if (allowAnySource) {
        return {
          ok: false,
          code: "INVALID_SOURCE_SLOT",
          message: `Source slot ${id} not found or has no saleable stock for this plant/subtype`,
          transfers: [],
          remaining: need,
          covered: 0,
          needsSlotLoad: true,
          missingSlotIds: [id],
        };
      }
      return {
        ok: false,
        code: "INVALID_SOURCE_SLOT",
        message: `Source slot ${id} is not in the delivery−${LOOKBACK_DAYS}d window. Use includeAllAvailable or pick a slot in window.`,
        transfers: [],
        remaining: need,
        covered: 0,
      };
    }
    const avail = Math.max(0, Number(sl.availablePlants) || 0);
    if (want > avail) {
      return {
        ok: false,
        code: "INSUFFICIENT_SLOT_EXCESS",
        message: `${sl.label} only has ${avail.toLocaleString("en-IN")} saleable (asked ${want.toLocaleString("en-IN")})`,
        transfers: [],
        remaining: need,
        covered: 0,
      };
    }
    transfers.push({
      fromSlotId: sl.slotId,
      fromLabel: sl.label,
      toSlotId: destination?.slotId || sl.slotId,
      toLabel: destLabel,
      offsetDays: sl.offsetDays,
      take: want,
      availableBefore: avail,
      excessDec: Math.min(want, Math.max(0, Number(sl.excessivePlants) || 0)),
      sameSlot: destId && String(sl.slotId) === destId,
    });
    taken += want;
  }

  remaining = Math.max(0, need - taken);
  if (taken < need) {
    return {
      ok: false,
      code: "INSUFFICIENT_SLOT_EXCESS",
      message: `Selected slots cover ${taken.toLocaleString("en-IN")} of ${need.toLocaleString("en-IN")} needed`,
      transfers,
      remaining,
      covered: taken,
    };
  }
  if (taken > need) {
    return {
      ok: false,
      code: "OVER_ALLOCATED",
      message: `Selected ${taken.toLocaleString("en-IN")} exceeds need ${need.toLocaleString("en-IN")}`,
      transfers,
      remaining: 0,
      covered: taken,
    };
  }
  return { ok: true, transfers, remaining: 0, covered: taken };
}

/** Resolve manual picks; loads slots outside lookback window from DB when needed. */
export async function resolveManualTransfersAsync(
  picks,
  windowSlots,
  need,
  destination,
  { plantId, subtypeId, deliveryDate, bookingSlotId } = {}
) {
  let slots = [...(windowSlots || [])];
  let manual = resolveManualTransfers(picks, slots, need, destination, {
    allowAnySource: true,
  });

  if (manual.ok || !manual.needsSlotLoad) return manual;

  const pickIds = (Array.isArray(picks) ? picks : [])
    .map((p) => String(p?.fromSlotId || p?.slotId || ""))
    .filter(Boolean);
  const loaded = await loadSourceSlotsByIds({
    plantId,
    subtypeId,
    slotIds: pickIds,
    deliveryDate,
    bookingSlotId,
  });
  const merged = new Map(slots.map((s) => [String(s.slotId), s]));
  for (const sl of loaded) merged.set(String(sl.slotId), sl);
  slots = [...merged.values()];
  return resolveManualTransfers(picks, slots, need, destination, {
    allowAnySource: true,
  });
}

/**
 * Transfer: source available↓ (+ optional excess↓); dest orderReserved↑.
 * Same-slot: available↓ + reserved↑ on that slot.
 */
export async function applyTransfer(tr) {
  const take = tr.take;
  const fromId = new mongoose.Types.ObjectId(tr.fromSlotId);
  const toId = new mongoose.Types.ObjectId(tr.toSlotId);

  if (tr.sameSlot || String(tr.fromSlotId) === String(tr.toSlotId)) {
    const result = await PlantSlot.updateOne(
      {
        "subtypeSlots.slots._id": fromId,
        "subtypeSlots.slots.availablePlants": { $gte: take },
      },
      {
        $inc: {
          "subtypeSlots.$[st].slots.$[sl].availablePlants": -take,
          "subtypeSlots.$[st].slots.$[sl].orderReservedPlants": take,
          ...(tr.excessDec > 0
            ? {
                "subtypeSlots.$[st].slots.$[sl].excessiveSowing.plants":
                  -tr.excessDec,
              }
            : {}),
        },
      },
      {
        arrayFilters: [{ "st.slots._id": fromId }, { "sl._id": fromId }],
      }
    );
    return result.modifiedCount > 0;
  }

  const src = await PlantSlot.updateOne(
    {
      "subtypeSlots.slots._id": fromId,
      "subtypeSlots.slots.availablePlants": { $gte: take },
    },
    {
      $inc: {
        "subtypeSlots.$[st].slots.$[sl].availablePlants": -take,
        ...(tr.excessDec > 0
          ? {
              "subtypeSlots.$[st].slots.$[sl].excessiveSowing.plants":
                -tr.excessDec,
            }
          : {}),
      },
    },
    {
      arrayFilters: [{ "st.slots._id": fromId }, { "sl._id": fromId }],
    }
  );
  if (!src.modifiedCount) return false;

  const dest = await PlantSlot.updateOne(
    { "subtypeSlots.slots._id": toId },
    {
      $inc: {
        "subtypeSlots.$[st].slots.$[sl].orderReservedPlants": take,
      },
    },
    {
      arrayFilters: [{ "st.slots._id": toId }, { "sl._id": toId }],
    }
  );
  if (!dest.modifiedCount) {
    // Roll back source only for this take
    await PlantSlot.updateOne(
      { "subtypeSlots.slots._id": fromId },
      {
        $inc: {
          "subtypeSlots.$[st].slots.$[sl].availablePlants": take,
          ...(tr.excessDec > 0
            ? {
                "subtypeSlots.$[st].slots.$[sl].excessiveSowing.plants":
                  tr.excessDec,
              }
            : {}),
        },
      },
      {
        arrayFilters: [{ "st.slots._id": fromId }, { "sl._id": fromId }],
      }
    );
    return false;
  }
  return true;
}

export async function reverseTransfers(transfers) {
  for (const tr of [...transfers].reverse()) {
    const take = tr.take;
    const fromId = new mongoose.Types.ObjectId(tr.fromSlotId);
    const toId = new mongoose.Types.ObjectId(tr.toSlotId);

    if (tr.sameSlot || String(tr.fromSlotId) === String(tr.toSlotId)) {
      await PlantSlot.updateOne(
        { "subtypeSlots.slots._id": fromId },
        {
          $inc: {
            "subtypeSlots.$[st].slots.$[sl].availablePlants": take,
            "subtypeSlots.$[st].slots.$[sl].orderReservedPlants": -take,
            ...(tr.excessDec > 0
              ? {
                  "subtypeSlots.$[st].slots.$[sl].excessiveSowing.plants":
                    tr.excessDec,
                }
              : {}),
          },
        },
        {
          arrayFilters: [{ "st.slots._id": fromId }, { "sl._id": fromId }],
        }
      );
      continue;
    }

    await PlantSlot.updateOne(
      { "subtypeSlots.slots._id": toId },
      {
        $inc: {
          "subtypeSlots.$[st].slots.$[sl].orderReservedPlants": -take,
        },
      },
      {
        arrayFilters: [{ "st.slots._id": toId }, { "sl._id": toId }],
      }
    );
    await PlantSlot.updateOne(
      { "subtypeSlots.slots._id": fromId },
      {
        $inc: {
          "subtypeSlots.$[st].slots.$[sl].availablePlants": take,
          ...(tr.excessDec > 0
            ? {
                "subtypeSlots.$[st].slots.$[sl].excessiveSowing.plants":
                  tr.excessDec,
              }
            : {}),
        },
      },
      {
        arrayFilters: [{ "st.slots._id": fromId }, { "sl._id": fromId }],
      }
    );
  }
}

function buildPreviewPayload(order, windowInfo, need, destination, extra = {}) {
  const slots = windowInfo.slots || [];
  const totalAvailable = slots.reduce((s, x) => s + (x.availablePlants || 0), 0);
  const { transfers, remaining, covered } = planTransfers(
    slots,
    need,
    destination
  );
  const canCover = need > 0 && remaining <= 0 && Boolean(destination?.slotId);
  const windowLabel = `${windowInfo.coverFrom} → ${windowInfo.coverTo} (delivery −${windowInfo.windowDays}d…0)`;

  const slotLines = slots
    .filter((s) => s.availablePlants > 0 || s.isBookingSlot)
    .map(
      (s) =>
        `${s.label} (${offsetLabel(s.offsetDays)}): ${s.availablePlants.toLocaleString("en-IN")}`
    );

  let message;
  if (!destination?.slotId) {
    message = "No delivery/booking slot found to receive transferred plants";
  } else if (canCover) {
    message = `Saleable stock in ${windowLabel}: ${totalAvailable.toLocaleString("en-IN")} — enough to transfer ${need.toLocaleString("en-IN")} → ${destination.label}`;
  } else {
    message = `Not enough saleable stock in ${windowLabel}. Available: ${totalAvailable.toLocaleString("en-IN")}, needed: ${need.toLocaleString("en-IN")}, short by ${remaining.toLocaleString("en-IN")}`;
  }

  return {
    orderId: order.orderId,
    sowingDone: Boolean(order.sowingDone),
    plantsNeeded: need,
    bookingSlotId: order.bookingSlot ? String(order.bookingSlot) : null,
    destinationSlot: destination
      ? {
          slotId: String(destination.slotId),
          label: destination.label,
          availablePlants: destination.availablePlants,
          orderReservedPlants: destination.orderReservedPlants,
        }
      : null,
    slotLabel: destination?.label || windowInfo.deliveryAnchor || "—",
    availablePlants: totalAvailable,
    bookingAvailable: Number(destination?.availablePlants) || 0,
    orderReservedPlants: Number(destination?.orderReservedPlants) || 0,
    canCover,
    shortfall: remaining,
    covered,
    windowDays: windowInfo.windowDays,
    coverFrom: windowInfo.coverFrom,
    coverTo: windowInfo.coverTo,
    deliveryAnchor: windowInfo.deliveryAnchor,
    windowLabel,
    transferMode: true,
    slots: slots.map((s) => ({
      slotId: String(s.slotId),
      label: s.label,
      availablePlants: s.availablePlants,
      offsetDays: s.offsetDays,
      isBookingSlot: Boolean(s.isBookingSlot),
    })),
    plannedTransfers: transfers.map((t) => ({
      fromSlotId: String(t.fromSlotId),
      fromLabel: t.fromLabel,
      toSlotId: String(t.toSlotId),
      toLabel: t.toLabel,
      plants: t.take,
      offsetDays: t.offsetDays,
      sameSlot: Boolean(t.sameSlot),
    })),
    plannedAllocations: transfers.map((t) => ({
      slotId: String(t.fromSlotId),
      label: t.fromLabel,
      take: t.take,
      offsetDays: t.offsetDays,
    })),
    slotLines,
    message,
    ...extra,
  };
}

/**
 * GET /sowing/order/:orderId/slot-excess
 * Preview transfer of saleable stock from delivery−4d…0 onto delivery/booking slot.
 */
export const getOrderSlotExcess = async (req, res) => {
  try {
    if (!isOfficeOrSuper(req.user)) {
      return res.status(403).json({
        success: false,
        message: "Only Office Admin or Super Admin can view slot excess",
      });
    }

    const { orderId } = req.params;
    if (!orderId || !mongoose.Types.ObjectId.isValid(orderId)) {
      return res.status(400).json({
        success: false,
        message: "Valid order id is required",
      });
    }

    const order = await Order.findById(orderId)
      .select(
        "orderId numberOfPlants additionalPlants bookingSlot sowingDone deliveryDate plantName plantSubtype"
      )
      .lean();
    if (!order) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }

    const need = orderPlantsNeed(order);
    const deliveryDate = order.deliveryDate || null;
    if (!deliveryDate || !order.plantName || !order.plantSubtype) {
      return res.status(200).json({
        success: true,
        data: {
          orderId: order.orderId,
          sowingDone: Boolean(order.sowingDone),
          plantsNeeded: need,
          availablePlants: 0,
          canCover: false,
          shortfall: need,
          windowDays: LOOKBACK_DAYS,
          transferMode: true,
          slots: [],
          plannedTransfers: [],
          message: "Order missing delivery date or plant/subtype",
        },
      });
    }

    const destination = await resolveDestinationSlot({
      plantId: order.plantName,
      subtypeId: order.plantSubtype,
      deliveryDate,
      bookingSlotId: order.bookingSlot,
    });

    const windowInfo = await loadSourceSlotsInLookback({
      plantId: order.plantName,
      subtypeId: order.plantSubtype,
      deliveryDate,
      bookingSlotId: order.bookingSlot || destination?.slotId,
      lookbackDays: LOOKBACK_DAYS,
    });

    const includeAll =
      String(req.query.includeAllAvailable || "").toLowerCase() === "true";
    let allAvailableSlots = null;
    if (includeAll) {
      const allInfo = await loadAllAvailableSourceSlots({
        plantId: order.plantName,
        subtypeId: order.plantSubtype,
        deliveryDate,
        bookingSlotId: order.bookingSlot || destination?.slotId,
      });
      allAvailableSlots = allInfo.slots;
    }

    const previewExtra = allAvailableSlots
      ? {
          allAvailableSlots: allAvailableSlots.map((s) => ({
            slotId: String(s.slotId),
            label: s.label,
            availablePlants: s.availablePlants,
            offsetDays: s.offsetDays,
            isBookingSlot: Boolean(s.isBookingSlot),
          })),
          includeAllAvailable: true,
        }
      : {};

    return res.status(200).json({
      success: true,
      data: buildPreviewPayload(
        order,
        windowInfo,
        need,
        destination,
        previewExtra
      ),
    });
  } catch (error) {
    console.error("[getOrderSlotExcess]", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to load slot excess",
    });
  }
};

/**
 * POST /sowing/order/:orderId/complete-from-excess
 * Transfer saleable plants from delivery−4d…0 onto delivery slot, audit, mark sowingDone.
 */
export const completeOrderFromSlotExcess = async (req, res) => {
  try {
    if (!isOfficeOrSuper(req.user)) {
      return res.status(403).json({
        success: false,
        message: "Only Office Admin or Super Admin can complete sow from excess",
      });
    }

    const { orderId } = req.params;
    if (!orderId || !mongoose.Types.ObjectId.isValid(orderId)) {
      return res.status(400).json({
        success: false,
        message: "Valid order id is required",
      });
    }

    const order = await Order.findById(orderId).select(
      "orderId numberOfPlants additionalPlants bookingSlot sowingDone orderStatus plantName plantSubtype deliveryDate"
    );
    if (!order) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }

    if (order.sowingDone) {
      return res.status(400).json({
        success: false,
        message: `Order #${order.orderId} is already marked sow completed`,
      });
    }

    const blocked = ["CANCELLED", "TEMPORARY_CANCELLED", "REJECTED", "DELETED"];
    if (blocked.includes(String(order.orderStatus || "").toUpperCase())) {
      return res.status(400).json({
        success: false,
        message: `Cannot complete sow for ${order.orderStatus} order #${order.orderId}`,
      });
    }

    const need = orderPlantsNeed(order);
    if (need <= 0) {
      return res.status(400).json({
        success: false,
        message: `Order #${order.orderId} has no plants to cover`,
      });
    }

    if (!order.deliveryDate || !order.plantName || !order.plantSubtype) {
      return res.status(400).json({
        success: false,
        message: `Order #${order.orderId} missing delivery date or plant/subtype`,
      });
    }

    const destination = await resolveDestinationSlot({
      plantId: order.plantName,
      subtypeId: order.plantSubtype,
      deliveryDate: order.deliveryDate,
      bookingSlotId: order.bookingSlot,
    });
    if (!destination?.slotId) {
      return res.status(400).json({
        success: false,
        code: "NO_DESTINATION_SLOT",
        message: `No delivery/booking slot found for order #${order.orderId}`,
      });
    }

    const windowInfo = await loadSourceSlotsInLookback({
      plantId: order.plantName,
      subtypeId: order.plantSubtype,
      deliveryDate: order.deliveryDate,
      bookingSlotId: order.bookingSlot || destination.slotId,
      lookbackDays: LOOKBACK_DAYS,
    });

    const preview = buildPreviewPayload(order, windowInfo, need, destination);
    const bodyPicks = Array.isArray(req.body?.transfers)
      ? req.body.transfers
      : Array.isArray(req.body?.allocations)
        ? req.body.allocations
        : null;

    let transfers;
    if (bodyPicks && bodyPicks.length) {
      const manual = await resolveManualTransfersAsync(
        bodyPicks,
        windowInfo.slots,
        need,
        destination,
        {
          plantId: order.plantName,
          subtypeId: order.plantSubtype,
          deliveryDate: order.deliveryDate,
          bookingSlotId: order.bookingSlot || destination.slotId,
        }
      );
      if (!manual.ok) {
        return res.status(400).json({
          success: false,
          code: manual.code || "INSUFFICIENT_SLOT_EXCESS",
          message: manual.message,
          data: { ...preview, plannedTransfers: manual.transfers?.map?.((t) => ({
            fromSlotId: String(t.fromSlotId),
            fromLabel: t.fromLabel,
            toSlotId: String(t.toSlotId),
            toLabel: t.toLabel,
            plants: t.take,
            offsetDays: t.offsetDays,
            sameSlot: Boolean(t.sameSlot),
          })) || preview.plannedTransfers },
        });
      }
      transfers = manual.transfers;
    } else {
      if (!preview.canCover) {
        return res.status(400).json({
          success: false,
          code: "INSUFFICIENT_SLOT_EXCESS",
          message: preview.message,
          data: preview,
        });
      }
      transfers = planTransfers(windowInfo.slots, need, destination).transfers;
    }

    const applied = [];
    for (const tr of transfers) {
      const ok = await applyTransfer(tr);
      if (!ok) {
        await reverseTransfers(applied);
        const again = await loadSourceSlotsInLookback({
          plantId: order.plantName,
          subtypeId: order.plantSubtype,
          deliveryDate: order.deliveryDate,
          bookingSlotId: order.bookingSlot || destination.slotId,
          lookbackDays: LOOKBACK_DAYS,
        });
        const againPreview = buildPreviewPayload(order, again, need, destination);
        return res.status(409).json({
          success: false,
          code: "INSUFFICIENT_SLOT_EXCESS",
          message: `Stock changed on ${tr.fromLabel}. ${againPreview.message}`,
          data: againPreview,
        });
      }
      applied.push(tr);
    }

    let request;
    try {
      request = await writeTransferAudit({
        order,
        plants: need,
        transfers: applied,
        destination,
        userId: req.user._id,
      });
    } catch (auditErr) {
      console.error("[completeOrderFromSlotExcess] audit:", auditErr);
      await reverseTransfers(applied);
      return res.status(500).json({
        success: false,
        message: auditErr.message || "Failed to write transfer audit",
      });
    }

    const transferSummary = applied
      .map((t) => `${t.fromLabel}(${offsetLabel(t.offsetDays)})→${t.toLabel}:${t.take}`)
      .join(", ");

    const remark = [
      `Sow completed — transfer from delivery−${LOOKBACK_DAYS}d saleable`,
      `${need} plants → ${destination.label}`,
      transferSummary,
      request?.requestNumber ? `req ${request.requestNumber}` : null,
    ]
      .filter(Boolean)
      .join(" · ");

    const marked = await Order.findOneAndUpdate(
      {
        _id: order._id,
        sowingDone: { $ne: true },
      },
      {
        $set: {
          sowingDone: true,
          sowingDoneAt: new Date(),
          sowingDoneRequestId: request._id,
        },
        $push: { orderRemarks: remark },
      },
      { new: true }
    );

    if (!marked) {
      await reverseTransfers(applied);
      return res.status(409).json({
        success: false,
        message: `Order #${order.orderId} was already marked sow completed`,
      });
    }

    return res.status(200).json({
      success: true,
      message: `Order #${order.orderId} sow completed · ${need.toLocaleString("en-IN")} transferred → ${destination.label}`,
      data: {
        orderId: order.orderId,
        orderMongoId: String(order._id),
        plantsCovered: need,
        windowDays: LOOKBACK_DAYS,
        coverFrom: windowInfo.coverFrom,
        coverTo: windowInfo.coverTo,
        transferMode: true,
        destinationSlot: {
          slotId: String(destination.slotId),
          label: destination.label,
        },
        requestId: String(request._id),
        requestNumber: request.requestNumber,
        transfers: applied.map((t) => ({
          fromSlotId: String(t.fromSlotId),
          fromLabel: t.fromLabel,
          toSlotId: String(t.toSlotId),
          toLabel: t.toLabel,
          plants: t.take,
          offsetDays: t.offsetDays,
        })),
        allocations: applied.map((t) => ({
          slotId: String(t.fromSlotId),
          label: t.fromLabel,
          take: t.take,
          offsetDays: t.offsetDays,
        })),
        sowingDoneAt: marked.sowingDoneAt,
      },
    });
  } catch (error) {
    console.error("[completeOrderFromSlotExcess]", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to complete sow from excess",
    });
  }
};
