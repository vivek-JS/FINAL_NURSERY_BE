import mongoose from "mongoose";
import moment from "moment";
import AppError from "../utility/appError.js";
import PlantSlot from "../models/slots.model.js";
import Dispatch from "../models/dispatch.model.js";
import Order from "../models/order.model.js";
import { applyStockFieldUpdates } from "../utility/slotStockTrail.js";
import { sowBatchStock } from "../utility/lagwadSlotPlantsSplit.js";
import {
  findDispatchActiveByIdOrTransport,
  resolvePlantRowFromDispatch,
  syncDispatchTransportStatusAfterShedChange,
  updateDispatchOrderShedLoaded,
  computeSuggestedFulfillmentSequence,
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
  syncOrderVehicleLoadedFlag,
} from "./dispatchPostLoadFinalize.service.js";

const toQty = (v) => Math.max(0, Math.floor(Number(v) || 0));
const idStr = (v) => (v == null || v === "" ? "" : String(v?._id ?? v));

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

function pushOrderLink(links, link) {
  if (!link?.batchId || toQty(link.plants) < 1) return;
  const existing = links.find((l) => l.batchId === link.batchId);
  if (existing) {
    existing.plants += toQty(link.plants);
    if (!existing.slotId) existing.slotId = link.slotId || "";
    return;
  }
  links.push({ slotId: link.slotId || "", batchId: link.batchId, plants: toQty(link.plants) });
}

