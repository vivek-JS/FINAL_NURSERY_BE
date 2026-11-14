import mongoose from "mongoose";
import moment from "moment";
import AppError from "../utility/appError.js";
import PlantSlot from "../models/slots.model.js";
import PlantOutward from "../models/plantOutward.model.js";
import Dispatch from "../models/dispatch.model.js";
import Order from "../models/order.model.js";
import SowingEntry from "../models/sowingEntry.model.js";
import { applyStockFieldUpdates } from "../utility/slotStockTrail.js";
import { sowBatchStock } from "../utility/lagwadSlotPlantsSplit.js";
import { dispatchBookableFree } from "../utility/sowingBatchExcessStamp.js";
import {
  availablePlantsOf,
  dispatchedPlantsOf,
  sellablePlantsOf,
} from "./sowBatchStock.service.js";
import { attributedCoverPlants } from "../utility/sowingBatchCoverAttribution.js";
import { packQtyFromOrderDispatchRow } from "../utility/packCratesFromOrder.js";
import { pushBatchChangeLog } from "../utility/sowingBatchChangeLog.js";
import { sowingBufferPctByPlantId } from "../utility/plantSowingBuffer.js";
import {
  findDispatchActiveByIdOrTransport,
  resolvePlantRowFromDispatch,
  syncDispatchTransportStatusAfterShedChange,
  updateDispatchOrderShedLoaded,
  DISPATCH_SHED_ALLOWED_STATUSES,
  sumPlantsLoadedOnDispatch,
  unionDispatchOrderObjectIds,
  vehicleLineRemainingMap,
} from "./secondaryVehicleLoad.service.js";
import {
  isPlantSowingAllowed,
  ensureSowReadyPlantOutward,
  resolveDefaultCavity,
} from "./secondarySowReadyDispatch.service.js";
import {
  finalizeOrderOnShedLineLoaded,
  schedulePostShedLoadAlerts,
  schedulePendingDispatchWhatsAppForVehicle,
  scheduleVehicleLoadMoreNotify,
  syncOrderVehicleLoadedFlag,
} from "./dispatchPostLoadFinalize.service.js";
import {
  applyDispatchOrderPlants,
  recordSowingEntryPlantDispatch,
} from "../modules/sowingEntries/syncDispatchSowEntries.js";

const toQty = (v) => Math.max(0, Math.floor(Number(v) || 0));
const idStr = (v) => (v == null || v === "" ? "" : String(v?._id ?? v));

/**
 * Excess uses the sowing-grid cover (order.sowingCoverSources), not the batch stamp.
 * Stamp-only cover leaves Free = sowed − mortality, which is expected ready.
 */
export function batchWithGridCover(batch, orders) {
  const attributed = attributedCoverPlants({
    requestId: batch?.sowingRequestId,
    requestNumber: batch?.requestNumber || "",
    batch,
    orders,
    inventDone: true,
  });
  const stamped = toQty(batch?.orderCoveredPlants);
  const cover = attributed > 0 ? attributed : stamped;
  if (cover === stamped) return batch;
  const plain = typeof batch?.toObject === "function" ? batch.toObject() : { ...(batch || {}) };
  return { ...plain, orderCoveredPlants: cover };
}

/** Orders that no longer hold plants in a batch (gone, or already on a vehicle / delivered). */
const CLOSED_ORDER_STATUSES = ["CANCELLED", "TEMPORARY_CANCELLED", "REJECTED"];
const NOT_RELINKABLE_STATUSES = [
  ...CLOSED_ORDER_STATUSES,
  "DISPATCHED",
  "COMPLETED",
  "PARTIALLY_COMPLETED",
];

export const orderPlants = (o) => toQty(o?.numberOfPlants) + toQty(o?.additionalPlants);

function dmyMs(s) {
  const m = moment(String(s || ""), ["DD-MM-YYYY", "YYYY-MM-DD"], true);
  return m.isValid() ? m.valueOf() : Number.POSITIVE_INFINITY;
}

/** batchId → { slotId, slot, batch } for every sowing batch on the given slot docs. */
export function indexSowBatches(slotDocs, subtypeId) {
  const index = new Map();
  for (const doc of slotDocs || []) {
    for (const st of doc.subtypeSlots || []) {
      if (subtypeId && idStr(st.subtypeId) !== idStr(subtypeId)) continue;
      for (const slot of st.slots || []) {
        for (const batch of slot.sowingBatches || []) {
          index.set(idStr(batch._id), { slotId: idStr(slot._id), slot, batch, doc });
        }
      }
    }
  }
  return index;
}

/**
 * Batches an order's plants were sown into before any dispatch relink:
 * excess cover sources first, else the batch(es) of its sowing request.
 */
function batchForRequest(batchIndex, reqId, orderId) {
  if (!reqId) return null;
  const candidates = [...batchIndex.values()].filter((e) => idStr(e.batch.sowingRequestId) === reqId);
  if (!candidates.length) return null;
  const oid = idStr(orderId);
  return (
    candidates.find((e) => (e.batch.linkedOrderIds || []).some((x) => idStr(x) === oid)) ||
    candidates[0]
  );
}

export function baseOrderLinks(order, batchIndex) {
  const covers = order?.sowingCoverReversedAt ? [] : order?.sowingCoverSources || [];
  if (covers.length) {
    const links = [];
    for (const s of covers) {
      const plants = toQty(s.plants);
      if (plants < 1) continue;
      let batchId = idStr(s.moved ? s.destBatchId : s.batchId);
      let slotId = idStr(s.moved ? s.destSlotId : s.slotId);
      if (!batchId) {
        const pick = batchForRequest(batchIndex, idStr(s.sowingRequestId), order._id);
        if (!pick) continue;
        batchId = idStr(pick.batch._id);
        slotId = slotId || pick.slotId;
      }
      if (!batchId) continue;
      links.push({ slotId, batchId, plants });
    }
    if (links.length) return links;
  }
  const partials = Array.isArray(order?.sowingPartialCover) ? order.sowingPartialCover : [];
  const links = [];
  let held = 0;
  for (const p of partials) {
    const n = toQty(p.plants);
    if (n < 1) continue;
    const pick = batchForRequest(batchIndex, idStr(p.requestId), order._id);
    if (!pick) continue;
    links.push({ slotId: pick.slotId, batchId: idStr(pick.batch._id), plants: n });
    held += n;
  }
  const reqId = idStr(order?.sowingDoneRequestId);
  if (reqId) {
    const pick = batchForRequest(batchIndex, reqId, order._id);
    const plants =
      held > 0
        ? order.sowingDone
          ? Math.max(0, orderPlants(order) - held)
          : 0
        : orderPlants(order);
    if (pick && plants > 0) {
      links.push({ slotId: pick.slotId, batchId: idStr(pick.batch._id), plants });
    }
  }
  if (links.length) return links;
  return [];
}

/** Apply order.sowBatchLinks moves (oldest first) on top of the base links. */
export function applySowBatchLinks(baseLinks, moves) {
  const links = (baseLinks || []).map((l) => ({ ...l }));
  const sorted = [...(moves || [])].sort((a, b) => new Date(a.at || 0) - new Date(b.at || 0));
  for (const m of sorted) {
    let qty = toQty(m.plants);
    if (qty < 1) continue;
    const from = idStr(m.fromBatchId);
    if (from) {
      const src = links.find((l) => l.batchId === from);
      const take = Math.min(qty, src ? src.plants : 0);
      if (src) src.plants -= take;
      qty = take;
    }
    if (qty < 1) continue;
    const to = idStr(m.batchId);
    // No destination: the plants were taken for a dispatch and there is no batch to send the order to.
    if (!to) continue;
    const dst = links.find((l) => l.batchId === to);
    if (dst) dst.plants += qty;
    else links.push({ slotId: idStr(m.slotId), batchId: to, plants: qty });
  }
  return links.filter((l) => l.plants > 0);
}

/** `${batchId}|${orderId}` → plants dispatched (net of unloads) from batch dispatch logs. */
export function dispatchedByBatchOrder(batchIndex) {
  const map = new Map();
  for (const [batchId, e] of batchIndex) {
    for (const d of e.batch.dispatchLog || []) {
      const key = `${batchId}|${idStr(d.orderId)}`;
      map.set(key, (map.get(key) || 0) + (Number(d.plants) || 0));
    }
  }
  return map;
}

/** Links still waiting to be dispatched: link plants minus what already left that batch for the order. */
export function remainingOrderLinks(order, batchIndex, dispatchedMap) {
  const oid = idStr(order._id);
  return applySowBatchLinks(baseOrderLinks(order, batchIndex), order.sowBatchLinks)
    .map((l) => ({
      ...l,
      slotId: l.slotId || batchIndex.get(l.batchId)?.slotId || "",
      plants: Math.max(0, l.plants - Math.max(0, dispatchedMap.get(`${l.batchId}|${oid}`) || 0)),
    }))
    .filter((l) => l.plants > 0 && batchIndex.has(l.batchId));
}

