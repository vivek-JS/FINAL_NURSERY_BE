import { DUE_DELIVERY_STATUSES } from "./adminMisDue.js";
import {
  findCurrentSlotIdForGroup,
  isSlotExpiredByEndDay,
} from "../services/pastDueSlotRollover.service.js";
import { getNativeDeliveryCohortOrders } from "./slotDispatchStats.js";
import { SOWING_GAP_PIPELINE_STATUS_SET } from "../constants/sowingGapOrderStatuses.js";

const DUE_PIPELINE_STATUS_SET = new Set(DUE_DELIVERY_STATUSES);

export function orderLinePlants(order) {
  return (Number(order.numberOfPlants) || 0) + (Number(order.additionalPlants) || 0);
}

export function isEligiblePastDueOrder(order) {
  if (order?.quotaSource === "dealer") return false;
  return DUE_PIPELINE_STATUS_SET.has(order?.orderStatus);
}

export function mapPastDueOrderRow(order) {
  return {
    _id: order._id?.toString?.() || String(order._id),
    orderId: order.orderId,
    orderStatus: order.orderStatus,
    plants: orderLinePlants(order),
    pastDueSlotRollover: isPastDueRolledInOrder(order),
  };
}

/** Past-due rollover line — strict so booked vs rolled-in never double-count. */
export function isPastDueRolledInOrder(order) {
  return (
    order?.pastDueSlotRollover === true || Boolean(order?.pastDueSlotRolloverAt)
  );
}

export function mapCrossSlotOrderRow(order, extra = {}) {
  return {
    _id: order._id?.toString?.() || String(order._id),
    orderId: order.orderId,
    orderStatus: order.orderStatus,
    plants: orderLinePlants(order),
    ...extra,
  };
}

function slotWindowLabel(slot) {
  if (!slot?.startDay || !slot?.endDay) return "";
  return `${slot.startDay}–${slot.endDay}`;
}

/** Map order _id → ready slot where its sowing batch was recorded. */
export function buildOrderSowingSlotIndex(slots, slotMap = null) {
  const byOrderId = new Map();
  const resolveLabel = (slotId) => {
    if (slotMap?.has(slotId)) {
      return slotWindowLabel(slotMap.get(slotId)) || slotId;
    }
    return slotId;
  };

  for (const slot of slots || []) {
    const slotId = slot._id?.toString?.() ?? String(slot._id);
    const slotLabel = slotWindowLabel(slot) || slotId;
    const batches = Array.isArray(slot.sowingBatches) ? slot.sowingBatches : [];
    for (const batch of batches) {
      const meta = {
        fromSlotId: slotId,
        fromSlotLabel: slotLabel,
        requestNumber: batch.requestNumber || "",
        plantReadyDate: batch.plantReadyDate || "",
      };
      for (const oid of batch.linkedOrderIds || []) {
        const orderId = oid?.toString?.() ?? String(oid);
        if (orderId) byOrderId.set(orderId, meta);
      }
    }
  }

  for (const slot of slots || []) {
    const gapEntries = Array.isArray(slot.gapCovered) ? slot.gapCovered : [];
    for (const entry of gapEntries) {
      const fromSlotId = entry.fromSlotId?.toString?.() ?? String(entry.fromSlotId || "");
      if (!fromSlotId) continue;
      const meta = {
        fromSlotId,
        fromSlotLabel: entry.fromSlotDate || resolveLabel(fromSlotId),
        requestNumber: entry.sowingBatchNumber || "",
        plantReadyDate: entry.fromSlotDate || "",
      };
      // gapCovered is slot-level; order rows are matched separately via sowingDone.
      if (!byOrderId.has(`__gap__${slot._id}`)) {
        byOrderId.set(`__gap__${slot._id}`, meta);
      }
    }
  }

  return byOrderId;
}

/**
 * Orders on this delivery window marked sowingDone but sowed on another slot's ready window.
 */
