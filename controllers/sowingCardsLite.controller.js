import mongoose from "mongoose";
import PlantCms from "../models/plantCms.model.js";
import PlantSlot from "../models/slots.model.js";
import Product from "../models/product.model.js";
import Batch from "../models/batch.model.js";
import Order from "../models/order.model.js";
import SowingRequest from "../models/sowingRequest.model.js";
import RaisingSeedIntake from "../models/raisingSeedIntake.model.js";

const ACTIVE_ORDER_STATUSES = [
  "PENDING",
  "PROCESSING",
  "ACCEPTED",
  "FARM_READY",
  "READY_FOR_DISPATCH",
  "DISPATCH_PROCESS",
  "PARTIALLY_COMPLETED",
];

const MONTH_INDEX = {
  january: 0,
  jan: 0,
  february: 1,
  feb: 1,
  march: 2,
  mar: 2,
  april: 3,
  apr: 3,
  may: 4,
  june: 5,
  jun: 5,
  july: 6,
  jul: 6,
  august: 7,
  aug: 7,
  september: 8,
  sep: 8,
  sept: 8,
  october: 9,
  oct: 9,
  november: 10,
  nov: 10,
  december: 11,
  dec: 11,
};

/** In-memory cache — 2 minutes. Only bust on request create / refresh=1 */
let cardsLiteCache = { at: 0, payload: null };
const CARDS_TTL_MS = 120_000;

export function bustTodaySowingCardsLiteCache() {
  cardsLiteCache = { at: 0, payload: null };
}

function slotStartMs(day, month, year) {
  const d = parseInt(day, 10);
  const y = Number(year);
  const monthKey = String(month || "")
    .trim()
    .toLowerCase();
  const m = MONTH_INDEX[monthKey];
  if (!Number.isFinite(d) || !Number.isFinite(y) || m == null) return null;
  return Date.UTC(y, m, d);
}

/**
 * Ultra-fast Request Packets cards.
 * Skips order/raising aggregates on the hot path (drawer loads order-wise).
 * Filters booked slots before unwind; year-scoped; 2min cache.
 */