/**
 * Pure plan for loading sow batches onto a vehicle, one selection per order + batch.
 *
 * - Plants of the order's own linked batch: COVER.
 * - Another batch B: its free excess first; the rest comes from B's other orders (FIFO by
 *   delivery, then booking), which are relinked to the batch(es) the order leaves. Whatever the
 *   order leaves behind and nobody takes becomes excess there (equal to the excess used on B).
 * - An order with no linked batch takes B's free excess (FREE). Anything still short comes from
 *   B's other orders, FIFO, with no relink (nowhere to send them). The line carries a warning.
 *
 * @param selections [{ orderId, batchId, plants }]
 * @param orderLinks Map orderId → [{ slotId, batchId, plants }] (remaining links)
 * @param batches Map batchId → { slotId, free, orders: [{ orderId, plants, deliveryMs, bookedMs, orderNo }] }
 *        `orders` = other orders that can be relinked (not on a vehicle, not delivered).
 */
export function planSowBatchLoad({ selections, orderLinks, batches, gifts }) {
  const giftLeft = new Map(
    [...(gifts || new Map())].map(([k, v]) => [String(k), Math.max(0, Math.floor(Number(v) || 0))])
  );
  const links = new Map(
    [...(orderLinks || new Map())].map(([k, v]) => [String(k), (v || []).map((l) => ({ ...l }))])
  );
  const pool = new Map(
    [...(batches || new Map())].map(([k, b]) => [
      String(k),
      {
        ...b,
        free: toQty(b.free),
        orders: [...(b.orders || [])]
          .map((o) => ({ ...o, plants: toQty(o.plants) }))
          .sort(
            (a, b2) =>
              (a.deliveryMs ?? Infinity) - (b2.deliveryMs ?? Infinity) ||
              (a.bookedMs ?? Infinity) - (b2.bookedMs ?? Infinity) ||
              (Number(a.orderNo) || 0) - (Number(b2.orderNo) || 0)
          ),
      },
    ])
  );
  const selectedOrderIds = new Set((selections || []).map((s) => String(s.orderId)));
  const lines = [];

  for (const sel of selections || []) {
    const orderId = String(sel.orderId || "");
    const batchId = String(sel.batchId || "");
    const q = toQty(sel.plants);
    if (!orderId || !batchId || q < 1) continue;
    const B = pool.get(batchId);
    if (!B) return { ok: false, error: `Batch ${batchId} not found for this plant` };
    const own = links.get(orderId) || [];
    links.set(orderId, own);
    const ownSnapshot = own.map((l) => ({
      slotId: l.slotId,
      batchId: l.batchId,
      plants: toQty(l.plants),
    }));

    const onB = own.find((l) => l.batchId === batchId);
    const cover = Math.min(q, onB ? onB.plants : 0);
    if (onB) onB.plants -= cover;
    // Watermelon free-per-crate is a pack gift. It rides on this order's own batch
    // and is not taken from other orders' cover or from bookable excess.
    let rest = q - cover;
    const giftHave = giftLeft.get(orderId) || 0;
    const gift = Math.min(rest, giftHave);
    if (gift > 0) {
      giftLeft.set(orderId, giftHave - gift);
      rest -= gift;
    }

    const line = {
      orderId,
      batchId,
      slotId: B.slotId,
      plants: q,
      cover,
      fromFree: 0,
      relinks: [],
      released: [],
      unlinkedTakes: [],
      warnings: [],
      bucket: "COVER",
    };

    if (rest > 0 && B.remaining != null) {
      // Cover is the sowing record. A short or minus balance still loads.
      const have = toQty(B.remaining);
      if (q > have) {
        line.warnings.push(
          `Available ${have}; loading ${q}. Stock goes minus and dispatch continues.`
        );
      }
      B.remaining = have - q;
      if (cover < 1) line.bucket = "FREE";
      line.fromRemaining = true;
    } else if (rest > 0) {
      const others = own.filter((l) => l.batchId !== batchId && l.plants > 0);
      const releasable = others.reduce((s, l) => s + l.plants, 0);
      const freeHave = Math.max(0, Number(B.free) || 0);
      const f = Math.min(rest, freeHave);
      const r = rest - f;

      if (releasable < 1) {
        line.bucket = "FREE";
        if (r > 0) {
          const takers = [];
          let need = r;
          for (const y of B.orders) {
            if (need <= 0) break;
            if (y.orderId === orderId || selectedOrderIds.has(y.orderId) || y.plants < 1) continue;
            const t = Math.min(need, y.plants);
            takers.push({ orderId: y.orderId, plants: t, ref: y });
            need -= t;
          }
          if (need > 0) {
            const booked = B.orders
              .filter((y) => y.orderId !== orderId && !selectedOrderIds.has(y.orderId))
              .reduce((s, y) => s + y.plants, 0);
            return {
              ok: false,
              error: `Batch has ${B.free} free + ${booked} booked by other orders; need ${rest}`,
            };
          }
          for (const t of takers) {
            t.ref.plants -= t.plants;
            const yl = links.get(t.orderId);
            if (yl) {
              const fromL = yl.find((l) => l.batchId === batchId);
              if (fromL) fromL.plants -= t.plants;
            }
            line.unlinkedTakes.push({
              orderId: t.orderId,
              plants: t.plants,
              fromBatchId: batchId,
              fromSlotId: B.slotId,
            });
          }
          const names = line.unlinkedTakes.map((t) => t.orderId).join(", ");
          line.warnings.push(
            `${r} plants taken from orders ${names} with no batch to move them to`
          );
        }
      } else {
        const released = Math.min(rest, releasable);
        if (r > released) {
          return {
            ok: false,
            error: `Batch has ${B.free} free plants; the order's own batch can take back only ${released} for other orders`,
          };
        }
        const takers = [];
        let need = r;
        for (const y of B.orders) {
          if (need <= 0) break;
          if (y.orderId === orderId || selectedOrderIds.has(y.orderId) || y.plants < 1) continue;
          const t = Math.min(need, y.plants);
          takers.push({ orderId: y.orderId, plants: t, ref: y });
          need -= t;
        }
        if (need > 0) {
          const booked = B.orders
            .filter((y) => y.orderId !== orderId && !selectedOrderIds.has(y.orderId))
            .reduce((s, y) => s + y.plants, 0);
          return {
            ok: false,
            error: `Batch has ${B.free} free + ${booked} booked by other orders; need ${rest}`,
          };
        }

        let releaseLeft = released;
        let takerIdx = 0;
        for (const a of others) {
          if (releaseLeft <= 0) break;
          const give = Math.min(a.plants, releaseLeft);
          a.plants -= give;
          releaseLeft -= give;
          const rel = { batchId: a.batchId, slotId: a.slotId, plants: give, toOrders: [], leftover: 0 };
          let left = give;
          while (left > 0 && takerIdx < takers.length) {
            const t = takers[takerIdx];
            const n = Math.min(left, t.plants);
            rel.toOrders.push({ orderId: t.orderId, plants: n });
            line.relinks.push({
              orderId: t.orderId,
              plants: n,
              fromBatchId: batchId,
              fromSlotId: B.slotId,
              toBatchId: a.batchId,
              toSlotId: a.slotId,
            });
            t.plants -= n;
            left -= n;
            if (t.plants <= 0) takerIdx += 1;
          }
          rel.leftover = left;
          line.released.push(rel);
          const A = pool.get(a.batchId);
          if (A) {
            A.free += left;
            for (const to of rel.toOrders) {
              const y = A.orders.find((o) => o.orderId === to.orderId);
              if (y) y.plants += to.plants;
              else A.orders.push({ orderId: to.orderId, plants: to.plants });
            }
          }
        }
        for (const rl of line.relinks) {
          const y = B.orders.find((o) => o.orderId === rl.orderId);
          if (y) y.plants -= rl.plants;
          const yl = links.get(rl.orderId);
          if (yl) {
            const fromL = yl.find((l) => l.batchId === rl.fromBatchId);
            if (fromL) fromL.plants -= rl.plants;
            const toL = yl.find((l) => l.batchId === rl.toBatchId);
            if (toL) toL.plants += rl.plants;
            else yl.push({ batchId: rl.toBatchId, slotId: rl.toSlotId, plants: rl.plants });
          }
        }
        line.bucket = "SWITCH";
      }
      line.fromFree = f;
      B.free -= f;
    }

    /** Order + slot: move cover off old linked batches onto the batch the shed picked. */
    line.coverRehome = [];
    if (line.bucket !== "COVER" && !line.fromRemaining) {
      let left = q;
      for (const a of ownSnapshot.filter((l) => l.batchId !== batchId && l.plants > 0)) {
        if (left < 1) break;
        const n = Math.min(left, a.plants);
        line.coverRehome.push({ fromSlotId: a.slotId, fromBatchId: a.batchId, plants: n });
        left -= n;
      }
    }

    lines.push(line);
  }
  return { ok: true, lines };
}