export function baseOrderLinks(order, batchIndex) {
  const covers = order?.sowingCoverReversedAt ? [] : order?.sowingCoverSources || [];
  const partials = Array.isArray(order?.sowingPartialCover) ? order.sowingPartialCover : [];
  const links = [];
  let held = 0;
  for (const p of partials) {
    const n = toQty(p.plants);
    if (n < 1) continue;
    const pick = batchForRequest(batchIndex, idStr(p.requestId), order._id);
    if (!pick) continue;
    pushOrderLink(links, { slotId: pick.slotId, batchId: idStr(pick.batch._id), plants: n });
    held += n;
  }
  if (covers.length) {
    for (const s of covers) {
      pushOrderLink(links, {
        slotId: idStr(s.moved ? s.destSlotId : s.slotId),
        batchId: idStr(s.moved ? s.destBatchId : s.batchId),
        plants: toQty(s.plants),
      });
    }
    return links;
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
      pushOrderLink(links, { slotId: pick.slotId, batchId: idStr(pick.batch._id), plants });
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
export function planSowBatchLoad({ selections, orderLinks, batches }) {
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

    const onB = own.find((l) => l.batchId === batchId);
    const cover = Math.min(q, onB ? onB.plants : 0);
    if (onB) onB.plants -= cover;
    const rest = q - cover;

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

    if (rest > 0) {
      const others = own.filter((l) => l.batchId !== batchId && l.plants > 0);
      const releasable = others.reduce((s, l) => s + l.plants, 0);
      const f = Math.min(rest, B.free);
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
    lines.push(line);
  }
  return { ok: true, lines };
}

/** Plain-text summary of one planned line for the shed app confirmation. */
export function describeSowPlanLine(line, labels = {}) {
  const day = (id) => labels.batchDay?.(id) || "";
  const code = (id) => labels.orderCode?.(id) || id;
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

function batchView(entry, extra = {}) {
  const b = entry.batch;
  const stock = sowBatchStock(b);
  return {
    slotId: entry.slotId,
    batchId: idStr(b._id),
    sowingDate: b.sowingDate || "",
    plantReadyDate: b.plantReadyDate || entry.slot.plantReadyDate || "",
    slotStartDay: entry.slot.startDay || "",
    shedName: b.shedName || "",
    requestNumber: b.requestNumber || "",
    sowedPlants: stock.sowed,
    freePlants: stock.free,
    ...extra,
  };
}

async function loadSlotDocs(plantId, subtypeId, session, hydrate) {
  const q = PlantSlot.find({
    plantId: new mongoose.Types.ObjectId(String(plantId)),
    "subtypeSlots.subtypeId": new mongoose.Types.ObjectId(String(subtypeId)),
  }).session(session || null);
  if (hydrate) return q;
  // Planner only needs batch counters. Trails and destroy history make this document several MB.
  return q
    .select(
      "-subtypeSlots.slots.slotTrail -subtypeSlots.slots.productStock -subtypeSlots.slots.sowingInProgress -subtypeSlots.slots.sowingBatches.destroyLog -subtypeSlots.slots.sowingBatches.slotHistory -subtypeSlots.slots.gapCovered -subtypeSlots.slots.linkedSowingRequests"
    )
    .lean();
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
  { session, vehicleOrderIds = [], hydrate = false, withFarmer = true } = {}
) {
  const slotDocs = await loadSlotDocs(plantId, subtypeId, session, hydrate);
  const batchIndex = indexSowBatches(slotDocs, subtypeId);
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
      { sowingDoneRequestId: { $in: reqIds } },
      { "sowingCoverSources.batchId": { $in: batchOids } },
      { "sowingCoverSources.destBatchId": { $in: batchOids } },
      { "sowBatchLinks.batchId": { $in: batchOids } },
    ],
  })
    .select(ORDER_SELECT)
    .session(session || null);
  if (withFarmer) orderQuery = orderQuery.populate("farmer", "name village");
  const orders = await orderQuery.lean();

  const dispatched = dispatchedByBatchOrder(batchIndex);
  const vehicleSet = new Set(vehicleOids.map(String));
  const orderLinks = new Map();
  const orderById = new Map();
  const batches = new Map(
    [...batchIndex].map(([batchId, e]) => [
      batchId,
      { slotId: e.slotId, free: sowBatchStock(e.batch).free, orders: [] },
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

  return { slotDocs, batchIndex, orders, orderById, orderLinks, batches };
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

async function rowRemaining(dispatchDoc, rowIdx, row, session) {
  const { byRow } = await sumPlantsLoadedOnDispatch(dispatchDoc._id, { session });
  const need = Number(row.quantity ?? row.totalPlants ?? 0) || 0;
  return Math.max(0, need - (byRow?.get(rowIdx) || 0));
}

/** GET sow-batch-options: per order on the plant row its linked batches, plus every batch with plants. */
export async function listSowBatchOptionsForDispatch(dispatchId, plantRowIndex = 0) {
  const dispatchDoc = await findDispatchActiveByIdOrTransport(dispatchId);
  if (!dispatchDoc) throw new AppError("Vehicle dispatch not found", 404);
  const { rowIdx, row, rowOrderIds } = await resolveSowRow(dispatchDoc, plantRowIndex);
  const ctx = await loadSowDispatchContext(row.plantId, row.subTypeId, {
    vehicleOrderIds: rowOrderIds,
  });
  const remaining = vehicleLineRemainingMap(dispatchDoc, rowOrderIds);

  const vehicleLinked = new Set();
  const orders = rowOrderIds.map((oid) => {
    const o = ctx.orderById.get(oid) || {};
    const linked = (ctx.orderLinks.get(oid) || []).map((l) => {
      vehicleLinked.add(l.batchId);
      return batchView(ctx.batchIndex.get(l.batchId), { linkedPlants: l.plants });
    });
    linked.sort((a, b) => dmyMs(a.plantReadyDate) - dmyMs(b.plantReadyDate));
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

  const batches = [];
  for (const [batchId, e] of ctx.batchIndex) {
    const pool = ctx.batches.get(batchId);
    const bookedForOthers = (pool?.orders || []).reduce((s, o) => s + o.plants, 0);
    const view = batchView(e, {
      bookedForOthers,
      otherOrders: (pool?.orders || []).length,
    });
    if (view.freePlants < 1 && bookedForOthers < 1 && !vehicleLinked.has(batchId)) continue;
    batches.push(view);
  }
  batches.sort(
    (a, b) =>
      dmyMs(a.plantReadyDate) - dmyMs(b.plantReadyDate) ||
      dmyMs(a.sowingDate) - dmyMs(b.sowingDate)
  );

  return {
    dispatchId: idStr(dispatchDoc._id),
    plantRowIndex: rowIdx,
    plantId: idStr(row.plantId),
    subtypeId: idStr(row.subTypeId),
    plantRowQuantity: Number(row.quantity ?? row.totalPlants ?? 0) || 0,
    rowRemaining: await rowRemaining(dispatchDoc, rowIdx, row),
    orders,
    batches,
  };
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
    cap: await rowRemaining(dispatchDoc, rowIdx, row),
  });
  const ctx = await loadSowDispatchContext(row.plantId, row.subTypeId, { vehicleOrderIds: rowOrderIds });
  const plan = planSowBatchLoad({ selections, orderLinks: ctx.orderLinks, batches: ctx.batches });
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

function addToSet(arr, id) {
  if (!id) return;
  if (!arr.some((x) => idStr(x) === String(id))) arr.push(new mongoose.Types.ObjectId(String(id)));
}

/**
 * Apply one planned line's batch/slot bookkeeping (excess move, released leftovers, link sets).
 * Returns the reserved/available decrements taken for the dispatch itself.
 */
export function applySowPlanLineToSlots({ line, batchIndex, performedBy, transportId, now }) {
  const B = batchIndex.get(line.batchId);
  if (!B) throw new AppError("Sowing batch not found", 404);
  const tag = `vehicle ${transportId || ""}`.trim();

  if (line.fromFree > 0) {
    const f = line.fromFree;
    B.batch.orderCoveredPlants = toQty(B.batch.orderCoveredPlants) + f;
    B.batch.excessPlants = Math.max(0, toQty(B.batch.excessPlants) - f);
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
    const left = toQty(rel.leftover);
    if (left < 1) continue;
    A.batch.orderCoveredPlants = Math.max(0, toQty(A.batch.orderCoveredPlants) - left);
    A.batch.excessPlants = toQty(A.batch.excessPlants) + left;
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

  if (line.bucket !== "COVER") {
    addToSet(B.batch.linkedOrderIds || (B.batch.linkedOrderIds = []), line.orderId);
  }

  const reserved = Math.max(0, Number(B.slot.orderReservedPlants) || 0);
  const reservedDec = Math.min(line.plants, reserved);
  const availableDec = Math.min(line.plants - reservedDec, Math.max(0, Number(B.slot.availablePlants) || 0));
  addSlotReserved(B.slot, -reservedDec);
  setSlotAvailable(B.slot, -availableDec, performedBy, `Sow batch load · ${tag}`);
  const touchedSlots = [B.slot, ...line.released.map((r) => batchIndex.get(r.batchId)?.slot).filter(Boolean)];
  return { reservedDec, availableDec, touchedSlots };
}

/** order.sowBatchLinks entries written for one planned line (dispatched order + relinked orders). */
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
  const gained = line.plants - line.cover;
  let releasedTotal = 0;
  for (const rel of line.released) {
    releasedTotal += rel.plants;
    moves.push({
      orderId: line.orderId,
      entry: {
        ...base,
        fromSlotId: rel.slotId,
        fromBatchId: rel.batchId,
        slotId: line.slotId,
        batchId: line.batchId,
        plants: rel.plants,
        plantReadyDate: ready(line.batchId),
        reason: "DISPATCH_SWITCH",
      },
    });
  }
  if (gained - releasedTotal > 0) {
    moves.push({
      orderId: line.orderId,
      entry: {
        ...base,
        slotId: line.slotId,
        batchId: line.batchId,
        plants: gained - releasedTotal,
        plantReadyDate: ready(line.batchId),
        reason: line.bucket === "FREE" ? "DISPATCH_FREE" : "DISPATCH_SWITCH",
      },
    });
  }
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

  const { cavity, numberPerCrate } = await resolveDefaultCavity();
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const freshDispatch = await Dispatch.findById(dispatchDoc._id).session(session);
    if (!freshDispatch) throw new AppError("Vehicle dispatch not found", 404);
    validateSelections({
      selections,
      rowOrderIds,
      remaining: vehicleLineRemainingMap(freshDispatch, rowOrderIds),
      cap: await rowRemaining(freshDispatch, rowIdx, row, session),
    });

    const ctx = await loadSowDispatchContext(row.plantId, row.subTypeId, {
      session,
      vehicleOrderIds: rowOrderIds,
      withFarmer: false,
    });
    const plan = planSowBatchLoad({ selections, orderLinks: ctx.orderLinks, batches: ctx.batches });
    if (!plan.ok) throw new AppError(plan.error, 400);

    // Slot docs hold every subtype (several MB); hydrate only the ones this plan writes.
    const planSlotIds = new Set(plan.lines.flatMap((l) => [l.slotId, ...l.released.map((r) => r.slotId)]));
    const writeDocIds = [
      ...new Set(
        [...ctx.batchIndex.values()].filter((e) => planSlotIds.has(e.slotId)).map((e) => idStr(e.doc._id))
      ),
    ];
    const writeDocs = await PlantSlot.find({ _id: { $in: writeDocIds } }).session(session);
    const writeIndex = indexSowBatches(writeDocs, row.subTypeId);

    const now = new Date();
    const { plantOutward, plantName, subtypeName } = await ensureSowReadyPlantOutward(
      row.plantId,
      row.subTypeId,
      session
    );
    let seq = await computeSuggestedFulfillmentSequence(freshDispatch._id);
    const labels = planLabels(ctx);
    const results = [];
    const plantsByOrder = new Map();
    const linkMoves = [];
    let totalLoaded = 0;
    const touched = new Set();

    for (const line of plan.lines) {
      const B = writeIndex.get(line.batchId);
      const { reservedDec, availableDec, touchedSlots } = applySowPlanLineToSlots({
        line,
        batchIndex: writeIndex,
        performedBy,
        transportId: freshDispatch.transportId,
        now,
      });
      touchedSlots.forEach((s) => touched.add(s));
      const fullTrays = Math.floor(line.plants / cavity);
      const partialPlants = line.plants % cavity;
      const pollyhouse = B.batch.shedName || "SowReady";
      plantOutward.secondaryOutward.push({
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
        sowReadySlotId: new mongoose.Types.ObjectId(line.slotId),
        sowReadyPlantReadyDate: B.batch.plantReadyDate || B.slot.plantReadyDate || "",
        sowingBatchId: new mongoose.Types.ObjectId(line.batchId),
        sowingDate: B.batch.sowingDate || "",
        sowBucket: line.bucket,
        sowReservedDec: reservedDec,
        sowAvailableDec: availableDec,
        switchPlan:
          line.bucket === "COVER"
            ? undefined
            : {
                cover: line.cover,
                fromExcess: line.fromFree,
                released: line.released,
                relinked: line.relinks.map((r) => ({ orderId: r.orderId, plants: r.plants, toBatchId: r.toBatchId })),
                unlinkedTakes: line.unlinkedTakes,
                summary: describeSowPlanLine(line, labels),
              },
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
          sowReadySlotId: line.slotId,
          remarks: remarks || undefined,
        },
      });
      const so = plantOutward.secondaryOutward[plantOutward.secondaryOutward.length - 1];
      if (!Array.isArray(B.batch.dispatchLog)) B.batch.dispatchLog = [];
      B.batch.dispatchLog.push({
        at: now,
        by: performedBy || undefined,
        dispatchId: freshDispatch._id,
        orderId: new mongoose.Types.ObjectId(line.orderId),
        secondaryOutwardId: so._id,
        plants: line.plants,
        bucket: line.bucket,
      });
      linkMoves.push(
        ...sowLinkMovesForLine(line, {
          dispatchId: freshDispatch._id,
          performedBy,
          now,
          orderCode: labels.orderCode,
          readyDate: (id) => {
            const e = ctx.batchIndex.get(String(id));
            return e?.batch?.plantReadyDate || e?.slot?.plantReadyDate || "";
          },
        })
      );
      results.push({
        secondaryOutwardId: String(so._id),
        orderId: line.orderId,
        slotId: line.slotId,
        batchId: line.batchId,
        sowingDate: B.batch.sowingDate || "",
        plantReadyDate: B.batch.plantReadyDate || "",
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

    await plantOutward.save({ session });
    if (performedBy && mongoose.isValidObjectId(String(performedBy))) {
      touched.forEach((s) => s.setPerformer?.(performedBy));
    }
    for (const doc of writeDocs) {
      if (doc.isModified()) await doc.save({ session, validateBeforeSave: true });
    }
    for (const m of linkMoves) {
      await Order.updateOne(
        { _id: m.orderId },
        { $push: { sowBatchLinks: m.entry } },
        { session }
      );
    }

    const orderLoadedList = [];
    const finalizeResults = [];
    for (const [oid, plantsLoaded] of plantsByOrder) {
      const loaded = await updateDispatchOrderShedLoaded({
        session,
        dispatchDoc: freshDispatch,
        orderId: oid,
        plantsLoaded,
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
    const transportStatus = await syncDispatchTransportStatusAfterShedChange({
      session,
      dispatchDoc: freshDispatch,
      plantRowIndex: rowIdx,
    });
    await session.commitTransaction();

    const changedBy = performedBy ? String(performedBy) : "Secondary shed";
    for (const fr of finalizeResults) schedulePostShedLoadAlerts({ finalizeResult: fr, changedBy });
    schedulePendingDispatchWhatsAppForVehicle(freshDispatch._id, { changedBy });

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
  const slotId = idStr(outward.sowReadySlotId);
  const batchId = idStr(outward.sowingBatchId);
  const plantSlot = await PlantSlot.findOne({ "subtypeSlots.slots._id": slotId }).session(session || null);
  if (!plantSlot) return { restored: 0, skipped: "slot_not_found" };
  let slot = null;
  for (const st of plantSlot.subtypeSlots || []) {
    slot = st.slots.id(slotId);
    if (slot) break;
  }
  if (!slot) return { restored: 0, skipped: "slot_not_found" };

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
  return { restored: qty, fromAvail, fromReserved, slotId };
}