export const getTodaySowingCardsLite = async (req, res) => {
  const t0 = Date.now();
  try {
    // Bust via header only (query params are sanitized by global validator)
    const force =
      String(req.headers["x-sowing-cache-bust"] || "") === "1" ||
      String(req.headers["x-cache-bust"] || "") === "1";
    if (
      !force &&
      cardsLiteCache.payload &&
      Date.now() - cardsLiteCache.at < CARDS_TTL_MS
    ) {
      return res.json({
        ...cardsLiteCache.payload,
        cached: true,
        ms: Date.now() - t0,
      });
    }

    const now = new Date();
    const todayUtc = Date.UTC(
      now.getFullYear(),
      now.getMonth(),
      now.getDate()
    );
    const y = now.getFullYear();
    // Current + next year only (overdue in past years rarely needs new packet requests)
    const years = [y, y + 1];

    const plants = await PlantCms.find({ sowingAllowed: true })
      .select(
        "_id name sowingBuffer subtypes._id subtypes.name subtypes.plantReadyDays subtypes.buffer"
      )
      .lean();

    if (!plants.length) {
      const empty = {
        success: true,
        subtypeCards: [],
        requestCards: [],
        inProgressCards: [],
        summary: {
          totalSubtypes: 0,
          totalDueGap: 0,
          totalTodayGap: 0,
          requestCardCount: 0,
          inProgressCardCount: 0,
        },
        generatedAt: new Date(),
        ms: Date.now() - t0,
        cached: false,
      };
      cardsLiteCache = { at: Date.now(), payload: empty };
      return res.json(empty);
    }

    const plantIds = plants.map((p) => p._id);
    const plantMap = new Map(plants.map((p) => [String(p._id), p]));

    // Parallel: products, slots, pending requests, raising stock
    const [products, rawSlots, pendingRequests, raisingStockRows] = await Promise.all([
      Product.find({
        plantId: { $in: plantIds },
        category: { $regex: /^seeds$/i },
        isActive: true,
      })
        .select("_id plantId subtypeId name code conversionFactor")
        .lean(),
      PlantSlot.aggregate([
        {
          $match: {
            plantId: { $in: plantIds },
            year: { $in: years },
          },
        },
        // Drop empty subtype slots before unwind — biggest win
        {
          $project: {
            plantId: 1,
            year: 1,
            subtypeSlots: {
              $map: {
                input: "$subtypeSlots",
                as: "st",
                in: {
                  subtypeId: "$$st.subtypeId",
                  slots: {
                    $filter: {
                      input: "$$st.slots",
                      as: "s",
                      cond: {
                        $and: [
                          { $gt: [{ $ifNull: ["$$s.totalBookedPlants", 0] }, 0] },
                          {
                            $gt: [
                              {
                                $subtract: [
                                  { $ifNull: ["$$s.totalBookedPlants", 0] },
                                  {
                                    $add: [
                                      { $ifNull: ["$$s.primarySowed", 0] },
                                      { $ifNull: ["$$s.officeSowed", 0] },
                                    ],
                                  },
                                ],
                              },
                              0,
                            ],
                          },
                        ],
                      },
                    },
                  },
                },
              },
            },
          },
        },
        {
          $project: {
            plantId: 1,
            year: 1,
            subtypeSlots: {
              $filter: {
                input: "$subtypeSlots",
                as: "st",
                cond: { $gt: [{ $size: "$$st.slots" }, 0] },
              },
            },
          },
        },
        { $match: { "subtypeSlots.0": { $exists: true } } },
        { $unwind: "$subtypeSlots" },
        { $unwind: "$subtypeSlots.slots" },
        {
          $project: {
            _id: 0,
            plantId: 1,
            year: 1,
            subtypeId: "$subtypeSlots.subtypeId",
            slotId: "$subtypeSlots.slots._id",
            startDay: "$subtypeSlots.slots.startDay",
            endDay: "$subtypeSlots.slots.endDay",
            month: "$subtypeSlots.slots.month",
            totalBookedPlants: "$subtypeSlots.slots.totalBookedPlants",
            primarySowed: { $ifNull: ["$subtypeSlots.slots.primarySowed", 0] },
            officeSowed: { $ifNull: ["$subtypeSlots.slots.officeSowed", 0] },
            buffer: { $ifNull: ["$subtypeSlots.slots.buffer", 0] },
            plantReadyDays: "$subtypeSlots.slots.plantReadyDays",
          },
        },
        // Hard cap — Request Packets UI doesn't need tens of thousands of slot rows
        { $limit: 2500 },
      ]).option({ allowDiskUse: true }),
      SowingRequest.find({
        status: { $in: ["pending", "processing", "issued"] },
        plantId: { $in: plantIds },
        sowingCompleted: { $ne: true },
      })
        .select(
          "plantId subtypeId productId requestNumber packetsRequested packetsFromCompany packetsFromRaising seedSource conversionFactor status sowingInProgress issuedDate sowingCompleted linkedOrderIds isExcessiveSowing"
        )
        .lean(),
      RaisingSeedIntake.aggregate([
        {
          $match: {
            plantId: { $in: plantIds },
            packetsRemaining: { $gt: 0 },
            status: { $in: ["received", "allocated", "partially_used"] },
          },
        },
        {
          $group: {
            _id: {
              plantId: { $toString: "$plantId" },
              subtypeId: { $toString: "$subtypeId" },
            },
            packets: { $sum: "$packetsRemaining" },
            intakeCount: { $sum: 1 },
          },
        },
      ]),
    ]);

    const raisingByKey = new Map();
    (raisingStockRows || []).forEach((r) => {
      raisingByKey.set(`${r._id.plantId}-${r._id.subtypeId}`, {
        packets: Number(r.packets) || 0,
        intakeCount: r.intakeCount || 0,
      });
    });

    // Multiple seed products (packings) can share the same plant+subtype
    const productsByKey = new Map();
    const productIds = [];
    products.forEach((p) => {
      if (!p.subtypeId) return;
      const key = `${p.plantId}-${p.subtypeId}`;
      if (!productsByKey.has(key)) productsByKey.set(key, []);
      productsByKey.get(key).push(p);
      if (p._id) productIds.push(p._id);
    });

    // Available seed stock (packets) — one aggregate, keep lite API fast
    const stockByProduct = new Map();
    if (productIds.length) {
      const stockRows = await Batch.aggregate([
        {
          $match: {
            product: { $in: productIds },
            status: "active",
            remainingQuantity: { $gt: 0 },
          },
        },
        {
          $group: {
            _id: "$product",
            qty: { $sum: "$remainingQuantity" },
          },
        },
      ]);
      stockRows.forEach((r) => {
        stockByProduct.set(String(r._id), Number(r.qty) || 0);
      });
    }

    const requestMap = new Map(); // plant-subtype → active requests[]
    pendingRequests.forEach((r) => {
      const key = `${r.plantId}-${r.subtypeId}`;
      if (!requestMap.has(key)) requestMap.set(key, []);
      requestMap.get(key).push(r);
    });

    const toRequestMeta = (r) => {
      if (!r) return null;
      const status = r.status || "pending";
      const inProgress =
        status === "issued" ||
        status === "processing" ||
        Boolean(r.sowingInProgress);
      const linkedOrderIds = (r.linkedOrderIds || []).map((id) => String(id));
      return {
        _id: r._id,
        requestNumber: r.requestNumber,
        packetsRequested: r.packetsRequested,
        packetsFromCompany: r.packetsFromCompany,
        packetsFromRaising: r.packetsFromRaising,
        seedSource: r.seedSource,
        productId: r.productId || null,
        status,
        sowingInProgress: Boolean(r.sowingInProgress) || status === "issued",
        isExcessiveSowing: Boolean(r.isExcessiveSowing),
        linkedOrderIds,
        isIssuedToday: (() => {
          if (!r.issuedDate) return false;
          const d = new Date(r.issuedDate);
          const now = new Date();
          return (
            d.getFullYear() === now.getFullYear() &&
            d.getMonth() === now.getMonth() &&
            d.getDate() === now.getDate()
          );
        })(),
        // UI helper: pending | processing | sowing_in_progress
        displayStatus:
          status === "issued" || r.sowingInProgress
            ? "sowing_in_progress"
            : status === "processing"
              ? "processing"
              : "pending",
      };
    };

    // Candidate due/today slots (date filter only — booked comes from LIVE orders)
    const dueCandidates = [];
    for (const slot of rawSlots) {
      const plant = plantMap.get(String(slot.plantId));
      if (!plant) continue;
      const subtype = plant.subtypes?.find(
        (st) => String(st._id) === String(slot.subtypeId)
      );
      const readyDays =
        Number(slot.plantReadyDays) || Number(subtype?.plantReadyDays) || 0;
      const startMs = slotStartMs(slot.startDay, slot.month, slot.year);
      if (startMs == null) continue;
      const sowByMs = startMs - readyDays * 86400000;
      const daysUntilSow = Math.floor((sowByMs - todayUtc) / 86400000);
      if (daysUntilSow > 0) continue;
      dueCandidates.push({
        ...slot,
        readyDays,
        daysUntilSow,
        plant,
        subtype,
        bufferPct:
          Number(slot.buffer) ||
          Number(subtype?.buffer) ||
          Number(plant.sowingBuffer) ||
          0,
      });
    }

    const candidateSlotIds = dueCandidates
      .map((s) => s.slotId)
      .filter(Boolean);

    // Live booked per slot (excludes DISPATCHED/COMPLETED/CANCELLED ghosts on totalBookedPlants)
    const liveBookedBySlot = new Map();
    if (candidateSlotIds.length) {
      const liveRows = await Order.aggregate([
        {
          $match: {
            bookingSlot: { $in: candidateSlotIds },
            orderStatus: { $in: ACTIVE_ORDER_STATUSES },
            sowingDone: { $ne: true },
            $or: [
              { quotaSource: { $exists: false } },
              { quotaSource: null },
              { quotaSource: { $ne: "dealer" } },
            ],
          },
        },
        {
          $group: {
            _id: "$bookingSlot",
            bookedPlants: {
              $sum: {
                $add: [
                  { $ifNull: ["$numberOfPlants", 0] },
                  { $ifNull: ["$additionalPlants", 0] },
                ],
              },
            },
            orderCount: { $sum: 1 },
          },
        },
      ]);
      liveRows.forEach((r) => {
        liveBookedBySlot.set(String(r._id), {
          booked: Number(r.bookedPlants) || 0,
          orderCount: Number(r.orderCount) || 0,
        });
      });
    }

    const cardMap = new Map();

    for (const slot of dueCandidates) {
      const live = liveBookedBySlot.get(String(slot.slotId)) || {
        booked: 0,
        orderCount: 0,
      };
      const booked = live.booked;
      if (booked <= 0) continue; // drop stale stored-booked ghost slots

      const sowed =
        (Number(slot.primarySowed) || 0) + (Number(slot.officeSowed) || 0);
      const rawGap = Math.max(0, booked - sowed);
      const bufferPct = slot.bufferPct || 0;
      // Match full sowing.controller: buffer on remaining gap, not on total booked
      const plantsToSowWithBuffer =
        rawGap > 0 && bufferPct > 0
          ? Math.round(rawGap * (1 + bufferPct / 100))
          : rawGap;
      if (plantsToSowWithBuffer <= 0) continue;

      const key = `${slot.plantId}-${slot.subtypeId}`;
      if (!cardMap.has(key)) {
        cardMap.set(key, {
          plantId: String(slot.plantId),
          plantName: slot.plant.name,
          subtypeId: String(slot.subtypeId),
          subtypeName: slot.subtype?.name || "Subtype",
          sowingBuffer: bufferPct,
          plantReadyDays: slot.readyDays,
          primaryUnit: { symbol: "pkt", name: "packets" },
          secondaryUnit: null,
          slotIds: [],
          slots: [],
          totalGap: 0,
          totalPlantsToSowWithBuffer: 0,
          totalBookedPlants: 0,
          dueGap: 0,
          todayGap: 0,
        });
      }

      const card = cardMap.get(key);
      card.slotIds.push(slot.slotId);
      const dayRow = {
        slotId: slot.slotId,
        _id: slot.slotId,
        startDay: slot.startDay,
        endDay: slot.endDay,
        month: slot.month,
        year: slot.year,
        bookedPlants: booked,
        sowedPlants: sowed,
        rawGap,
        plantsToSowWithBuffer,
        orderCount: live.orderCount,
        daysUntilSow: slot.daysUntilSow,
        priority: slot.daysUntilSow < 0 ? "due" : "urgent",
      };
      // Keep all due/today days for GAP date breakdown (cap 120)
      if (card.slots.length < 120) {
        card.slots.push(dayRow);
      }
      card.totalGap += plantsToSowWithBuffer;
      card.totalPlantsToSowWithBuffer += plantsToSowWithBuffer;
      card.totalBookedPlants += booked;
      if (slot.daysUntilSow < 0) card.dueGap += plantsToSowWithBuffer;
      else card.todayGap += plantsToSowWithBuffer;
    }

    // Sort each card's days: most overdue first
    cardMap.forEach((c) => {
      c.slots.sort(
        (a, b) =>
          (a.daysUntilSow || 0) - (b.daysUntilSow || 0) ||
          String(a.startDay || "").localeCompare(String(b.startDay || ""))
      );
    });

    // Cheap order counts + seed-plan sums by plant/subtype (no populate)
    const allSlotIds = [];
    cardMap.forEach((c) => {
      c.slotIds.forEach((id) => allSlotIds.push(id));
    });

    let orderAgg = [];
    if (allSlotIds.length) {
      orderAgg = await Order.aggregate([
        {
          $match: {
            bookingSlot: { $in: allSlotIds },
            orderStatus: { $in: ACTIVE_ORDER_STATUSES },
            sowingDone: { $ne: true },
          },
        },
        {
          $group: {
            _id: {
              plantId: { $toString: "$plantName" },
              subtypeId: { $toString: "$plantSubtype" },
            },
            orderCount: { $sum: 1 },
            companyPackets: {
              $sum: { $ifNull: ["$sowingPlan.companySeedPackets", 0] },
            },
            raisingPackets: {
              $sum: { $ifNull: ["$sowingPlan.raisingSeedPackets", 0] },
            },
            mixedOrderCount: {
              $sum: {
                $cond: [
                  {
                    $in: [
                      { $ifNull: ["$sowingPlan.seedSource", "COMPANY"] },
                      ["MIXED", "RAISING"],
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
            raisingOrderCount: {
              $sum: {
                $cond: [
                  {
                    $eq: [
                      { $ifNull: ["$sowingPlan.seedSource", "COMPANY"] },
                      "RAISING",
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
            pureMixedOrderCount: {
              $sum: {
                $cond: [
                  {
                    $eq: [
                      { $ifNull: ["$sowingPlan.seedSource", "COMPANY"] },
                      "MIXED",
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
          },
        },
      ]);
    }

    const orderMap = new Map();
    orderAgg.forEach((row) => {
      orderMap.set(`${row._id.plantId}-${row._id.subtypeId}`, row);
    });

    const subtypeCards = Array.from(cardMap.values()).map((card) => {
      const key = `${card.plantId}-${card.subtypeId}`;
      const plants = card.totalPlantsToSowWithBuffer;
      const productList = productsByKey.get(key) || [];
      const pendingList = requestMap.get(key) || [];
      const pendingByProduct = new Map(
        pendingList
          .filter((r) => r.productId)
          .map((r) => [String(r.productId), r])
      );

      const packings = (productList.length
        ? productList
        : [
            {
              _id: null,
              name: "Default packing",
              code: "",
              conversionFactor: 1,
            },
          ]
      ).map((p) => {
        const cf = Number(p.conversionFactor) || 1;
        const packetsNeeded = Number((plants / cf).toFixed(2));
        const availablePackets = p._id
          ? Number((stockByProduct.get(String(p._id)) || 0).toFixed(2))
          : 0;
        const stockShortfall = Math.max(
          0,
          Number((packetsNeeded - availablePackets).toFixed(2))
        );
        const pending = p._id ? pendingByProduct.get(String(p._id)) : null;
        // Fallback: legacy request without productId blocks whole subtype
        const legacyPending =
          !pending && pendingList.find((r) => !r.productId);
        const blocked = pending || legacyPending;
        const reqMeta = toRequestMeta(blocked);
        return {
          productId: p._id || null,
          name: p.name || "Seed",
          code: p.code || "",
          conversionFactor: cf,
          label: `${p.name || p.code || "Seed"} · 1 pkt ≈ ${cf} plants`,
          packetsNeeded,
          availablePackets,
          stockShortfall,
          stockCovers: availablePackets >= packetsNeeded && packetsNeeded > 0,
          pendingRequest: reqMeta,
          activeRequest: reqMeta,
        };
      });

      // Prefer packing that covers gap; else most stock; else lowest pkt need
      const pickDefault = () => {
        const open = packings.filter((p) => !p.pendingRequest);
        const pool = open.length ? open : packings;
        const covering = pool.filter((p) => p.stockCovers);
        if (covering.length) {
          return covering.sort((a, b) => a.packetsNeeded - b.packetsNeeded)[0];
        }
        return pool
          .slice()
          .sort(
            (a, b) =>
              b.availablePackets - a.availablePackets ||
              a.packetsNeeded - b.packetsNeeded
          )[0];
      };
      const def = pickDefault() || packings[0];
      const o = orderMap.get(key) || {};
      const raisingInfo = raisingByKey.get(key) || { packets: 0, intakeCount: 0 };
      const raisingInHand = Number(raisingInfo.packets.toFixed(2));
      const raisingPlants = Number(
        (raisingInHand * (def?.conversionFactor || 1)).toFixed(0)
      );
      const anyPending =
        packings.every((p) => p.pendingRequest) ||
        pendingList.some((r) => !r.productId);

      const pickPrimaryReq = () => {
        const rank = (r) =>
          r.status === "issued" || r.sowingInProgress
            ? 0
            : r.status === "processing"
              ? 1
              : 2;
        const sorted = [...pendingList].sort((a, b) => rank(a) - rank(b));
        return toRequestMeta(sorted[0]);
      };
      const primaryReq =
        pickPrimaryReq() ||
        packings.find((p) => p.activeRequest)?.activeRequest ||
        null;
      const hasInProgress = pendingList.some(
        (r) =>
          r.status === "issued" ||
          r.status === "processing" ||
          Boolean(r.sowingInProgress)
      );
      const hasPendingOnly =
        !hasInProgress &&
        pendingList.some((r) => r.status === "pending");

      const availablePlants = Number(
        packings
          .reduce(
            (s, p) => s + (p.availablePackets || 0) * (p.conversionFactor || 1),
            0
          )
          .toFixed(0)
      );

      return {
        plantId: card.plantId,
        plantName: card.plantName,
        subtypeId: card.subtypeId,
        subtypeName: card.subtypeName,
        sowingBuffer: card.sowingBuffer,
        plantReadyDays: card.plantReadyDays,
        conversionFactor: def?.conversionFactor || 1,
        primaryUnit: card.primaryUnit,
        secondaryUnit: card.secondaryUnit,
        productId: def?.productId || null,
        packings,
        packingCount: packings.length,
        slotIds: card.slotIds,
        slots: card.slots,
        totalGap: card.totalGap,
        totalPlantsToSowWithBuffer: plants,
        totalBookedPlants: card.totalBookedPlants,
        dueGap: Number(card.dueGap) || 0,
        todayGap: Number(card.todayGap) || 0,
        packetsNeeded: def?.packetsNeeded || 0,
        availablePackets: def?.availablePackets || 0,
        stockShortfall: def?.stockShortfall || 0,
        raisingInHandPackets: raisingInHand,
        raisingIntakeCount: raisingInfo.intakeCount || 0,
        raisingOrderCount:
          (Number(o.raisingOrderCount) || 0) +
          (Number(o.pureMixedOrderCount) || 0),
        // Company plant-equiv + raising plant-equiv
        availablePlants: availablePlants + raisingPlants,
        companyAvailablePlants: availablePlants,
        raisingAvailablePlants: raisingPlants,
        orderCount: o.orderCount || 0,
        orderSeedSummary: {
          companyPackets: Number(o.companyPackets) || 0,
          raisingPackets: Number(o.raisingPackets) || 0,
          mixedOrderCount: o.mixedOrderCount || 0,
          raisingOrderCount: Number(o.raisingOrderCount) || 0,
          pureMixedOrderCount: Number(o.pureMixedOrderCount) || 0,
          raisingInHandPackets: raisingInHand,
          raisingIntakeCount: raisingInfo.intakeCount || 0,
        },
        requestStatus: primaryReq?.displayStatus || null,
        sowingInProgress: hasInProgress,
        requestPending: hasPendingOnly,
        pendingRequest: anyPending ? primaryReq : null,
        activeRequest: primaryReq,
        pendingRequests: pendingList.map((r) => toRequestMeta(r)),
        activeRequests: pendingList.map((r) => toRequestMeta(r)),
      };
    });

    subtypeCards.sort((a, b) => b.totalGap - a.totalGap);

    const requestCards = [];
    const inProgressCards = [];
    const progressKeys = new Set();

    for (const c of subtypeCards) {
      const key = `${c.plantId}-${c.subtypeId}`;
      const hasOpenPacking = (c.packings || []).some(
        (p) => !p.pendingRequest && !p.activeRequest
      );

      if (c.sowingInProgress) {
        inProgressCards.push({
          ...c,
          cardKind: "in_progress",
          isExcessiveSowing: Boolean(c.activeRequest?.isExcessiveSowing),
          totalPacketsInProgress: Number(c.activeRequest?.packetsRequested) || 0,
        });
        progressKeys.add(key);
      }

      // Request list: only when something is still left to request / await issue
      // Do NOT keep pure in-progress cards here
      if (hasOpenPacking) {
        requestCards.push({ ...c, cardKind: "request" });
      } else if (c.requestPending && !c.sowingInProgress) {
        requestCards.push({ ...c, cardKind: "pending" });
      }
    }

    // Issued / in-progress requests whose gap is already 0 (not in subtypeCards)
    for (const r of pendingRequests) {
      const isProg =
        r.status === "issued" ||
        r.status === "processing" ||
        Boolean(r.sowingInProgress);
      if (!isProg) continue;
      const key = `${r.plantId}-${r.subtypeId}`;
      if (progressKeys.has(key)) continue;
      const plant = plantMap.get(String(r.plantId));
      if (!plant) continue;
      const subtype = plant.subtypes?.find(
        (st) => String(st._id) === String(r.subtypeId)
      );
      const meta = toRequestMeta(r);
      inProgressCards.push({
        plantId: String(r.plantId),
        plantName: plant.name,
        subtypeId: String(r.subtypeId),
        subtypeName: subtype?.name || "Subtype",
        sowingBuffer: Number(plant.sowingBuffer) || 0,
        plantReadyDays: Number(subtype?.plantReadyDays) || 0,
        conversionFactor: Number(r.conversionFactor) || 1,
        primaryUnit: { symbol: "pkt", name: "packets" },
        secondaryUnit: null,
        productId: r.productId || null,
        packings: [],
        packingCount: 0,
        slotIds: r.linkedSlotIds || [],
        slots: [],
        totalGap: 0,
        totalPlantsToSowWithBuffer: 0,
        totalBookedPlants: 0,
        packetsNeeded: 0,
        availablePackets: 0,
        stockShortfall: 0,
        raisingInHandPackets: 0,
        raisingIntakeCount: 0,
        raisingOrderCount: 0,
        availablePlants: 0,
        orderCount: 0,
        orderSeedSummary: {},
        requestStatus: meta?.displayStatus || "sowing_in_progress",
        sowingInProgress: true,
        requestPending: false,
        pendingRequest: meta,
        activeRequest: meta,
        pendingRequests: [meta],
        activeRequests: [meta],
        cardKind: "in_progress",
        isExcessiveSowing: Boolean(r.isExcessiveSowing),
        totalPacketsInProgress: Number(r.packetsRequested) || 0,
        totalPlantsInProgress: Math.round(
          (Number(r.packetsRequested) || 0) * (Number(r.conversionFactor) || 1)
        ),
      });
      progressKeys.add(key);
    }

    const payload = {
      success: true,
      subtypeCards: requestCards,
      requestCards,
      inProgressCards,
      summary: {
        totalSubtypes: requestCards.length,
        totalDueGap: requestCards.reduce((s, c) => s + (c.dueGap || 0), 0),
        totalTodayGap: requestCards.reduce((s, c) => s + (c.todayGap || 0), 0),
        totalPlantsNeeded: requestCards.reduce(
          (s, c) => s + (c.totalPlantsToSowWithBuffer || 0),
          0
        ),
        totalAvailablePlants: requestCards.reduce(
          (s, c) => s + (c.availablePlants || 0),
          0
        ),
        totalPackings: requestCards.reduce(
          (s, c) => s + (c.packingCount || 0),
          0
        ),
        requestCardCount: requestCards.length,
        inProgressCardCount: inProgressCards.length,
      },
      generatedAt: new Date(),
      ms: Date.now() - t0,
      cached: false,
    };

    cardsLiteCache = { at: Date.now(), payload };
    return res.json(payload);
  } catch (error) {
    console.error("getTodaySowingCardsLite:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to load lite sowing cards",
      error: error.message,
      ms: Date.now() - t0,
    });
  }
};

/**
 * Order-wise rows for drawer — lean, capped.
 */
export const getOrderWiseSowing = async (req, res) => {
  const t0 = Date.now();
  try {
    const { plantId, subtypeId, slotIds } = req.query;
    if (!plantId || !subtypeId) {
      return res.status(400).json({
        success: false,
        message: "plantId and subtypeId are required",
      });
    }

    let slotIdList = [];
    if (slotIds) {
      slotIdList = String(slotIds)
        .split(",")
        .map((s) => s.trim())
        .filter((s) => mongoose.Types.ObjectId.isValid(s))
        .map((s) => new mongoose.Types.ObjectId(s));
    }

    const query = {
      plantName: plantId,
      plantSubtype: subtypeId,
      orderStatus: { $in: ACTIVE_ORDER_STATUSES },
      sowingDone: { $ne: true },
    };
    if (slotIdList.length) {
      query.bookingSlot = { $in: slotIdList };
    }

    const [orders, products, raisings, activeOrderReqs] = await Promise.all([
      Order.find(query)
        .select(
          "orderId name farmer bookingSlot numberOfPlants additionalPlants sowingPlan createdAt orderStatus sowingDone"
        )
        .populate("farmer", "name mobileNumber")
        .sort({ createdAt: 1 })
        .limit(80)
        .lean(),
      Product.find({
        plantId,
        subtypeId,
        category: { $regex: /^seeds$/i },
        isActive: true,
      })
        .select("_id name code conversionFactor")
        .lean(),
      RaisingSeedIntake.find({
        plantId,
        subtypeId,
        packetsRemaining: { $gt: 0 },
        status: { $in: ["received", "allocated", "partially_used"] },
      })
        .select("orderId packetsRemaining batchNumber photos intakeNumber")
        .limit(80)
        .lean(),
      SowingRequest.find({
        plantId,
        subtypeId,
        status: { $in: ["pending", "processing", "issued"] },
        linkedOrderIds: { $exists: true, $ne: [] },
      })
        .select("requestNumber status linkedOrderIds")
        .lean(),
    ]);

    const orderRequestMap = new Map();
    (activeOrderReqs || []).forEach((r) => {
      (r.linkedOrderIds || []).forEach((oid) => {
        const k = String(oid);
        if (!orderRequestMap.has(k)) {
          orderRequestMap.set(k, {
            requestNumber: r.requestNumber,
            status: r.status,
          });
        }
      });
    });

    const raisingMap = new Map();
    raisings.forEach((r) => {
      if (!r.orderId) return;
      const k = String(r.orderId);
      if (!raisingMap.has(k)) raisingMap.set(k, []);
      raisingMap.get(k).push(r);
    });

    const cf = products[0]?.conversionFactor || 1;
    const packings = products.map((p) => ({
      productId: p._id,
      name: p.name,
      code: p.code,
      conversionFactor: Number(p.conversionFactor) || 1,
      label: `${p.name || p.code || "Seed"} · 1 pkt ≈ ${Number(p.conversionFactor) || 1} plants`,
    }));

    const rows = orders.map((o) => {
      const plants =
        (Number(o.numberOfPlants) || 0) + (Number(o.additionalPlants) || 0);
      const sp = o.sowingPlan || {};
      const seedSource = sp.seedSource || "COMPANY";
      const intakes = raisingMap.get(String(o._id)) || [];
      const raisingInHand = intakes.reduce(
        (s, i) => s + (Number(i.packetsRemaining) || 0),
        0
      );
      const prior = orderRequestMap.get(String(o._id)) || null;
      const alreadyRequested = Boolean(prior);

      let priority = 2;
      if (alreadyRequested) {
        priority = 9;
      } else if (seedSource === "RAISING" || seedSource === "MIXED") {
        priority = raisingInHand > 0 ? 0 : 1;
      }

      return {
        orderId: o._id,
        orderNumber: o.orderId,
        farmerName: o.farmer?.name || o.name || "",
        farmerMobile: o.farmer?.mobileNumber || "",
        numberOfPlants: plants,
        bookingSlot: o.bookingSlot,
        sowingPlan: {
          seedSource,
          companySeedPackets: Number(sp.companySeedPackets) || 0,
          raisingSeedPackets: Number(sp.raisingSeedPackets) || 0,
          sowingNotes: sp.sowingNotes || "",
        },
        suggestedPackets: Math.ceil(plants / cf) || 0,
        raisingInHandPackets: raisingInHand,
        raisingIntakes: intakes.map((i) => ({
          _id: i._id,
          intakeNumber: i.intakeNumber,
          batchNumber: i.batchNumber,
          packetsRemaining: i.packetsRemaining,
          photoCount: i.photos?.length || 0,
        })),
        alreadyRequested,
        existingRequestNumber: prior?.requestNumber || null,
        existingRequestStatus: prior?.status || null,
        createdAt: o.createdAt,
        orderStatus: o.orderStatus,
        _sort: priority,
      };
    });

    rows.sort((a, b) => a._sort - b._sort || b.numberOfPlants - a.numberOfPlants);
    rows.forEach((r) => delete r._sort);

    const openOrders = rows.filter((r) => !r.alreadyRequested);

    return res.json({
      success: true,
      data: rows,
      openOrderCount: openOrders.length,
      alreadyRequestedCount: rows.length - openOrders.length,
      conversionFactor: cf,
      packings,
      ms: Date.now() - t0,
    });
  } catch (error) {
    console.error("getOrderWiseSowing:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to load order-wise sowing",
      error: error.message,
      ms: Date.now() - t0,
    });
  }
};