export function buildSowingFromOtherSlotDetail({ slot, deliveryOrders, orderSowingIndex, slotMap }) {
  const slotId = slot?._id?.toString?.() ?? String(slot?._id || "");
  const localOrderIds = new Set();
  for (const batch of slot?.sowingBatches || []) {
    for (const oid of batch.linkedOrderIds || []) {
      localOrderIds.add(oid?.toString?.() ?? String(oid));
    }
  }

  const gapCovered = Array.isArray(slot?.gapCovered) ? slot.gapCovered : [];
  const gapCoveredPlants = gapCovered.reduce(
    (sum, entry) => sum + Math.max(0, Number(entry.plantsCovered) || 0),
    0
  );
  const fallbackMeta = orderSowingIndex?.get(`__gap__${slotId}`) || null;

  const orders = [];
  let plants = 0;
  for (const order of getNativeDeliveryCohortOrders(deliveryOrders)) {
    if (!order?.sowingDone) continue;
    const orderKey = order._id?.toString?.() ?? String(order._id);
    if (localOrderIds.has(orderKey)) continue;

    const sowingSource = orderSowingIndex?.get(orderKey) || fallbackMeta;
    let fromSlotLabel = sowingSource?.fromSlotLabel || "";
    if (!fromSlotLabel && sowingSource?.fromSlotId && slotMap?.has(sowingSource.fromSlotId)) {
      fromSlotLabel = slotWindowLabel(slotMap.get(sowingSource.fromSlotId));
    }
    if (!fromSlotLabel && gapCovered.length === 1) {
      fromSlotLabel = gapCovered[0].fromSlotDate || "";
    }
    if (!fromSlotLabel) fromSlotLabel = "Other slot";

    const row = mapCrossSlotOrderRow(order, {
      fromSlotLabel,
      requestNumber: sowingSource?.requestNumber || "",
      plantReadyDate: sowingSource?.plantReadyDate || "",
    });
    orders.push(row);
    plants += row.plants;
  }

  return {
    orders,
    orderCount: orders.length,
    plants,
    gapCovered,
    gapCoveredPlants,
    gapFullyCovered: Boolean(slot?.gapFullyCovered),
  };
}

const EXCLUDED_GAP_ORDERS = new Set(["CANCELLED", "REJECTED", "TEMPORARY_CANCELLED", "DISPATCHED", "COMPLETED"]);
const DISPATCHED_GAP_STATUSES = new Set(["DISPATCHED", "COMPLETED"]);

const REMAINING_GAP_STATUSES = SOWING_GAP_PIPELINE_STATUS_SET;

function parseDdMmYyyySortKey(value) {
  if (!value || typeof value !== "string") return 0;
  const m = value.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!m) return 0;
  return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1])).getTime();
}

function groupCoveredOrdersByReadyDate(orders) {
  const byKey = new Map();
  for (const row of orders || []) {
    const dateLabel = row.plantReadyDate || row.fromSlotLabel || "Unknown";
    if (!byKey.has(dateLabel)) {
      byKey.set(dateLabel, {
        dateLabel,
        slotLabel: row.fromSlotLabel || "",
        requestNumber: row.requestNumber || "",
        orders: [],
        orderCount: 0,
        plants: 0,
      });
    }
    const bucket = byKey.get(dateLabel);
    bucket.orders.push(row);
    bucket.orderCount += 1;
    bucket.plants += row.plants;
    if (!bucket.requestNumber && row.requestNumber) {
      bucket.requestNumber = row.requestNumber;
    }
    if (!bucket.slotLabel && row.fromSlotLabel) {
      bucket.slotLabel = row.fromSlotLabel;
    }
  }
  return [...byKey.values()].sort(
    (a, b) => parseDdMmYyyySortKey(a.dateLabel) - parseDdMmYyyySortKey(b.dateLabel)
  );
}

function gapCoveredSectionsFromSlot(slot, slotMap) {
  const entries = Array.isArray(slot?.gapCovered) ? slot.gapCovered : [];
  return entries
    .map((entry) => {
      const fromSlotId = entry.fromSlotId?.toString?.() ?? String(entry.fromSlotId || "");
      const fromSlot = fromSlotId && slotMap?.get(fromSlotId);
      return {
        dateLabel: entry.fromSlotDate || entry.coverageDate || "Unknown",
        slotLabel: fromSlot ? slotWindowLabel(fromSlot) : entry.fromSlotDate || "",
        requestNumber: entry.sowingBatchNumber || "",
        orders: [],
        orderCount: 0,
        plants: Math.max(0, Number(entry.plantsCovered) || 0),
      };
    })
    .filter((section) => section.plants > 0)
    .sort((a, b) => parseDdMmYyyySortKey(a.dateLabel) - parseDdMmYyyySortKey(b.dateLabel));
}

