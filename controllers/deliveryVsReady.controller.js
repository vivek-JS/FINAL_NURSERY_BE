import mongoose from "mongoose";
import moment from "moment";
import Order from "../models/order.model.js";
import PlantSlot from "../models/slots.model.js";
import PlantCms from "../models/plantCms.model.js";
import Product from "../models/product.model.js";
import Batch from "../models/batch.model.js";

function dayKeyFromDdMmYyyy(str) {
  if (!str || typeof str !== "string") return null;
  const m = moment(str, ["DD-MM-YYYY", "YYYY-MM-DD"], true);
  return m.isValid() ? m.format("YYYY-MM-DD") : null;
}

function parseSlotDay(str) {
  if (!str) return null;
  const m = moment(str, ["DD-MM-YYYY", "YYYY-MM-DD"], true);
  return m.isValid() ? m.clone().startOf("day") : null;
}

function oidOrNull(v) {
  return v && mongoose.Types.ObjectId.isValid(v)
    ? new mongoose.Types.ObjectId(v)
    : null;
}

function emptyDayMaps() {
  return {
    delivery: new Map(),
    ready: new Map(),
    stock: new Map(),
    sowingNeeded: new Map(),
  };
}

function bump(map, key, n) {
  if (!key || !(n > 0)) return;
  map.set(key, (map.get(key) || 0) + n);
}

function buildDayRows(horizon, todayStart, maps) {
  const rows = [];
  for (let i = 0; i < horizon; i++) {
    const d = todayStart.clone().add(i, "days");
    const key = d.format("YYYY-MM-DD");
    const delivery = maps.delivery.get(key) || 0;
    const readyAvailable = maps.ready.get(key) || 0;
    const stockAvailable = maps.stock.get(key) || 0;
    const sowingNeeded = maps.sowingNeeded.get(key) || 0;
    rows.push({
      date: key,
      label: d.format("ddd DD MMM"),
      delivery,
      readyAvailable,
      stockAvailable,
      sowingNeeded,
      shortage: Math.max(0, delivery - readyAvailable),
      isToday: i === 0,
    });
  }
  return rows;
}

/**
 * GET /sowing/analytics/delivery-vs-ready
 * - Dual-line nursery totals
 * - Subtype-wise tables with horizon = plantReadyDays (min 7, max 45)
 * - Next 7 days sowing plants + available seed packets
 */