/** Plain-text summary of one planned line for the shed app confirmation. */
export function describeSowPlanLine(line, labels = {}) {
  const day = (id) => labels.batchDay?.(id) || "";
  const code = (id) => labels.orderCode?.(id) || id;
  if (line.fromRemaining) return `${day(line.batchId)}: ${line.plants} from plants left to dispatch`;
  if (line.bucket === "COVER") return `${day(line.batchId)}: ${line.plants} from its own batch`;
  const parts = [];
  if (line.cover) parts.push(`${line.cover} own`);
  if (line.fromFree) parts.push(`${line.fromFree} excess`);
  const taken = line.relinks.reduce((s, r) => s + r.plants, 0);
  if (taken) {
    parts.push(`${taken} from orders ${[...new Set(line.relinks.map((r) => `#${code(r.orderId)}`))].join(", ")}`);
  }
  const unlinked = line.unlinkedTakes || [];
  const unlinkedPlants = unlinked.reduce((s, r) => s + r.plants, 0);
  if (unlinkedPlants) {
    parts.push(
      `${unlinkedPlants} from orders ${[...new Set(unlinked.map((r) => `#${code(r.orderId)}`))].join(", ")}`
    );
  }
  let text = `${day(line.batchId)}: ${parts.join(" + ")}`;
  const moved = [...new Set(line.relinks.map((r) => r.toBatchId))].map(day).filter(Boolean);
  if (taken && moved.length) text += `. Those orders move to ${moved.join(", ")}`;
  if (unlinkedPlants) text += `. Those orders are not moved; they lose this batch`;
  const leftover = line.released.filter((r) => r.leftover > 0);
  if (leftover.length) {
    text += `. ${leftover.map((r) => `${r.leftover} of ${day(r.batchId)}`).join(", ")} become excess`;
  }
  return `${text}.`;
}

function batchView(entry, extra = {}, _bufferPct = 0) {
  const b = entry.batch;
  const stock = sowBatchStock(b);
  const sellablePlants = sellablePlantsOf(b);
  const dispatchedPlants = dispatchedPlantsOf(b);
  const availablePlants = availablePlantsOf(b);
  const ready = b.plantReadyDate || entry.slot.plantReadyDate || "";
  return {
    slotId: entry.slotId,
    batchId: idStr(b._id),
    sowingDate: b.sowingDate || "",
    plantReadyDate: ready,
    outDate: b.out || ready,
    slotStartDay: entry.slot.startDay || "",
    shedName: b.shedName || "",
    requestNumber: b.requestNumber || "",
    sowedPlants: stock.sowed,
    sellablePlants,
    dispatchedPlants,
    availablePlants,
    ...extra,
    freePlants: availablePlants,
  };
}

/** Batch fields the sow planner / free calc needs — never pull changeLog / trails (MBs). */
const SOW_BATCH_PLAN_FIELDS = {
  _id: "$$b._id",
  sowingRequestId: "$$b.sowingRequestId",
  requestNumber: "$$b.requestNumber",
  sowingDate: "$$b.sowingDate",
  plantReadyDate: "$$b.plantReadyDate",
  out: "$$b.out",
  plantsSowed: "$$b.plantsSowed",
  orderCoveredPlants: "$$b.orderCoveredPlants",
  excessPlants: "$$b.excessPlants",
  shownExcess: "$$b.shownExcess",
  bufferPlants: "$$b.bufferPlants",
  sowingBufferPct: "$$b.sowingBufferPct",
  mortalityMovedToExcess: "$$b.mortalityMovedToExcess",
  excessMovedToMortality: "$$b.excessMovedToMortality",
  destroyedPlants: "$$b.destroyedPlants",
  expectedMortalityApplied: "$$b.expectedMortalityApplied",
  actualPlantsApplied: "$$b.actualPlantsApplied",
  availablePlantsApplied: "$$b.availablePlantsApplied",
  noMortalityReserve: "$$b.noMortalityReserve",
  isIrrelevant: "$$b.isIrrelevant",
  isExcessiveSowing: "$$b.isExcessiveSowing",
  shedName: "$$b.shedName",
  linkedOrderIds: "$$b.linkedOrderIds",
  excessAllocations: "$$b.excessAllocations",
  dispatchLog: "$$b.dispatchLog",
};

/**
 * Lean plant-slot docs for planning. Full year docs are ~tens of MB (changeLog etc);
 * only keep the matching subtype + slots that have sowing batches + planner fields.
 */
async function loadSlotDocs(plantId, subtypeId, session, hydrate) {
  const plantOid = new mongoose.Types.ObjectId(String(plantId));
  const subtypeOid = new mongoose.Types.ObjectId(String(subtypeId));
  const match = {
    plantId: plantOid,
    "subtypeSlots.subtypeId": subtypeOid,
  };
  if (hydrate) {
    return PlantSlot.find(match).session(session || null);
  }

  const pipeline = [
    { $match: match },
    {
      $project: {
        year: 1,
        plantId: 1,
        subtypeSlots: {
          $map: {
            input: {
              $filter: {
                input: { $ifNull: ["$subtypeSlots", []] },
                as: "st",
                cond: { $eq: ["$$st.subtypeId", subtypeOid] },
              },
            },
            as: "st",
            in: {
              subtypeId: "$$st.subtypeId",
              slots: {
                $map: {
                  input: {
                    $filter: {
                      input: { $ifNull: ["$$st.slots", []] },
                      as: "sl",
                      cond: {
                        $gt: [
                          { $size: { $ifNull: ["$$sl.sowingBatches", []] } },
                          0,
                        ],
                      },
                    },
                  },
                  as: "sl",
                  in: {
                    _id: "$$sl._id",
                    startDay: "$$sl.startDay",
                    endDay: "$$sl.endDay",
                    plantReadyDate: "$$sl.plantReadyDate",
                    availablePlants: "$$sl.availablePlants",
                    orderReservedPlants: "$$sl.orderReservedPlants",
                    expectedMortality: "$$sl.expectedMortality",
                    actualPlants: "$$sl.actualPlants",
                    excessiveSowing: "$$sl.excessiveSowing",
                    sowingBatches: {
                      $map: {
                        input: { $ifNull: ["$$sl.sowingBatches", []] },
                        as: "b",
                        in: SOW_BATCH_PLAN_FIELDS,
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  ];

  const agg = PlantSlot.aggregate(pipeline);
  if (session) agg.session(session);
  return agg;
}

const ORDER_SELECT =
  "orderId publicOrderCode farmer numberOfPlants additionalPlants orderStatus vehicleLoaded deliveryDate orderBookingDate createdAt plantName plantSubtype sowingDone sowingDoneRequestId sowingPartialCover sowingCoverSources sowingCoverReversedAt sowBatchLinks";

/**
 * Everything the planner needs for one plant/subtype: batch index, each order's remaining links,
 * and per batch its free plants and the other orders that can be relinked.
 */
export async function loadSowDispatchContext(
  plantId,
  subtypeId,
  {
    session,
    vehicleOrderIds = [],
    hydrate = false,
    withFarmer = true,
    /** Load POST only: shrink batch pool to slots touched by picked batches. */
    nearBatchIds = null,
  } = {}
) {
  // Slots + CMS buffer in parallel — order query needs the batch index first.
  const [slotDocs, bufferByPlant] = await Promise.all([
    loadSlotDocs(plantId, subtypeId, session, hydrate),
    sowingBufferPctByPlantId([plantId]),
  ]);
  let batchIndex = indexSowBatches(slotDocs, subtypeId);
  if (nearBatchIds?.length) {
    batchIndex = restrictBatchIndexToSlotNeighborhood(batchIndex, nearBatchIds);
  }
  const reqIds = [
    ...new Set([...batchIndex.values()].map((e) => idStr(e.batch.sowingRequestId)).filter(Boolean)),
  ].map((id) => new mongoose.Types.ObjectId(id));
  const batchOids = [...batchIndex.keys()].map((id) => new mongoose.Types.ObjectId(id));
  const vehicleOids = vehicleOrderIds
    .map(idStr)
    .filter((id) => mongoose.isValidObjectId(id))
    .map((id) => new mongoose.Types.ObjectId(id));

  let orderQuery = Order.find({
    plantName: new mongoose.Types.ObjectId(String(plantId)),
    plantSubtype: new mongoose.Types.ObjectId(String(subtypeId)),
    orderStatus: { $nin: CLOSED_ORDER_STATUSES },
    $or: [
      { _id: { $in: vehicleOids } },
      ...(reqIds.length ? [{ sowingDoneRequestId: { $in: reqIds } }] : []),
      ...(batchOids.length
        ? [
            { "sowingCoverSources.batchId": { $in: batchOids } },
            { "sowingCoverSources.destBatchId": { $in: batchOids } },
            { "sowBatchLinks.batchId": { $in: batchOids } },
          ]
        : []),
    ],
  })
    .select(ORDER_SELECT)
    .session(session || null);
  if (withFarmer) orderQuery = orderQuery.populate("farmer", "name village");
  const entryQuery = batchOids.length
    ? SowingEntry.find({ sourceBatchId: { $in: batchOids } })
        .select("sourceBatchId dispatchedPlants")
        .session(session || null)
        .lean()
    : Promise.resolve([]);
  const [orders, entryRows] = await Promise.all([orderQuery.lean(), entryQuery]);
  const dispatchedStored = new Map(
    (entryRows || []).map((row) => [
      String(row.sourceBatchId),
      Math.max(0, Math.floor(Number(row.dispatchedPlants) || 0)),
    ])
  );

  const dispatched = dispatchedByBatchOrder(batchIndex);
  const vehicleSet = new Set(vehicleOids.map(String));
  const orderLinks = new Map();
  const orderById = new Map();
  const bufferPct = bufferByPlant.get(String(plantId)) || 0;
  const batches = new Map(
    [...batchIndex].map(([batchId, e]) => [
      batchId,
      {
        slotId: e.slotId,
        free: dispatchBookableFree(batchWithGridCover(e.batch, orders), bufferPct),
        remaining: Math.max(
          0,
          sellablePlantsOf(e.batch) - (dispatchedStored.get(batchId) || 0)
        ),
        orders: [],
      },
    ])
  );

  for (const o of orders) {
    const oid = idStr(o._id);
    orderById.set(oid, o);
    const links = remainingOrderLinks(o, batchIndex, dispatched);
    orderLinks.set(oid, links);
    const relinkable =
      !vehicleSet.has(oid) && !o.vehicleLoaded && !NOT_RELINKABLE_STATUSES.includes(o.orderStatus);
    if (!relinkable) continue;
    for (const l of links) {
      batches.get(l.batchId)?.orders.push({
        orderId: oid,
        plants: l.plants,
        deliveryMs: o.deliveryDate ? new Date(o.deliveryDate).getTime() : Infinity,
        bookedMs: new Date(o.orderBookingDate || o.createdAt || 0).getTime(),
        orderNo: o.orderId,
      });
    }
  }

  return { slotDocs, batchIndex, orders, orderById, orderLinks, batches, bufferPct };
}

/** Keep batches on the same ready-day slots as the picks (smaller order link query on load). */
function restrictBatchIndexToSlotNeighborhood(batchIndex, seedBatchIds) {
  const seeds = new Set([...(seedBatchIds || [])].map((id) => idStr(id)).filter(Boolean));
  if (!seeds.size) return batchIndex;
  const slotIds = new Set();
  for (const [bid, e] of batchIndex) {
    if (seeds.has(bid)) slotIds.add(idStr(e.slotId));
  }
  if (!slotIds.size) return batchIndex;
  const out = new Map();
  for (const [bid, e] of batchIndex) {
    if (slotIds.has(idStr(e.slotId))) out.set(bid, e);
  }
  return out.size ? out : batchIndex;
}

const orderCode = (o) => String(o?.orderId || o?.publicOrderCode || "");

async function resolveSowRow(dispatchDoc, plantRowIndex) {
  const rowIdx = Math.max(0, Number(plantRowIndex) || 0);
  const row = await resolvePlantRowFromDispatch(dispatchDoc, rowIdx);
  if (!(await isPlantSowingAllowed(row.plantId))) {
    throw new AppError("Plant is not sowingAllowed — use secondary inward load", 400);
  }
  const unionIds = unionDispatchOrderObjectIds(dispatchDoc);
  const rowOrders = await Order.find({
    _id: { $in: unionIds },
    plantName: row.plantId,
    plantSubtype: row.subTypeId,
    orderStatus: { $nin: CLOSED_ORDER_STATUSES },
  })
    .select("_id orderId")
    .sort({ orderId: 1 })
    .lean();
  return { rowIdx, row, rowOrderIds: rowOrders.map((o) => idStr(o._id)) };
}

/** Free plants still to load on these orders (slip pack minus billed qty). */
function packGiftByOrder(dispatchDoc, orderIds) {
  const want = new Set((orderIds || []).map((id) => String(id)));
  const map = new Map();
  for (const line of dispatchDoc?.orderDispatchDetails || []) {
    const id = String(line?.orderId || "");
    if (!want.has(id)) continue;
    const billed = Math.max(0, Number(line?.dispatchQuantity) || 0);
    const pack = packQtyFromOrderDispatchRow(line);
    const loaded = Math.max(0, Number(line?.shedLoadedQuantity) || 0);
    const billedLeft = Math.max(0, billed - Math.min(loaded, billed));
    const left = Math.max(0, pack - loaded);
    const gift = Math.max(0, left - billedLeft);
    if (gift > 0) map.set(id, gift);
  }
  return map;
}

function packGiftStillToLoad(dispatchDoc, orderIds) {
  let gift = 0;
  for (const n of packGiftByOrder(dispatchDoc, orderIds).values()) gift += n;
  return gift;
}

/** Plants already on this vehicle for these orders, from the dispatch itself. */
function plantsLoadedOnRow(dispatchDoc, orderIds = []) {
  const want = new Set((orderIds || []).map((id) => String(id)));
  let loaded = 0;
  for (const line of dispatchDoc?.orderDispatchDetails || []) {
    if (!want.has(String(line?.orderId || ""))) continue;
    loaded += Math.max(0, Number(line.shedLoadedQuantity) || 0);
  }
  return loaded;
}

function rowRemaining(dispatchDoc, row, orderIds = []) {
  const need = Number(row.quantity ?? row.totalPlants ?? 0) || 0;
  const gift = packGiftStillToLoad(dispatchDoc, orderIds);
  return Math.max(0, need + gift - plantsLoadedOnRow(dispatchDoc, orderIds));
}

/** One sowingentries document as the batch row the shed app reads. */
function viewFromSowingEntry(doc) {
  const batch = {
    plantsSowed: doc?.plantsSowed,
    destroyedPlants: 0,
    bufferPlants: doc?.bufferPlants,
    sowingBufferPct: doc?.sowingBufferPct,
    mortalityMovedToExcess: doc?.mortalityMovedToExcess,
    excessMovedToMortality: doc?.excessMovedToMortality,
    noMortalityReserve: doc?.noMortalityReserve,
    isIrrelevant: doc?.isIrrelevant,
    dispatchLog: [],
  };
  const sellable = sellablePlantsOf(batch);
  const dispatched = Math.max(0, Math.floor(Number(doc?.dispatchedPlants) || 0));
  const available = sellable - dispatched;
  const ready = doc?.plantReadyDate || "";
  return {
    slotId: "",
    batchId: idStr(doc?.sourceBatchId),
    sowingDate: doc?.sowingDate || doc?.sowDay || "",
    plantReadyDate: ready,
    outDate: doc?.out || ready,
    slotStartDay: "",
    shedName: doc?.shedName || "",
    requestNumber: doc?.requestNumber || "",
    sowedPlants: Math.max(0, Math.floor(Number(doc?.plantsSowed) || 0)),
    sellablePlants: sellable,
    dispatchedPlants: dispatched,
    availablePlants: available,
    bookedForOthers: 0,
    otherOrders: (doc?.linkedOrderIds || []).length,
    freePlants: available,
  };
}

/**
 * GET sow-batch-options from sowingentries only.
 * The year slot document stays out of this read so the sheet opens quickly.
 */
export async function listSowBatchOptionsForDispatch(dispatchId, plantRowIndex = 0) {
  const dispatchDoc = await findDispatchActiveByIdOrTransport(dispatchId);
  if (!dispatchDoc) throw new AppError("Vehicle dispatch not found", 404);
  const { rowIdx, row, rowOrderIds } = await resolveSowRow(dispatchDoc, plantRowIndex);
  const plantOid = new mongoose.Types.ObjectId(String(row.plantId));
  const subtypeOid = new mongoose.Types.ObjectId(String(row.subTypeId));
  const orderOids = rowOrderIds
    .filter((id) => mongoose.Types.ObjectId.isValid(String(id)))
    .map((id) => new mongoose.Types.ObjectId(String(id)));

  const [docs, orderRows] = await Promise.all([
    SowingEntry.find({ plantId: plantOid, subtypeId: subtypeOid, isIrrelevant: { $ne: true } })
      .select(
        "sourceBatchId sowingRequestId sowingDate sowDay plantReadyDate out shedName requestNumber plantsSowed orderCoveredPlants bufferPlants sowingBufferPct mortalityMovedToExcess excessMovedToMortality noMortalityReserve dispatchedPlants linkedOrderIds"
      )
      .lean(),
    orderOids.length
      ? Order.find({ _id: { $in: orderOids } })
          .select(
            "orderId numberOfPlants additionalPlants deliveryDate sowingDone sowingDoneRequestId sowingCoverSources sowingPartialCover sowBatchLinks sowingCoverReversedAt farmer"
          )
          .populate("farmer", "name village")
          .lean()
      : [],
  ]);

  const batchIndex = new Map();
  const byId = new Map();
  for (const doc of docs) {
    const id = idStr(doc.sourceBatchId);
    if (!id) continue;
    byId.set(id, doc);
    batchIndex.set(id, {
      slotId: "",
      batch: {
        _id: doc.sourceBatchId,
        sowingRequestId: doc.sowingRequestId,
        linkedOrderIds: doc.linkedOrderIds || [],
        dispatchLog: [],
      },
    });
  }

  const remaining = vehicleLineRemainingMap(dispatchDoc, rowOrderIds);
  const orders = orderRows.map((o) => {
    const oid = idStr(o._id);
    const linked = remainingOrderLinks(o, batchIndex, new Map())
      .map((l) => {
        const doc = byId.get(l.batchId);
        if (!doc) return null;
        return { ...viewFromSowingEntry(doc), linkedPlants: l.plants };
      })
      .filter(Boolean);
    linked.sort((a, b) => dmyMs(a.outDate || a.plantReadyDate) - dmyMs(b.outDate || b.plantReadyDate));
    return {
      orderId: oid,
      orderNo: o.orderId ?? null,
      orderCode: orderCode(o),
      farmerName: o.farmer?.name || "",
      village: o.farmer?.village || "",
      deliveryDate: o.deliveryDate || null,
      orderPlants: orderPlants(o),
      remainingOnVehicle: remaining.get(oid) ?? 0,
      linked,
    };
  });

  const seenBatch = new Set();
  const batches = [];
  for (const doc of docs) {
    const id = idStr(doc.sourceBatchId);
    if (!id || seenBatch.has(id)) continue;
    seenBatch.add(id);
    batches.push(viewFromSowingEntry(doc));
  }
  batches.sort(
    (a, b) =>
      dmyMs(a.outDate || a.plantReadyDate) - dmyMs(b.outDate || b.plantReadyDate) ||
      dmyMs(a.sowingDate) - dmyMs(b.sowingDate)
  );
  return {
    dispatchId: idStr(dispatchDoc._id),
    plantRowIndex: rowIdx,
    plantId: idStr(row.plantId),
    subtypeId: idStr(row.subTypeId),
    plantRowQuantity: Number(row.quantity ?? row.totalPlants ?? 0) || 0,
    rowRemaining: rowRemaining(dispatchDoc, row, rowOrderIds),
    orders,
    batches: sowingsForDispatch(batches, orders),
  };
}

function sowingAvailable(batch) {
  const n = Number(batch?.availablePlants);
  if (Number.isFinite(n)) return n;
  return Number(batch?.freePlants) || 0;
}

/**
 * Every sowing that still has plants, plus the one the order is already linked to.
 * Linked sowings stay first so the load sheet opens on that sowing.
 */
export function sowingsForDispatch(batches, orders) {
  const list = Array.isArray(batches) ? batches : [];
  const linkedIds = new Set();
  for (const order of orders || []) {
    for (const link of order?.linked || []) {
      if (link?.batchId) linkedIds.add(String(link.batchId));
    }
  }
  const visible = list.filter(
    (b) => sowingAvailable(b) !== 0 || linkedIds.has(String(b.batchId))
  );
  const pool = visible.length ? visible : list;
  return pool.slice().sort((a, b) => {
    const aLinked = linkedIds.has(String(a.batchId)) ? 0 : 1;
    const bLinked = linkedIds.has(String(b.batchId)) ? 0 : 1;
    if (aLinked !== bLinked) return aLinked - bLinked;
    return (
      dmyMs(a.outDate || a.plantReadyDate) - dmyMs(b.outDate || b.plantReadyDate) ||
      dmyMs(a.sowingDate) - dmyMs(b.sowingDate)
    );
  });
}

export function normalizeSowBatchSelections(raw) {
  const merged = new Map();
  for (const s of Array.isArray(raw) ? raw : []) {
    const orderId = idStr(s?.orderId);
    const batchId = idStr(s?.batchId);
    const plants = toQty(s?.plants);
    if (!orderId || !batchId || plants < 1) continue;
    const key = `${orderId}|${batchId}`;
    const prev = merged.get(key) || { orderId, batchId, slotId: idStr(s?.slotId), plants: 0 };
    prev.plants += plants;
    merged.set(key, prev);
  }
  return [...merged.values()];
}

function validateSelections({ selections, rowOrderIds, remaining, cap }) {
  if (!selections.length) throw new AppError("sowBatchSelections with orderId, batchId and plants required", 400);
  const onRow = new Set(rowOrderIds);
  const perOrder = new Map();
  for (const s of selections) {
    if (!onRow.has(s.orderId)) throw new AppError("Order is not on this plant row of the vehicle", 400);
    perOrder.set(s.orderId, (perOrder.get(s.orderId) || 0) + s.plants);
  }
  for (const [oid, plants] of perOrder) {
    const left = remaining.get(oid) ?? 0;
    if (plants > left) throw new AppError(`Order needs only ${left} more plants on this vehicle`, 400);
  }
  const total = selections.reduce((s, x) => s + x.plants, 0);
  if (total > cap) throw new AppError(`Selection ${total} exceeds remaining need of this plant row ${cap}`, 400);
  return total;
}

function planLabels(ctx) {
  return {
    batchDay: (id) => {
      const e = ctx.batchIndex.get(String(id));
      const d = e?.batch?.plantReadyDate || e?.batch?.sowingDate || "";
      return d ? moment(d, "DD-MM-YYYY").format("D MMM") : "";
    },
    orderCode: (id) => orderCode(ctx.orderById.get(String(id))),
  };
}

/**
 * Plan inputs from sowingentries. Opening the load sheet does not read year slot documents.
 */
async function loadEntryDispatchPlan(plantId, subtypeId, orderIds, session) {
  const plantOid = new mongoose.Types.ObjectId(String(plantId));
  const subtypeOid = new mongoose.Types.ObjectId(String(subtypeId));
  const orderOids = (orderIds || [])
    .filter((id) => mongoose.Types.ObjectId.isValid(String(id)))
    .map((id) => new mongoose.Types.ObjectId(String(id)));
  const [docs, orderRows] = await Promise.all([
    SowingEntry.find({ plantId: plantOid, subtypeId: subtypeOid, isIrrelevant: { $ne: true } })
      .select(
        "sourceBatchId sowingRequestId sowingDate plantReadyDate shedName requestNumber plantsSowed bufferPlants sowingBufferPct mortalityMovedToExcess excessMovedToMortality noMortalityReserve isIrrelevant dispatchedPlants linkedOrderIds"
      )
      .session(session || null)
      .lean(),
    orderOids.length
      ? Order.find({ _id: { $in: orderOids } })
          .select(
            "orderId sowingDone sowingDoneRequestId sowingCoverSources sowingPartialCover sowBatchLinks sowingCoverReversedAt"
          )
          .session(session || null)
          .lean()
      : [],
  ]);
  const batchIndex = new Map();
  const batches = new Map();
  for (const doc of docs) {
    const id = idStr(doc.sourceBatchId);
    if (!id) continue;
    batchIndex.set(id, {
      slotId: "",
      batch: {
        _id: doc.sourceBatchId,
        sowingRequestId: doc.sowingRequestId,
        sowingDate: doc.sowingDate || "",
        plantReadyDate: doc.plantReadyDate || "",
        shedName: doc.shedName || "",
        requestNumber: doc.requestNumber || "",
        linkedOrderIds: doc.linkedOrderIds || [],
        dispatchLog: [],
      },
    });
    const sellable = sellablePlantsOf({
      plantsSowed: doc.plantsSowed,
      bufferPlants: doc.bufferPlants,
      sowingBufferPct: doc.sowingBufferPct,
      mortalityMovedToExcess: doc.mortalityMovedToExcess,
      excessMovedToMortality: doc.excessMovedToMortality,
      noMortalityReserve: doc.noMortalityReserve,
      isIrrelevant: doc.isIrrelevant,
      dispatchLog: [],
    });
    const dispatched = Math.max(0, Math.floor(Number(doc.dispatchedPlants) || 0));
    batches.set(id, {
      slotId: "",
      free: 0,
      remaining: Math.max(0, sellable - dispatched),
      orders: [],
    });
  }
  const orderLinks = new Map();
  const orderById = new Map();
  for (const order of orderRows) {
    const oid = idStr(order._id);
    orderById.set(oid, order);
    orderLinks.set(oid, remainingOrderLinks(order, batchIndex, new Map()));
  }
  return { batchIndex, batches, orderLinks, orderById };
}

/**
 * Load plan for the sowings the shed picked. A short sowing goes minus and does not stop the load.
 * Only those sowing entries are read.
 */
export function directSowingLoadPlan(selections, batches) {
  const pool = batches || new Map();
  const lines = [];
  for (const sel of selections || []) {
    const orderId = String(sel.orderId || "");
    const batchId = String(sel.batchId || "");
    const plants = toQty(sel.plants);
    if (!orderId || !batchId || plants < 1) continue;
    const row = pool.get(batchId);
    const have = row ? Math.floor(Number(row.remaining) || 0) : 0;
    if (row) row.remaining = have - plants;
    lines.push({
      orderId,
      batchId,
      slotId: row?.slotId || "",
      plants,
      cover: 0,
      fromFree: 0,
      fromRemaining: true,
      relinks: [],
      released: [],
      unlinkedTakes: [],
      warnings:
        plants > have
          ? [`Available ${have}; loading ${plants}. Stock goes minus and dispatch continues.`]
          : [],
      bucket: "FREE",
      coverRehome: [],
    });
  }
  if (!lines.length) return { ok: false, error: "Choose plants to load" };
  return { ok: true, lines };
}

async function loadPickedSowingEntries(batchIds, session) {
  const sourceIds = [...new Set((batchIds || []).map((id) => idStr(id)).filter(Boolean))]
    .map((id) => new mongoose.Types.ObjectId(id));
  const docs = sourceIds.length
    ? await SowingEntry.find({ sourceBatchId: { $in: sourceIds } })
        .select(
          "sourceBatchId sowingRequestId sowingDate plantReadyDate shedName requestNumber plantsSowed bufferPlants sowingBufferPct mortalityMovedToExcess excessMovedToMortality noMortalityReserve isIrrelevant dispatchedPlants"
        )
        .session(session || null)
        .lean()
    : [];
  const batchIndex = new Map();
  const batches = new Map();
  for (const doc of docs) {
    const id = idStr(doc.sourceBatchId);
    if (!id) continue;
    batchIndex.set(id, {
      slotId: "",
      batch: {
        _id: doc.sourceBatchId,
        sowingRequestId: doc.sowingRequestId,
        sowingDate: doc.sowingDate || "",
        plantReadyDate: doc.plantReadyDate || "",
        shedName: doc.shedName || "",
        requestNumber: doc.requestNumber || "",
        dispatchLog: [],
      },
    });
    const sellable = sellablePlantsOf({
      plantsSowed: doc.plantsSowed,
      bufferPlants: doc.bufferPlants,
      sowingBufferPct: doc.sowingBufferPct,
      mortalityMovedToExcess: doc.mortalityMovedToExcess,
      excessMovedToMortality: doc.excessMovedToMortality,
      noMortalityReserve: doc.noMortalityReserve,
      isIrrelevant: doc.isIrrelevant,
      dispatchLog: [],
    });
    const dispatched = Math.max(0, Math.floor(Number(doc.dispatchedPlants) || 0));
    batches.set(id, {
      slotId: "",
      free: 0,
      remaining: sellable - dispatched,
      orders: [],
    });
  }
  return { batchIndex, batches, orderById: new Map() };
}

/** POST sow-load-preview: the plan for the selections, no writes. */
export async function previewSowBatchLoad({ dispatchId, plantRowIndex = 0, sowBatchSelections }) {
  const dispatchDoc = await findDispatchActiveByIdOrTransport(dispatchId);
  if (!dispatchDoc) throw new AppError("Vehicle dispatch not found", 404);
  const { rowIdx, row, rowOrderIds } = await resolveSowRow(dispatchDoc, plantRowIndex);
  const selections = normalizeSowBatchSelections(sowBatchSelections);
  validateSelections({
    selections,
    rowOrderIds,
    remaining: vehicleLineRemainingMap(dispatchDoc, rowOrderIds),
    cap: rowRemaining(dispatchDoc, row, rowOrderIds),
  });
  const ctx = await loadPickedSowingEntries(selections.map((s) => s.batchId));
  const plan = directSowingLoadPlan(selections, ctx.batches);
  if (!plan.ok) throw new AppError(plan.error, 400);
  const labels = planLabels(ctx);
  return {
    plantRowIndex: rowIdx,
    lines: plan.lines.map((l) => ({
      ...l,
      sowingDate: ctx.batchIndex.get(l.batchId)?.batch?.sowingDate || "",
      plantReadyDate: ctx.batchIndex.get(l.batchId)?.batch?.plantReadyDate || "",
      summary: describeSowPlanLine(l, labels),
      warnings: l.warnings || [],
      relinks: l.relinks.map((r) => ({ ...r, orderCode: labels.orderCode(r.orderId) })),
      unlinkedTakes: (l.unlinkedTakes || []).map((t) => ({ ...t, orderCode: labels.orderCode(t.orderId) })),
    })),
    warnings: plan.lines.flatMap((l) => l.warnings || []),
  };
}

function setSlotAvailable(slot, delta, performedBy, remark) {
  if (!delta) return;
  const prev = Number(slot.availablePlants) || 0;
  applyStockFieldUpdates(slot, { availablePlants: Math.max(0, prev + delta) }, performedBy, remark);
}

function addSlotReserved(slot, delta) {
  if (!delta) return;
  slot.orderReservedPlants = Math.max(0, (Number(slot.orderReservedPlants) || 0) + delta);
}

function addSlotExcess(slot, delta) {
  if (!delta) return;
  if (!slot.excessiveSowing) slot.excessiveSowing = {};
  slot.excessiveSowing.plants = Math.max(0, (Number(slot.excessiveSowing.plants) || 0) + delta);
}

/** Bookable excess already stored on this batch. Do not recompute — that pulls mortality into excess. */
function stampedBookableExcess(batch) {
  if (!batch || batch.isIrrelevant) return 0;
  if (batch.shownExcess != null && batch.shownExcess !== "") {
    return Math.max(0, Math.floor(Number(batch.shownExcess) || 0));
  }
  return Math.max(0, Math.floor(Number(batch.excessPlants) || 0));
}

function addToSet(arr, id) {
  if (!id) return;
  if (!arr.some((x) => idStr(x) === String(id))) arr.push(new mongoose.Types.ObjectId(String(id)));
}

/**
 * Apply one planned line's batch/slot bookkeeping (excess move, released leftovers, link sets).
 * Returns the reserved/available decrements taken for the dispatch itself.
 *
 * SWITCH/FREE: slot stock + order cover follow the picked batch (see coverRehome / sowBatchLinks).
 */
export function applySowPlanLineToSlots({
  line,
  batchIndex,
  performedBy,
  transportId,
  now,
  dispatchId = null,
}) {
  const B = batchIndex.get(line.batchId);
  if (!B) throw new AppError("Sowing batch not found", 404);
  const tag = `vehicle ${transportId || ""}`.trim();
  const logBase = { at: now, by: performedBy, orderId: line.orderId, dispatchId };

  if (line.fromFree > 0) {
    const f = line.fromFree;
    const freeBefore = stampedBookableExcess(B.batch);
    const coverBefore = toQty(B.batch.orderCoveredPlants);
    B.batch.orderCoveredPlants = coverBefore + f;
    B.batch.excessPlants = Math.max(0, toQty(B.batch.excessPlants) - f);
    B.batch.shownExcess = Math.max(0, freeBefore - f);
    pushBatchChangeLog(B.batch, {
      ...logBase,
      kind: "DISPATCH_TAKE",
      plants: -f,
      coverBefore,
      coverAfter: B.batch.orderCoveredPlants,
      excessBefore: freeBefore,
      excessAfter: B.batch.shownExcess,
      reason: `Dispatch took ${f} leftover plants · ${tag}`,
    });
    if (!Array.isArray(B.batch.excessAllocations)) B.batch.excessAllocations = [];
    B.batch.excessAllocations.push({
      orderId: new mongoose.Types.ObjectId(line.orderId),
      plants: f,
      at: now,
      by: performedBy || undefined,
    });
    setSlotAvailable(B.slot, -f, performedBy, `Dispatch batch pick · ${f} excess to order · ${tag}`);
    addSlotReserved(B.slot, f);
    addSlotExcess(B.slot, -f);
  }

  for (const rel of line.released) {
    const A = batchIndex.get(rel.batchId);
    if (!A) continue;
    for (const to of rel.toOrders) addToSet(A.batch.linkedOrderIds || (A.batch.linkedOrderIds = []), to.orderId);

    const switched = toQty(rel.plants);
    if (switched > 0) {
      // Count against remaining links on the original batch without rewriting sow identity.
      if (!Array.isArray(A.batch.dispatchLog)) A.batch.dispatchLog = [];
      A.batch.dispatchLog.push({
        at: now,
        by: performedBy || undefined,
        dispatchId: dispatchId || undefined,
        orderId: new mongoose.Types.ObjectId(line.orderId),
        plants: switched,
        bucket: "SWITCH",
        reason: `Order loaded from another batch · ${switched} plants · ${tag}`,
      });
      const coverSnap = toQty(A.batch.orderCoveredPlants);
      const freeSnap = stampedBookableExcess(A.batch);
      pushBatchChangeLog(A.batch, {
        ...logBase,
        kind: "DISPATCH_SWITCH",
        plants: -switched,
        coverBefore: coverSnap,
        coverAfter: coverSnap,
        excessBefore: freeSnap,
        excessAfter: freeSnap,
        reason: `Linked order load switched away · −${switched} · ${tag}`,
      });
    }

    const left = toQty(rel.leftover);
    if (left < 1) continue;
    const freeBefore = stampedBookableExcess(A.batch);
    const coverBefore = toQty(A.batch.orderCoveredPlants);
    A.batch.orderCoveredPlants = Math.max(0, coverBefore - left);
    A.batch.excessPlants = toQty(A.batch.excessPlants) + left;
    A.batch.shownExcess = freeBefore + left;
    pushBatchChangeLog(A.batch, {
      ...logBase,
      kind: "DISPATCH_RELEASE",
      plants: left,
      coverBefore,
      coverAfter: A.batch.orderCoveredPlants,
      excessBefore: freeBefore,
      excessAfter: A.batch.shownExcess,
      reason: `Dispatch leftover ${left} plants became excess · ${tag}`,
    });
    let trim = left;
    for (const alloc of A.batch.excessAllocations || []) {
      if (trim <= 0) break;
      if (idStr(alloc.orderId) !== line.orderId) continue;
      const t = Math.min(trim, toQty(alloc.plants));
      alloc.plants = toQty(alloc.plants) - t;
      trim -= t;
    }
    addSlotReserved(A.slot, -left);
    setSlotAvailable(A.slot, left, performedBy, `Dispatch batch pick · ${left} released to excess · ${tag}`);
    addSlotExcess(A.slot, left);
  }

  // Cover list for the picked batch should show this order (with Dispatched tag in UI).
  // Do NOT rewrite order.sowBatchLinks / sowingDoneRequestId — original sow day stays the identity.
  if (line.bucket !== "COVER") {
    addToSet(B.batch.linkedOrderIds || (B.batch.linkedOrderIds = []), line.orderId);
  }

  const reserved = Math.max(0, Number(B.slot.orderReservedPlants) || 0);
  const reservedDec = Math.min(line.plants, reserved);
  const availableDec = Math.min(line.plants - reservedDec, Math.max(0, Number(B.slot.availablePlants) || 0));
  addSlotReserved(B.slot, -reservedDec);
  setSlotAvailable(B.slot, -availableDec, performedBy, `Sow batch load · ${tag}`);

  const bookedTake = Math.max(0, line.plants - (Number(line.fromFree) || 0));
  if (bookedTake > 0) {
    const freeSnap = stampedBookableExcess(B.batch);
    const coverSnap = toQty(B.batch.orderCoveredPlants);
    pushBatchChangeLog(B.batch, {
      ...logBase,
      kind: line.bucket === "COVER" ? "DISPATCH_COVER" : "DISPATCH_LOAD",
      plants: -bookedTake,
      coverBefore: coverSnap,
      coverAfter: coverSnap,
      excessBefore: freeSnap,
      excessAfter: freeSnap,
      reason: `${line.bucket} load ${bookedTake} plants · ${tag}`,
    });
  }

  for (const rh of line.coverRehome || []) {
    const rel = (line.released || []).find((r) => idStr(r.batchId) === idStr(rh.fromBatchId));
    const alreadyOnSlot = rel ? toQty(rel.plants) : 0;
    const extra = toQty(rh.plants) - alreadyOnSlot;
    if (extra < 1) continue;
    const A = batchIndex.get(rh.fromBatchId);
    if (!A) continue;
    const freeBefore = stampedBookableExcess(A.batch);
    const coverBefore = toQty(A.batch.orderCoveredPlants);
    A.batch.orderCoveredPlants = Math.max(0, coverBefore - extra);
    A.batch.excessPlants = toQty(A.batch.excessPlants) + extra;
    A.batch.shownExcess = freeBefore + extra;
    pushBatchChangeLog(A.batch, {
      ...logBase,
      kind: "DISPATCH_RELEASE",
      plants: extra,
      coverBefore,
      coverAfter: A.batch.orderCoveredPlants,
      excessBefore: freeBefore,
      excessAfter: A.batch.shownExcess,
      reason: `Load from other batch · ${extra} cover released to excess · ${tag}`,
    });
    addSlotReserved(A.slot, -extra);
    setSlotAvailable(A.slot, extra, performedBy, `Load switched batch · ${extra} to excess · ${tag}`);
    addSlotExcess(A.slot, extra);
  }

  const touchedSlots = [B.slot, ...line.released.map((r) => batchIndex.get(r.batchId)?.slot).filter(Boolean)];
  return { reservedDec, availableDec, touchedSlots };
}

/** Move sowingCoverSources plants from abandoned batches onto the batch used at dispatch load. */
export function shiftSowingCoverSourcesForLoadLine(sources, line, pickEntry) {
  if (!Array.isArray(sources) || line.bucket === "COVER" || !(line.coverRehome || []).length) {
    return sources;
  }
  let rows = sources.map((s) => ({ ...s, plants: toQty(s.plants) }));
  for (const rh of line.coverRehome) {
    let trim = toQty(rh.plants);
    for (const s of rows) {
      if (trim <= 0) break;
      const bid = idStr(s.moved ? s.destBatchId : s.batchId);
      if (bid !== idStr(rh.fromBatchId)) continue;
      const take = Math.min(trim, s.plants);
      s.plants -= take;
      trim -= take;
    }
  }
  rows = rows.filter((s) => s.plants > 0);
  const add = line.coverRehome.reduce((sum, rh) => sum + toQty(rh.plants), 0);
  if (add > 0 && pickEntry?.batch) {
    const b = pickEntry.batch;
    const slotOid = pickEntry.slot?._id || line.slotId;
    const batchOid = idStr(b._id) || line.batchId;
    let dst = rows.find((s) => idStr(s.moved ? s.destBatchId : s.batchId) === batchOid);
    if (dst) dst.plants += add;
    else {
      rows.push({
        slotId: slotOid,
        batchId: batchOid,
        sowingRequestId: b.sowingRequestId,
        requestNumber: b.requestNumber || "",
        plants: add,
        sowingDate: b.sowingDate || "",
        plantReadyDate: b.plantReadyDate || "",
        shedName: b.shedName || "",
        reservedOnSource: true,
        moved: false,
      });
    }
  }
  return rows;
}

/**
 * Persist relinks / FREE victims, and re-home the **loading** order's cover onto the picked batch.
 */
export function sowLinkMovesForLine(line, { dispatchId, performedBy, now, readyDate, orderCode } = {}) {
  const code = typeof orderCode === "function" ? orderCode(line.orderId) : "";
  const ready = (batchId) => (typeof readyDate === "function" ? readyDate(batchId) || "" : "");
  const base = {
    at: now,
    by: performedBy || undefined,
    dispatchId,
    causedByOrderId: line.orderId,
    causedByOrderCode: code || "",
  };
  const moves = [];
  for (const r of line.relinks) {
    moves.push({
      orderId: r.orderId,
      entry: {
        ...base,
        fromSlotId: r.fromSlotId,
        fromBatchId: r.fromBatchId,
        slotId: r.toSlotId,
        batchId: r.toBatchId,
        plants: r.plants,
        plantReadyDate: ready(r.toBatchId),
        reason: "DISPATCH_RELINK",
      },
    });
  }
  for (const t of line.unlinkedTakes || []) {
    moves.push({
      orderId: t.orderId,
      entry: {
        ...base,
        fromSlotId: t.fromSlotId,
        fromBatchId: t.fromBatchId,
        plants: t.plants,
        plantReadyDate: ready(t.fromBatchId),
        reason: "DISPATCH_FREE",
      },
    });
  }
  for (const rh of line.coverRehome || []) {
    if (toQty(rh.plants) < 1) continue;
    moves.push({
      orderId: line.orderId,
      entry: {
        ...base,
        fromSlotId: rh.fromSlotId,
        fromBatchId: rh.fromBatchId,
        slotId: line.slotId,
        batchId: line.batchId,
        plants: rh.plants,
        plantReadyDate: ready(line.batchId),
        reason: "DISPATCH_SWITCH",
      },
    });
  }
  const oid = (v) => (v && mongoose.isValidObjectId(String(v)) ? new mongoose.Types.ObjectId(String(v)) : undefined);
  return moves.map((m) => ({
    orderId: m.orderId,
    entry: {
      ...m.entry,
      slotId: oid(m.entry.slotId),
      batchId: oid(m.entry.batchId),
      fromSlotId: oid(m.entry.fromSlotId),
      fromBatchId: oid(m.entry.fromBatchId),
      causedByOrderId: oid(m.entry.causedByOrderId),
    },
  }));
}

/** POST load with sowBatchSelections: per-order sowing batch picks (COVER / SWITCH / FREE). */
export async function executeSowBatchVehicleLoad({
  dispatchId,
  plantRowIndex = 0,
  sowBatchSelections,
  remarks,
  performedBy,
}) {
  const dispatchDoc = await findDispatchActiveByIdOrTransport(dispatchId);
  if (!dispatchDoc) throw new AppError("Vehicle dispatch not found", 404);
  if (!DISPATCH_SHED_ALLOWED_STATUSES.includes(dispatchDoc.transportStatus)) {
    throw new AppError("Vehicle must be PENDING, IN_TRANSIT, or LOADED", 400);
  }
  const { rowIdx, row, rowOrderIds } = await resolveSowRow(dispatchDoc, plantRowIndex);
  const selections = normalizeSowBatchSelections(sowBatchSelections);
  const t0 = Date.now();
  let ctxMs = 0;
  let poMs = 0;
  const loadedBefore = await sumPlantsLoadedOnDispatch(dispatchDoc._id);
  const alreadyLoadedBefore = loadedBefore.total || 0;

  const { cavity, numberPerCrate } = await resolveDefaultCavity();
  const session = await mongoose.startSession();
  session.startTransaction({ maxCommitTimeMS: 120_000 });
  try {
    const freshDispatch = await Dispatch.findById(dispatchDoc._id).session(session);
    if (!freshDispatch) throw new AppError("Vehicle dispatch not found", 404);
    validateSelections({
      selections,
      rowOrderIds,
      remaining: vehicleLineRemainingMap(freshDispatch, rowOrderIds),
      cap: rowRemaining(freshDispatch, row, rowOrderIds),
    });

    const tCtx = Date.now();
    const ctx = await loadPickedSowingEntries(selections.map((s) => s.batchId), session);
    ctxMs = Date.now() - tCtx;
    const plan = directSowingLoadPlan(selections, ctx.batches);
    if (!plan.ok) throw new AppError(plan.error, 400);

    const now = new Date();
    const { plantOutward, plantName, subtypeName } = await ensureSowReadyPlantOutward(
      row.plantId,
      row.subTypeId,
      session
    );
    let seq = (Number(loadedBefore.maxFulfillmentSeq) || 0) + 1;
    const labels = planLabels(ctx);
    const results = [];
    const plantsByOrder = new Map();
    const outwardPush = [];
    let totalLoaded = 0;

    for (const line of plan.lines) {
      const picked = ctx.batchIndex.get(line.batchId);
      if (!picked?.batch) throw new AppError("Sowing entry not found for this load", 404);
      const fullTrays = Math.floor(line.plants / cavity);
      const partialPlants = line.plants % cavity;
      const pollyhouse = picked.batch.shedName || "SowReady";
      const outwardId = new mongoose.Types.ObjectId();
      outwardPush.push({
        _id: outwardId,
        secondaryOutwardDate: now,
        numberOfBottles: 1,
        size: "R1",
        cavity,
        numberOfTrays: Math.max(1, fullTrays + (partialPlants > 0 ? 1 : 0)),
        numberOfFullTrays: fullTrays,
        partialTrayPlants: partialPlants,
        totalQuantity: line.plants,
        numberOfPlants: line.plants,
        availableQuantity: line.plants,
        pollyhouse,
        laboursEngaged: 1,
        transferStatus: "available",
        stockSource: "SOW_READY",
        sowReadyPlantReadyDate: picked.batch.plantReadyDate || "",
        sowingBatchId: new mongoose.Types.ObjectId(line.batchId),
        sowingDate: picked.batch.sowingDate || "",
        sowBucket: line.bucket,
        sowReservedDec: 0,
        sowAvailableDec: 0,
        linkedOrderId: new mongoose.Types.ObjectId(line.orderId),
        linkedDispatchId: freshDispatch._id,
        linkedDispatchPlantRowIndex: rowIdx,
        dispatchFulfillmentSequence: seq,
        dispatchFulfillmentSnapshot: {
          transportId: freshDispatch.transportId,
          driverName: freshDispatch.driverName,
          vehicleName: freshDispatch.vehicleName,
          vehicleNumber: freshDispatch.vehicleNumber,
          stockSource: "SOW_READY",
          remarks: remarks || undefined,
        },
      });
      results.push({
        secondaryOutwardId: String(outwardId),
        orderId: line.orderId,
        batchId: line.batchId,
        sowingDate: picked.batch.sowingDate || "",
        plantReadyDate: picked.batch.plantReadyDate || "",
        pollyhouse,
        plants: line.plants,
        bucket: line.bucket,
        summary: describeSowPlanLine(line, labels),
        stockSource: "SOW_READY",
        numberPerCrate,
      });
      plantsByOrder.set(line.orderId, (plantsByOrder.get(line.orderId) || 0) + line.plants);
      totalLoaded += line.plants;
      seq += 1;
    }

    const tPo = Date.now();
    if (outwardPush.length) {
      await PlantOutward.updateOne(
        { _id: plantOutward._id },
        { $push: { secondaryOutward: { $each: outwardPush } } },
        { session }
      );
    }
    poMs = Date.now() - tPo;
    await recordSowingEntryPlantDispatch({ session, lines: plan.lines });

    const orderLoadedList = [];
    const finalizeResults = [];
    for (const [oid, plantsLoaded] of plantsByOrder) {
      const loaded = await updateDispatchOrderShedLoaded({
        session,
        dispatchDoc: freshDispatch,
        orderId: oid,
        plantsLoaded,
        persist: false,
      });
      if (loaded) orderLoadedList.push(loaded);
      const fr = await finalizeOrderOnShedLineLoaded({
        session,
        orderId: oid,
        dispatchDoc: freshDispatch,
        orderLoaded: loaded,
        performedBy,
      });
      if (fr) finalizeResults.push(fr);
      await syncOrderVehicleLoadedFlag({ session, orderId: oid, dispatchDoc: freshDispatch });
    }
    const nextByRow = new Map(loadedBefore.byRow || []);
    nextByRow.set(rowIdx, (nextByRow.get(rowIdx) || 0) + totalLoaded);
    const transportStatus = await syncDispatchTransportStatusAfterShedChange({
      session,
      dispatchDoc: freshDispatch,
      plantRowIndex: rowIdx,
      loadedSums: {
        total: alreadyLoadedBefore + totalLoaded,
        byRow: nextByRow,
        byOrder: loadedBefore.byOrder || new Map(),
        maxFulfillmentSeq: seq - 1,
      },
      persist: false,
    });
    await freshDispatch.save({ session, validateBeforeSave: false });
    await session.commitTransaction();

    const changedBy = performedBy ? String(performedBy) : "Secondary shed";
    for (const fr of finalizeResults) schedulePostShedLoadAlerts({ finalizeResult: fr, changedBy });
    schedulePendingDispatchWhatsAppForVehicle(freshDispatch._id, { changedBy });
    scheduleVehicleLoadMoreNotify(freshDispatch._id, {
      plantsAdded: totalLoaded,
      alreadyLoadedBefore,
      loadedTotal: alreadyLoadedBefore + totalLoaded,
      changedBy,
    });

    console.log("[vehicleLoad] sow-batch ok", {
      dispatchId: String(freshDispatch._id),
      lines: results.length,
      plants: totalLoaded,
      ms: Date.now() - t0,
      ctxMs,
      poMs,
    });

    return {
      allocations: results,
      totalLoaded,
      orderLoaded: orderLoadedList[0] || null,
      orderLoadedList,
      transportStatus,
      linkedOrderId: plantsByOrder.size === 1 ? [...plantsByOrder.keys()][0] : null,
      stockSource: "SOW_READY",
      plantName,
      subtypeName,
    };
  } catch (err) {
    await session.abortTransaction();
    throw err;
  } finally {
    session.endSession();
  }
}

/**
 * Unload of a batch-picked sow line: give the plants back to the batch's order reserve
 * (or free stock, for the part that came from it). Links stay as they are.
 */
export async function restoreSowBatchDispatch({
  session,
  outward,
  plants,
  dispatchId,
  performedBy,
}) {
  const qty = toQty(plants);
  if (qty < 1) return { restored: 0 };
  const batchId = idStr(outward.sowingBatchId);
  const slotTaken = toQty(outward.sowAvailableDec) + toQty(outward.sowReservedDec);
  const slotId = idStr(outward.sowReadySlotId);
  if (slotTaken > 0 && slotId) {
    const plantSlot = await PlantSlot.findOne({ "subtypeSlots.slots._id": slotId }).session(session || null);
    let slot = null;
    for (const st of plantSlot?.subtypeSlots || []) {
      slot = st.slots.id(slotId);
      if (slot) break;
    }
    if (slot) {
      const fromAvail = Math.min(qty, toQty(outward.sowAvailableDec));
      const fromReserved = qty - fromAvail;
      addSlotReserved(slot, fromReserved);
      setSlotAvailable(slot, fromAvail, performedBy, `Sow batch unload (+${qty})`);
      const batch = batchId ? slot.sowingBatches.id(batchId) : null;
      if (batch) {
        if (!Array.isArray(batch.dispatchLog)) batch.dispatchLog = [];
        batch.dispatchLog.push({
          at: new Date(),
          by: performedBy || undefined,
          dispatchId,
          orderId: outward.linkedOrderId,
          secondaryOutwardId: outward._id,
          plants: -qty,
          bucket: "UNLOAD",
        });
      }
      if (performedBy && mongoose.isValidObjectId(String(performedBy))) slot.setPerformer?.(performedBy);
      await plantSlot.save({ session: session || undefined, validateBeforeSave: true });
    }
  }

  if (!batchId) return { restored: qty, batchId: "" };
  const entry = await SowingEntry.findOne({ sourceBatchId: batchId })
    .select(
      "dispatchedPlants dispatchedOrders plantsSowed bufferPlants sowingBufferPct mortalityMovedToExcess excessMovedToMortality noMortalityReserve isIrrelevant"
    )
    .session(session || null)
    .lean();
  if (!entry) return { restored: qty, batchId, skipped: "entry_not_found" };
  const nextOut = Math.max(0, Math.floor(Number(entry.dispatchedPlants) || 0) - qty);
  await SowingEntry.updateOne(
    { sourceBatchId: entry.sourceBatchId },
    {
      $set: {
        dispatchedPlants: nextOut,
        remainingPlants: Math.max(0, sellablePlantsOf(entry) - nextOut),
        dispatchedOrders: applyDispatchOrderPlants(entry.dispatchedOrders, [
          { orderId: outward.linkedOrderId, plants: -qty },
        ]),
      },
    },
    { session: session || undefined }
  );
  return { restored: qty, batchId };
}