/**
 * Sowing gap drawer payload: uncovered orders + covered orders grouped by ready date.
 */
export function buildSowingGapDetail({
  slot,
  deliveryOrders,
  orderSowingIndex,
  slotMap,
  sowingAllowed = false,
}) {
  const slotId = slot?._id?.toString?.() ?? String(slot?._id || "");
  const localCoverByOrder = new Map();
  for (const batch of slot?.sowingBatches || []) {
    for (const oid of batch.linkedOrderIds || []) {
      const orderKey = oid?.toString?.() ?? String(oid);
      localCoverByOrder.set(orderKey, {
        fromSlotLabel: slotWindowLabel(slot),
        plantReadyDate: batch.plantReadyDate || "",
        requestNumber: batch.requestNumber || "",
        coverType: "local",
      });
    }
  }

  const uncovered = [];
  const covered = [];

  for (const order of deliveryOrders || []) {
    if (!order || EXCLUDED_GAP_ORDERS.has(order.orderStatus)) continue;
    if (order.quotaSource === "dealer") continue;
    if (isPastDueRolledInOrder(order)) continue;

    const orderKey = order._id?.toString?.() ?? String(order._id);
    const plants = orderLinePlants(order);
    const dispatched =
      DISPATCHED_GAP_STATUSES.has(order.orderStatus) ? plants : 0;
    const remaining = REMAINING_GAP_STATUSES.has(order.orderStatus) ? plants : 0;

    if (sowingAllowed) {
      if (order.sowingDone || dispatched > 0) {
        const local = localCoverByOrder.get(orderKey);
        const remote = orderSowingIndex?.get(orderKey);
        const meta = local || remote || {};
        covered.push(
          mapCrossSlotOrderRow(order, {
            fromSlotLabel:
              meta.fromSlotLabel ||
              (local ? slotWindowLabel(slot) : "") ||
              "Other slot",
            plantReadyDate: meta.plantReadyDate || "",
            requestNumber: meta.requestNumber || "",
            coverType: local ? "local" : "other",
          })
        );
      } else if (remaining > 0) {
        uncovered.push(mapCrossSlotOrderRow(order));
      }
    }
  }

  let coveredByReadyDate = groupCoveredOrdersByReadyDate(covered);
  if (!sowingAllowed) {
    coveredByReadyDate = gapCoveredSectionsFromSlot(slot, slotMap);
  } else if (coveredByReadyDate.length === 0) {
    const gapSections = gapCoveredSectionsFromSlot(slot, slotMap);
    if (gapSections.length) coveredByReadyDate = gapSections;
  }

  const uncoveredPlants = uncovered.reduce((sum, row) => sum + row.plants, 0);
  const coveredPlants = covered.reduce((sum, row) => sum + row.plants, 0);
  const gapCoveredPlants = coveredByReadyDate.reduce(
    (sum, section) => sum + (Number(section.plants) || 0),
    0
  );

  return {
    uncovered: {
      orders: uncovered,
      orderCount: uncovered.length,
      plants: uncoveredPlants,
    },
    coveredByReadyDate,
    coveredTotal: {
      orderCount: covered.length,
      plants: coveredPlants || gapCoveredPlants,
    },
    gapCoveredPlants,
    gapFullyCovered: Boolean(slot?.gapFullyCovered),
  };
}

/** Per-slot early-dispatch in / released-out order lists for slots UI drawer. */
export function buildCrossSlotDetailBySlot(crossSlotOrders, slotMap) {
  const bySlot = new Map();
  const ensure = (slotId) => {
    if (!bySlot.has(slotId)) {
      bySlot.set(slotId, {
        earlyDispatchIn: { orders: [], orderCount: 0, plants: 0 },
        releasedOut: { orders: [], orderCount: 0, plants: 0 },
      });
    }
    return bySlot.get(slotId);
  };

  for (const order of crossSlotOrders || []) {
    if (isPastDueRolledInOrder(order)) continue;
    const bookingId = order.bookingSlot?.toString?.() ?? String(order.bookingSlot || "");
    const originalId =
      order.originalBookingSlot?.toString?.() ?? String(order.originalBookingSlot || "");
    if (!bookingId || !originalId || bookingId === originalId) continue;

    const row = mapCrossSlotOrderRow(order);

    if (slotMap.has(bookingId)) {
      const bucket = ensure(bookingId).earlyDispatchIn;
      const fromSlot = slotMap.get(originalId);
      bucket.orders.push({
        ...row,
        fromSlotLabel: slotWindowLabel(fromSlot) || originalId,
      });
      bucket.orderCount += 1;
      bucket.plants += row.plants;
    }

    if (slotMap.has(originalId)) {
      const bucket = ensure(originalId).releasedOut;
      const toSlot = slotMap.get(bookingId);
      bucket.orders.push({
        ...row,
        toSlotLabel: slotWindowLabel(toSlot) || bookingId,
      });
      bucket.orderCount += 1;
      bucket.plants += row.plants;
    }
  }

  return bySlot;
}