export const getDeliveryVsReadyAnalytics = async (req, res) => {
  try {
    const from = req.query.from
      ? moment(req.query.from).startOf("day")
      : moment().subtract(7, "days").startOf("day");
    const to = req.query.to
      ? moment(req.query.to).endOf("day")
      : moment().add(14, "days").endOf("day");

    if (!from.isValid() || !to.isValid() || to.isBefore(from)) {
      return res.status(400).json({
        success: false,
        message: "Invalid from/to date range",
      });
    }

    const plantIdFilter = oidOrNull(req.query.plantId);
    const subtypeIdFilter = oidOrNull(req.query.subtypeId);
    const todayKey = moment().format("YYYY-MM-DD");
    const todayStart = moment().startOf("day");
    const maxHorizonEnd = moment().add(44, "days").endOf("day");

    const orderMatch = {
      deliveryDate: {
        $gte: todayStart.toDate(),
        $lte: maxHorizonEnd.toDate(),
      },
      orderStatus: { $nin: ["CANCELLED", "REJECTED"] },
      $or: [
        { quotaSource: { $ne: "dealer" } },
        { quotaSource: { $exists: false } },
      ],
    };
    if (plantIdFilter) orderMatch.plantName = plantIdFilter;

    const slotMatch = {};
    if (plantIdFilter) slotMatch.plantId = plantIdFilter;

    const [deliveryBySlotDay, slotRows, plants, products] = await Promise.all([
      Order.aggregate([
        { $match: orderMatch },
        {
          $group: {
            _id: {
              day: {
                $dateToString: { format: "%Y-%m-%d", date: "$deliveryDate" },
              },
              slot: "$bookingSlot",
            },
            plants: {
              $sum: {
                $add: [
                  { $ifNull: ["$numberOfPlants", 0] },
                  { $ifNull: ["$additionalPlants", 0] },
                ],
              },
            },
            orders: { $sum: 1 },
          },
        },
      ]),
      PlantSlot.aggregate([
        ...(Object.keys(slotMatch).length ? [{ $match: slotMatch }] : []),
        { $unwind: "$subtypeSlots" },
        ...(subtypeIdFilter
          ? [{ $match: { "subtypeSlots.subtypeId": subtypeIdFilter } }]
          : []),
        { $unwind: "$subtypeSlots.slots" },
        {
          $project: {
            plantId: 1,
            subtypeId: "$subtypeSlots.subtypeId",
            slotId: "$subtypeSlots.slots._id",
            startDay: "$subtypeSlots.slots.startDay",
            endDay: "$subtypeSlots.slots.endDay",
            plantReadyDays: {
              $ifNull: ["$subtypeSlots.slots.plantReadyDays", 0],
            },
            availablePlants: {
              $ifNull: ["$subtypeSlots.slots.availablePlants", 0],
            },
            primarySowed: { $ifNull: ["$subtypeSlots.slots.primarySowed", 0] },
            officeSowed: { $ifNull: ["$subtypeSlots.slots.officeSowed", 0] },
            totalBookedPlants: {
              $ifNull: ["$subtypeSlots.slots.totalBookedPlants", 0],
            },
            buffer: { $ifNull: ["$subtypeSlots.slots.buffer", 0] },
            sowingBatches: {
              $ifNull: ["$subtypeSlots.slots.sowingBatches", []],
            },
          },
        },
      ]),
      PlantCms.find(plantIdFilter ? { _id: plantIdFilter } : {})
        .select("name subtypes._id subtypes.name subtypes.plantReadyDays")
        .lean(),
      Product.find({
        ...(plantIdFilter ? { plantId: plantIdFilter } : {}),
        category: { $regex: /^seeds$/i },
        isActive: true,
      })
        .select("_id plantId subtypeId name conversionFactor")
        .lean(),
    ]);

    const plantMap = new Map(plants.map((p) => [String(p._id), p]));
    const subtypeMeta = new Map(); // key -> { plantId, plantName, subtypeId, subtypeName, plantReadyDays }
    for (const p of plants) {
      for (const st of p.subtypes || []) {
        const key = `${p._id}-${st._id}`;
        subtypeMeta.set(key, {
          plantId: String(p._id),
          plantName: p.name || "Plant",
          subtypeId: String(st._id),
          subtypeName: st.name || "Subtype",
          plantReadyDays: Number(st.plantReadyDays) || 0,
        });
      }
    }

    const slotToKey = new Map();
    const bySubtypeMaps = new Map(); // key -> maps
    const globalMaps = emptyDayMaps();
    let duePlants = 0;
    let dueSlots = 0;
    let urgentPlants = 0;
    let urgentSlots = 0;

    const ensureSubtype = (key, plantId, subtypeId, slotReadyDays) => {
      if (bySubtypeMaps.has(key)) return bySubtypeMaps.get(key);
      let meta = subtypeMeta.get(key);
      if (!meta) {
        const plant = plantMap.get(String(plantId));
        meta = {
          plantId: String(plantId),
          plantName: plant?.name || "Plant",
          subtypeId: String(subtypeId),
          subtypeName: "Subtype",
          plantReadyDays: 0,
        };
      }
      const readyDays = Math.max(
        Number(slotReadyDays) || 0,
        Number(meta.plantReadyDays) || 0,
        7
      );
      const horizon = Math.min(Math.max(readyDays, 7), 45);
      const entry = {
        ...meta,
        plantReadyDays: readyDays,
        horizonDays: horizon,
        maps: emptyDayMaps(),
        cf: 1,
        availablePackets: 0,
      };
      bySubtypeMaps.set(key, entry);
      return entry;
    };

    for (const slot of slotRows) {
      const key = `${slot.plantId}-${slot.subtypeId}`;
      const entry = ensureSubtype(
        key,
        slot.plantId,
        slot.subtypeId,
        slot.plantReadyDays
      );
      slotToKey.set(String(slot.slotId), key);

      const start = parseSlotDay(slot.startDay);
      const end = parseSlotDay(slot.endDay) || start;
      if (!start) continue;

      const readyDays =
        Number(slot.plantReadyDays) || Number(entry.plantReadyDays) || 0;
      const booked = Number(slot.totalBookedPlants) || 0;
      const sowed =
        (Number(slot.primarySowed) || 0) + (Number(slot.officeSowed) || 0);
      const bufferPct = Number(slot.buffer) || 0;
      const gap = Math.max(
        0,
        Math.ceil(booked * (1 + bufferPct / 100)) - sowed
      );
      const avail = Math.max(0, Number(slot.availablePlants) || 0);
      const sowBy = start.clone().subtract(readyDays, "days");
      const daysUntilSow = sowBy.diff(todayStart, "days");
      const horizonEnd = todayStart
        .clone()
        .add(entry.horizonDays - 1, "days")
        .endOf("day");

      if (gap > 0) {
        if (daysUntilSow < 0) {
          duePlants += gap;
          dueSlots += 1;
          bump(entry.maps.sowingNeeded, todayKey, gap);
          bump(globalMaps.sowingNeeded, todayKey, gap);
        } else if (daysUntilSow === 0) {
          urgentPlants += gap;
          urgentSlots += 1;
          bump(entry.maps.sowingNeeded, todayKey, gap);
          bump(globalMaps.sowingNeeded, todayKey, gap);
        } else if (daysUntilSow < entry.horizonDays) {
          const k = sowBy.format("YYYY-MM-DD");
          bump(entry.maps.sowingNeeded, k, gap);
          bump(globalMaps.sowingNeeded, k, gap);
        }
      }

      // Slot plant stock across covered days in horizon
      let d = moment.max(todayStart, start).clone();
      const coverEnd = moment.min(horizonEnd, end || start);
      while (d.isSameOrBefore(coverEnd, "day")) {
        const k = d.format("YYYY-MM-DD");
        bump(entry.maps.stock, k, avail);
        bump(globalMaps.stock, k, avail);
        d.add(1, "day");
      }

      for (const b of slot.sowingBatches || []) {
        const plants = Number(b.plantsSowed) || 0;
        if (plants <= 0) continue;
        const readyKey = dayKeyFromDdMmYyyy(b.plantReadyDate);
        const sowKey = dayKeyFromDdMmYyyy(b.sowingDate);
        if (readyKey) {
          bump(entry.maps.ready, readyKey, plants);
          bump(globalMaps.ready, readyKey, plants);
        }
        if (sowKey) {
          // tracked on global for chart only via ready/delivery; sowed optional
        }
      }
    }

    // Delivery by subtype via booking slot
    const chartDelivery = new Map();
    const chartReady = globalMaps.ready;
    let chartOrdersToday = 0;

    for (const row of deliveryBySlotDay) {
      const day = row._id?.day;
      const slotId = row._id?.slot ? String(row._id.slot) : "";
      const plants = Number(row.plants) || 0;
      if (!day || !(plants > 0)) continue;
      bump(chartDelivery, day, plants);
      if (day === todayKey) chartOrdersToday += Number(row.orders) || 0;

      const key = slotToKey.get(slotId);
      if (key && bySubtypeMaps.has(key)) {
        bump(bySubtypeMaps.get(key).maps.delivery, day, plants);
      }
    }

    // Seed packet stock by subtype (Product + Batch)
    const productIds = [];
    const productsByKey = new Map();
    for (const p of products) {
      if (!p.subtypeId) continue;
      const key = `${p.plantId}-${p.subtypeId}`;
      if (subtypeIdFilter && String(p.subtypeId) !== String(subtypeIdFilter)) {
        continue;
      }
      if (!productsByKey.has(key)) productsByKey.set(key, []);
      productsByKey.get(key).push(p);
      productIds.push(p._id);
    }

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

    for (const [key, entry] of bySubtypeMaps) {
      const plist = productsByKey.get(key) || [];
      let pkt = 0;
      let cf = 1;
      for (const p of plist) {
        pkt += stockByProduct.get(String(p._id)) || 0;
        if (Number(p.conversionFactor) > 0) cf = Number(p.conversionFactor);
      }
      entry.availablePackets = Number(pkt.toFixed(2));
      entry.cf = cf || 1;
    }

    // Subtype tables
    const bySubtype = [...bySubtypeMaps.values()]
      .map((entry) => {
        const days = buildDayRows(entry.horizonDays, todayStart, entry.maps);
        const summary = days.reduce(
          (a, r) => {
            a.delivery += r.delivery;
            a.readyAvailable += r.readyAvailable;
            a.stockAvailable += r.stockAvailable;
            a.sowingNeeded += r.sowingNeeded;
            a.shortage += r.shortage;
            return a;
          },
          {
            delivery: 0,
            readyAvailable: 0,
            stockAvailable: 0,
            sowingNeeded: 0,
            shortage: 0,
          }
        );
        return {
          plantId: entry.plantId,
          plantName: entry.plantName,
          subtypeId: entry.subtypeId,
          subtypeName: entry.subtypeName,
          plantReadyDays: entry.plantReadyDays,
          horizonDays: entry.horizonDays,
          conversionFactor: entry.cf,
          availablePackets: entry.availablePackets,
          days,
          summary,
        };
      })
      .filter(
        (s) =>
          s.summary.delivery > 0 ||
          s.summary.sowingNeeded > 0 ||
          s.summary.readyAvailable > 0 ||
          s.summary.stockAvailable > 0
      )
      .sort(
        (a, b) =>
          b.summary.sowingNeeded - a.summary.sowingNeeded ||
          b.summary.shortage - a.summary.shortage
      );

    // Nursery chart days (past 7 → +14 or query)
    const days = [];
    let cumDelivery = 0;
    let cumReady = 0;
    const cursor = from.clone().startOf("day");
    const endDay = to.clone().startOf("day");
    while (cursor.isSameOrBefore(endDay, "day")) {
      const key = cursor.format("YYYY-MM-DD");
      const delivery = chartDelivery.get(key) || 0;
      const readyAvailable = chartReady.get(key) || 0;
      cumDelivery += delivery;
      cumReady += readyAvailable;
      days.push({
        date: key,
        label: cursor.format("DD MMM"),
        delivery,
        readyAvailable,
        sowed: 0,
        shortage: Math.max(0, delivery - readyAvailable),
        surplus: Math.max(0, readyAvailable - delivery),
        cumDelivery,
        cumReady,
        isToday: key === todayKey,
        isFuture: cursor.isAfter(todayStart, "day"),
      });
      cursor.add(1, "day");
    }

    const todayRow = days.find((d) => d.date === todayKey) || {
      delivery: 0,
      readyAvailable: 0,
      sowed: 0,
      shortage: 0,
      surplus: 0,
    };

    // Next 7 days nursery plant table (kept)
    const next7Days = buildDayRows(7, todayStart, {
      delivery: chartDelivery,
      ready: chartReady,
      stock: globalMaps.stock,
      sowingNeeded: globalMaps.sowingNeeded,
    });

    const next7Summary = next7Days.reduce(
      (acc, r) => {
        acc.delivery += r.delivery;
        acc.readyAvailable += r.readyAvailable;
        acc.stockAvailable += r.stockAvailable;
        acc.sowingNeeded += r.sowingNeeded;
        acc.shortage += r.shortage;
        return acc;
      },
      {
        delivery: 0,
        readyAvailable: 0,
        stockAvailable: 0,
        sowingNeeded: 0,
        shortage: 0,
      }
    );

    // Next 7 days sowing + seed packets (projected consumption)
    const totalSeedPackets = [...bySubtypeMaps.values()].reduce(
      (s, e) => s + (e.availablePackets || 0),
      0
    );
    let remainingPackets = totalSeedPackets;
    const next7Packets = [];
    for (let i = 0; i < 7; i++) {
      const d = todayStart.clone().add(i, "days");
      const key = d.format("YYYY-MM-DD");
      let sowingNeededPlants = 0;
      let packetsNeeded = 0;
      for (const entry of bySubtypeMaps.values()) {
        const plants = entry.maps.sowingNeeded.get(key) || 0;
        if (plants <= 0) continue;
        sowingNeededPlants += plants;
        const cf = entry.cf > 0 ? entry.cf : 1;
        packetsNeeded += plants / cf;
      }
      packetsNeeded = Number(packetsNeeded.toFixed(2));
      const availableAtStart = Number(remainingPackets.toFixed(2));
      const packetShortage = Math.max(
        0,
        Number((packetsNeeded - availableAtStart).toFixed(2))
      );
      remainingPackets = Math.max(0, availableAtStart - packetsNeeded);
      next7Packets.push({
        date: key,
        label: d.format("ddd DD MMM"),
        sowingNeededPlants,
        packetsNeeded,
        availablePackets: availableAtStart,
        packetShortage,
        packetsAfter: Number(remainingPackets.toFixed(2)),
        isToday: i === 0,
      });
    }

    const next7PacketsSummary = next7Packets.reduce(
      (a, r) => {
        a.sowingNeededPlants += r.sowingNeededPlants;
        a.packetsNeeded += r.packetsNeeded;
        a.packetShortage += r.packetShortage;
        return a;
      },
      { sowingNeededPlants: 0, packetsNeeded: 0, packetShortage: 0 }
    );
    next7PacketsSummary.packetsNeeded = Number(
      next7PacketsSummary.packetsNeeded.toFixed(2)
    );
    next7PacketsSummary.packetShortage = Number(
      next7PacketsSummary.packetShortage.toFixed(2)
    );
    next7PacketsSummary.availablePacketsNow = Number(totalSeedPackets.toFixed(2));

    return res.json({
      success: true,
      from: from.format("YYYY-MM-DD"),
      to: to.format("YYYY-MM-DD"),
      today: {
        date: todayKey,
        deliveryToday: todayRow.delivery || 0,
        readyToday: todayRow.readyAvailable || 0,
        sowedToday: todayRow.sowed || 0,
        shortageToday: todayRow.shortage || 0,
        surplusToday: todayRow.surplus || 0,
        deliveryOrdersToday: chartOrdersToday,
      },
      urgent: {
        duePlants,
        dueSlots,
        urgentPlants,
        urgentSlots,
        totalUrgentPlants: duePlants + urgentPlants,
        shortageToday: todayRow.shortage || 0,
      },
      next7Days,
      next7Summary,
      next7Packets,
      next7PacketsSummary,
      bySubtype,
      days,
      generatedAt: new Date(),
    });
  } catch (error) {
    console.error("getDeliveryVsReadyAnalytics:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to load delivery vs ready analytics",
      error: error.message,
    });
  }
};