/** Sum plants on slot from early/cross-slot moves — excludes past-due rollover. */
export function sumEarlyDispatchOntoSlot(crossSlotOrders, slotIdSet) {
  const bySlot = new Map();
  for (const order of crossSlotOrders || []) {
    if (order.pastDueSlotRollover) continue;
    const qty = orderLinePlants(order);
    const bookingId = order.bookingSlot?.toString?.() ?? String(order.bookingSlot || "");
    if (bookingId && slotIdSet.has(bookingId)) {
      bySlot.set(bookingId, (bySlot.get(bookingId) || 0) + qty);
    }
  }
  return bySlot;
}

/** Past-due pills: one current slot per subtype — per-bucket order lists for UI. */
export function aggregatePastDueMetricsForSlotGroup(slots, ordersBySlot, asOfDate = new Date()) {
  let pastDueRolledInPlants = 0;
  let pastDuePendingOnSlot = 0;
  const currentSlotId = findCurrentSlotIdForGroup(slots, asOfDate);

  const rolledInOnCurrentSlot = [];
  const rolledInOnOtherSlots = [];
  const pendingBySlotMap = new Map();

  for (const slot of slots || []) {
    // Include Off/closed — pending/rolled pills attach to running window regardless of status.
    const slotId = slot._id?.toString?.() || String(slot._id);
    const orders = ordersBySlot.get(slotId) || [];
    const isCurrent = slotId === currentSlotId;

    for (const o of orders) {
      const qty = orderLinePlants(o);
      const row = mapPastDueOrderRow(o);

      if (isPastDueRolledInOrder(o)) {
        pastDueRolledInPlants += qty;
        if (isCurrent) rolledInOnCurrentSlot.push(row);
        else rolledInOnOtherSlots.push(row);
      }

      if (isSlotExpiredByEndDay(slot, asOfDate) && isEligiblePastDueOrder(o)) {
        pastDuePendingOnSlot += qty;
        if (!pendingBySlotMap.has(slotId)) {
          pendingBySlotMap.set(slotId, {
            slotId,
            startDay: slot.startDay,
            endDay: slot.endDay,
            label: `${slot.startDay}–${slot.endDay}`,
            orderCount: 0,
            plants: 0,
            orders: [],
          });
        }
        const bucket = pendingBySlotMap.get(slotId);
        bucket.orders.push(row);
        bucket.orderCount += 1;
        bucket.plants += qty;
      }
    }
  }

  const pendingBySlot = [...pendingBySlotMap.values()].sort(
    (a, b) => b.plants - a.plants || b.orderCount - a.orderCount
  );

  const pastDueRolledInOrders =
    rolledInOnCurrentSlot.length + rolledInOnOtherSlots.length;
  const pastDuePendingOrders = pendingBySlot.reduce((s, b) => s + b.orderCount, 0);

  return {
    currentSlotId,
    pastDueRolledInPlants,
    pastDuePendingOnSlot,
    pastDueRolledInOrders,
    pastDuePendingOrders,
    pastDueDetail: {
      rolledInOnCurrentSlot: {
        orderCount: rolledInOnCurrentSlot.length,
        plants: rolledInOnCurrentSlot.reduce((s, r) => s + r.plants, 0),
        orders: rolledInOnCurrentSlot,
      },
      rolledInOnOtherSlots: {
        orderCount: rolledInOnOtherSlots.length,
        plants: rolledInOnOtherSlots.reduce((s, r) => s + r.plants, 0),
        orders: rolledInOnOtherSlots,
      },
      pendingBySlot,
      pendingTotal: {
        orderCount: pendingBySlot.reduce((s, b) => s + b.orderCount, 0),
        plants: pastDuePendingOnSlot,
      },
    },
  };
}

function summarizeSowingEntries(slot) {
  const batches = Array.isArray(slot?.sowingBatches) ? slot.sowingBatches : [];
  return batches.slice(0, 40).map((b) => ({
    requestNumber: b.requestNumber || "",
    sowingDate: b.sowingDate || "",
    plantReadyDate: b.plantReadyDate || "",
    plantsSowed: Number(b.plantsSowed) || 0,
    orderCoveredPlants: Number(b.orderCoveredPlants) || 0,
    excessPlants: Number(b.excessPlants) || 0,
    packetsUsed: Number(b.packetsUsed) || 0,
    isExcessiveSowing: Boolean(b.isExcessiveSowing),
  }));
}

function dispatchedOnSlot(dispatchStats) {
  const all = Number(dispatchStats?.totalAllDispatchedPlants);
  if (Number.isFinite(all) && all > 0) return all;
  return (
    (Number(dispatchStats?.totalDispatchedPlants) || 0) +
    (Number(dispatchStats?.dispatchedOtherPlants) || 0)
  );
}

/** Physical stock vs dispatch queue metrics for slot list API. */
export function computeSlotPhysicalMetrics(slot, dispatchStats) {
  const actualPlants = Number(slot?.actualPlants) || 0;
  const actualRemaining =
    (Number(dispatchStats?.remainingNative) || 0) +
    (Number(dispatchStats?.remainingRolledIn) || 0);
  const remainingToDispatch = Number(dispatchStats?.remainingToDispatch) || 0;
  const dispatched = dispatchedOnSlot(dispatchStats);
  const actualGapRaw = actualRemaining - actualPlants;
  const actualGapPlants = Math.max(0, actualGapRaw);
  const actualSurplusPlants = Math.max(0, -actualGapRaw);
  const actualGapPct =
    actualPlants <= 0 ? (actualGapPlants > 0 ? 100 : 0) : Math.round((actualGapPlants / actualPlants) * 100);

  return {
    actualPlants,
    /** Physical remaining = actual plants minus already dispatched (not minus next-day queue). */
    actualAvailable: Math.max(0, actualPlants - dispatched),
    /** Headroom vs dispatch queue (can be 0 when nearby days are covering this slot). */
    queueAvailable: Math.max(0, actualPlants - remainingToDispatch),
    actualRemainingPlants: actualRemaining,
    actualGapPlants,
    actualGapPct,
    actualSurplusPlants,
    rolledInAvailablePlants: Number(slot?.rolledInAvailablePlants) || 0,
  };
}

/** Sum gross plants reserved for covered orders across complete-sow batches. */
export function sumGrossOrderCoveredPlants(slot) {
  const batches = slot?.sowingBatches;
  if (!Array.isArray(batches) || !batches.length) return 0;
  return batches.reduce(
    (sum, batch) => sum + Math.max(0, Number(batch?.orderCoveredPlants) || 0),
    0
  );
}

/**
 * Sowing-allowed slot display fields (call after resolveSlotBufferFields).
 * excessAvailableForBooking = availablePlants − gross order cover (display gross, not 90% lagwad).
 */
export function applySowingAllowedSlotMetrics(slot) {
  if (!slot) return slot;
  const gross = sumGrossOrderCoveredPlants(slot);
  const available = Number(slot.availablePlants) || 0;
  const sowingGap = Math.max(0, Number(slot.bookedUncoveredPlants) || 0);
  slot.grossOrderCoveredPlants = gross;
  slot.excessAvailableForBooking = Math.max(0, available - gross);
  slot.sowingGapPlants = sowingGap;
  slot.orderReservedPlants = Math.max(0, Number(slot.orderReservedPlants) || 0);
  slot.excessiveSowingPlants = Math.max(
    0,
    Number(slot.excessiveSowing?.plants) || 0
  );
  return slot;
}

/** Attach dispatch + past-due fields for one slot row (GET slots). */
export function buildSlotOrderMetrics({
  slot,
  slotId,
  orders,
  dispatchStats,
  pastDueGroup,
  dispatchedFromOtherBySlot,
  releasedForEarlyBySlot,
  crossSlotDetailBySlot,
  sowingFromOtherSlotDetail = null,
  sowingGapDetail = null,
}) {
  const isCurrentSlot = slotId === pastDueGroup.currentSlotId;
  const rolledOnCurrent = pastDueGroup.pastDueDetail?.rolledInOnCurrentSlot || {};
  const crossSlotDetail = crossSlotDetailBySlot?.get(slotId) || null;
  const sowingOther = sowingFromOtherSlotDetail || {
    orders: [],
    orderCount: 0,
    plants: 0,
    gapCovered: [],
    gapCoveredPlants: 0,
    gapFullyCovered: false,
  };
  const physical = computeSlotPhysicalMetrics(slot, dispatchStats);
  const grossOrderCoveredPlants = sumGrossOrderCoveredPlants(slot);
  const totalBooked = Number(dispatchStats.totalBookedPlants) || 0;
  const sowedForOtherDeliveryPlants = Math.max(
    0,
    grossOrderCoveredPlants - Math.min(grossOrderCoveredPlants, totalBooked)
  );

  return {
    totalBookedPlants: dispatchStats.totalBookedPlants,
    totalDispatchedPlants: dispatchStats.totalDispatchedPlants,
    dispatchedNativePlants: dispatchStats.totalDispatchedPlants,
    dispatchedRolledInPlants: dispatchStats.dispatchedRolledInPlants || 0,
    dispatchedCrossSlotInPlants: dispatchStats.dispatchedCrossSlotInPlants || 0,
    dispatchedOtherPlants: dispatchStats.dispatchedOtherPlants || 0,
    totalAllDispatchedPlants:
      dispatchStats.totalAllDispatchedPlants ?? dispatchStats.totalDispatchedPlants,
    remainingToDispatch: dispatchStats.remainingToDispatch,
    remainingRolledIn: dispatchStats.remainingRolledIn,
    remainingNative: dispatchStats.remainingNative,
    bookedCoveredPlants: Number(dispatchStats.bookedCoveredPlants) || 0,
    bookedUncoveredPlants: Number(dispatchStats.bookedUncoveredPlants) || 0,
    sowingGapPlants: Math.max(0, Number(dispatchStats.bookedUncoveredPlants) || 0),
    grossOrderCoveredPlants,
    sowedForOtherDeliveryPlants,
    orderReservedPlants: Math.max(0, Number(slot?.orderReservedPlants) || 0),
    excessiveSowingPlants: Math.max(
      0,
      Number(slot?.excessiveSowing?.plants) || 0
    ),
    sowingEntries: summarizeSowingEntries(slot),
    dispatchedFromOtherSlots: dispatchedFromOtherBySlot.get(slotId) || 0,
    releasedForEarlyDispatch: releasedForEarlyBySlot.get(slotId) || 0,
    isCurrentDateSlot: isCurrentSlot,
    pastDueRolledInPlants: isCurrentSlot ? rolledOnCurrent.plants || 0 : 0,
    pastDueRolledInOrders: isCurrentSlot ? rolledOnCurrent.orderCount || 0 : 0,
    pastDuePendingOnSlot: isCurrentSlot ? pastDueGroup.pastDuePendingOnSlot : 0,
    pastDuePendingOrders: isCurrentSlot ? pastDueGroup.pastDuePendingOrders : 0,
    pastDueDetail: isCurrentSlot ? pastDueGroup.pastDueDetail : null,
    pastDueRolledInPlantsSubtype: isCurrentSlot ? pastDueGroup.pastDueRolledInPlants : 0,
    pastDuePendingOnSlotSubtype: isCurrentSlot ? pastDueGroup.pastDuePendingOnSlot : 0,
    crossSlotDetail,
    sowingFromOtherSlotDetail: sowingOther,
    sowingFromOtherSlotPlants: sowingOther.plants || 0,
    sowingFromOtherSlotOrders: sowingOther.orderCount || 0,
    sowingGapDetail: sowingGapDetail || {
      uncovered: { orders: [], orderCount: 0, plants: 0 },
      coveredByReadyDate: [],
      coveredTotal: { orderCount: 0, plants: 0 },
      gapCoveredPlants: 0,
      gapFullyCovered: false,
    },
    gapCoveredPlants:
      sowingGapDetail?.gapCoveredPlants ?? sowingOther.gapCoveredPlants ?? 0,
    gapFullyCovered:
      sowingGapDetail?.gapFullyCovered ?? sowingOther.gapFullyCovered ?? false,
    ...physical,
  };
}
