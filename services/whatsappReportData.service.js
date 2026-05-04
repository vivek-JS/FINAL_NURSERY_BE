import moment from "moment";
import mongoose from "mongoose";
import Order from "../models/order.model.js";
import PlantSlot from "../models/slots.model.js";
import PlantCms from "../models/plantCms.model.js";
import { calculateMultipleSlotsBookedPlants } from "../utility/slotBookedPlantsCalculator.js";

/** @param {number} n */
function rupee(n) {
  const x = Math.round((Number(n) + Number.EPSILON) * 100) / 100;
  return `₹${x.toLocaleString("en-IN")}`;
}

/**
 * Same scope as booking report (IST range): orders counted by booking date / createdAt.
 * @param {{ start: Date, end: Date }} range
 */
export function matchOrdersInBookingRangeIST(range) {
  return {
    orderStatus: { $nin: ["CANCELLED", "REJECTED"] },
    $or: [
      { orderBookingDate: { $gte: range.start, $lte: range.end } },
      {
        $and: [
          {
            $or: [
              { orderBookingDate: null },
              { orderBookingDate: { $exists: false } },
            ],
          },
          { createdAt: { $gte: range.start, $lte: range.end } },
        ],
      },
    ],
  };
}

/**
 * Billable = rate × (numberOfPlants + additionalPlants). Collected = sum of payment lines with paymentStatus COLLECTED.
 * @param {object} match - Mongo match on orders
 */
export async function fetchPaymentStatsForMatch(match) {
  const [result] = await Order.aggregate([
    { $match: match },
    {
      $addFields: {
        _qty: {
          $add: [
            { $ifNull: ["$numberOfPlants", 0] },
            { $ifNull: ["$additionalPlants", 0] },
          ],
        },
      },
    },
    {
      $addFields: {
        _due: { $multiply: [{ $ifNull: ["$rate", 0] }, "$_qty"] },
        _collected: {
          $reduce: {
            input: {
              $filter: {
                input: { $ifNull: ["$payment", []] },
                as: "p",
                cond: { $eq: ["$$p.paymentStatus", "COLLECTED"] },
              },
            },
            initialValue: 0,
            in: { $add: ["$$value", { $ifNull: ["$$this.paidAmount", 0] }] },
          },
        },
      },
    },
    {
      $addFields: {
        _outstanding: {
          $max: [{ $subtract: ["$_due", "$_collected"] }, 0],
        },
        _hasBankVerified: {
          $gt: [
            {
              $size: {
                $filter: {
                  input: { $ifNull: ["$payment", []] },
                  as: "p",
                  cond: { $eq: ["$$p.paymentStatus", "BANK_VERIFIED"] },
                },
              },
            },
            0,
          ],
        },
      },
    },
    {
      $facet: {
        summary: [
          {
            $group: {
              _id: null,
              orders: { $sum: 1 },
              totalDue: { $sum: "$_due" },
              totalCollected: { $sum: "$_collected" },
              totalOutstanding: { $sum: "$_outstanding" },
              pendingPaymentOrders: {
                $sum: {
                  $cond: [{ $eq: ["$orderPaymentStatus", "PENDING"] }, 1, 0],
                },
              },
              completedPaymentOrders: {
                $sum: {
                  $cond: [{ $eq: ["$orderPaymentStatus", "COMPLETED"] }, 1, 0],
                },
              },
              partialPaidOrders: {
                $sum: {
                  $cond: [
                    {
                      $and: [
                        { $gt: ["$_collected", 0] },
                        { $lt: ["$_collected", "$_due"] },
                      ],
                    },
                    1,
                    0,
                  ],
                },
              },
              bankVerifiedPendingOrders: {
                $sum: {
                  $cond: [
                    {
                      $and: [
                        { $eq: ["$orderPaymentStatus", "PENDING"] },
                        "$_hasBankVerified",
                      ],
                    },
                    1,
                    0,
                  ],
                },
              },
            },
          },
        ],
        byPlant: [
          {
            $lookup: {
              from: "plantcms",
              localField: "plantName",
              foreignField: "_id",
              as: "pl",
            },
          },
          {
            $addFields: {
              plantLabel: {
                $ifNull: [{ $arrayElemAt: ["$pl.name", 0] }, "Unknown"],
              },
            },
          },
          {
            $group: {
              _id: "$plantLabel",
              outstanding: { $sum: "$_outstanding" },
              collected: { $sum: "$_collected" },
              due: { $sum: "$_due" },
              orders: { $sum: 1 },
            },
          },
          { $sort: { outstanding: -1 } },
          { $limit: 8 },
        ],
      },
    },
  ]);

  const s = result?.summary?.[0] || {};
  return {
    summary: {
      orders: s.orders || 0,
      totalDue: s.totalDue || 0,
      totalCollected: s.totalCollected || 0,
      totalOutstanding: s.totalOutstanding || 0,
      pendingPaymentOrders: s.pendingPaymentOrders || 0,
      completedPaymentOrders: s.completedPaymentOrders || 0,
      partialPaidOrders: s.partialPaidOrders || 0,
      bankVerifiedPendingOrders: s.bankVerifiedPendingOrders || 0,
    },
    byPlant: result?.byPlant || [],
  };
}

/**
 * @param {Awaited<ReturnType<typeof fetchPaymentStatsForMatch>>} agg
 * @param {string} heading
 */
export function formatPaymentStatsWhatsApp(agg, heading) {
  const s = agg.summary;
  const lines = [
    `💰 *${heading}*`,
    `Orders in scope: *${s.orders}*`,
    `• Billable (rate × plants): ${rupee(s.totalDue)}`,
    `• Collected (payment rows marked COLLECTED): ${rupee(s.totalCollected)}`,
    `• Outstanding (max due − collected, per order): ${rupee(s.totalOutstanding)}`,
    "",
    "*Order payment flag:*",
    `• PENDING: *${s.pendingPaymentOrders}* | COMPLETED: *${s.completedPaymentOrders}*`,
    `• Partially paid (some collection, not full): *${s.partialPaidOrders}*`,
    `• Still PENDING but has BANK_VERIFIED line (awaiting clearance): *${s.bankVerifiedPendingOrders}*`,
    "",
  ];
  if (agg.byPlant?.length) {
    lines.push("*By plant — outstanding / collected / orders:*");
    for (const row of agg.byPlant.slice(0, 6)) {
      lines.push(
        `  • *${row._id}*: out ${rupee(row.outstanding)} | coll ${rupee(
          row.collected
        )} | ${row.orders} ord`
      );
    }
  }
  return lines.join("\n").trimEnd();
}

/** All active orders (excl. cancelled/rejected) — org-wide money snapshot. */
export async function fetchActiveOrdersPaymentSnapshot() {
  return fetchPaymentStatsForMatch({
    orderStatus: { $nin: ["CANCELLED", "REJECTED"] },
  });
}

export function chunkWhatsAppText(text, maxLen = 3500) {
  const lines = String(text || "").split("\n");
  const chunks = [];
  let buf = "";
  for (const line of lines) {
    const next = buf ? `${buf}\n${line}` : line;
    if (next.length > maxLen && buf) {
      chunks.push(buf);
      buf = line;
    } else {
      buf = next;
    }
  }
  if (buf) {
    chunks.push(buf);
  }
  return chunks.length ? chunks : [""];
}

/**
 * Delivery pipeline: orders accepted + farm-ready (not yet dispatched), plant-wise qty + counts.
 * Live snapshot — not filtered by the wizard date range (booking-only).
 */
export async function fetchDeliveryPipelineByPlant() {
  const rows = await Order.aggregate([
    { $match: { orderStatus: { $in: ["ACCEPTED", "FARM_READY"] } } },
    {
      $lookup: {
        from: "plantcms",
        localField: "plantName",
        foreignField: "_id",
        as: "p",
      },
    },
    {
      $addFields: {
        plantLabel: { $ifNull: [{ $arrayElemAt: ["$p.name", 0] }, "Unknown"] },
        qty: {
          $cond: [
            { $gt: [{ $ifNull: ["$totalPlants", 0] }, 0] },
            "$totalPlants",
            {
              $add: [
                { $ifNull: ["$numberOfPlants", 0] },
                { $ifNull: ["$additionalPlants", 0] },
              ],
            },
          ],
        },
      },
    },
    {
      $group: {
        _id: {
          plant: "$plantLabel",
          status: "$orderStatus",
        },
        orders: { $sum: 1 },
        plantsQty: { $sum: "$qty" },
      },
    },
    { $sort: { "_id.plant": 1 } },
  ]);

  /** @type {Record<string, { accepted: { orders: number, plantsQty: number }, farmReady: { orders: number, plantsQty: number } }>} */
  const byPlant = {};
  let totalAcceptedOrders = 0;
  let totalFarmReadyOrders = 0;
  let acceptedQty = 0;
  let farmReadyQty = 0;

  for (const r of rows) {
    const plant = r._id.plant || "Unknown";
    const st = r._id.status;
    if (!byPlant[plant]) {
      byPlant[plant] = {
        accepted: { orders: 0, plantsQty: 0 },
        farmReady: { orders: 0, plantsQty: 0 },
      };
    }
    if (st === "ACCEPTED") {
      byPlant[plant].accepted.orders += r.orders;
      byPlant[plant].accepted.plantsQty += r.plantsQty;
      totalAcceptedOrders += r.orders;
      acceptedQty += r.plantsQty;
    } else if (st === "FARM_READY") {
      byPlant[plant].farmReady.orders += r.orders;
      byPlant[plant].farmReady.plantsQty += r.plantsQty;
      totalFarmReadyOrders += r.orders;
      farmReadyQty += r.plantsQty;
    }
  }

  return {
    byPlant,
    totals: {
      acceptedOrders: totalAcceptedOrders,
      farmReadyOrders: totalFarmReadyOrders,
      acceptedPlants: acceptedQty,
      farmReadyPlants: farmReadyQty,
    },
  };
}

export function formatDeliveryWhatsApp(data) {
  const { byPlant, totals } = data;
  const lines = [
    "🚚 *Delivery queue (pending dispatch)*",
    "Statuses: *ACCEPTED* (booked, not ready) + *FARM_READY* (ready at farm).",
    "",
    `Total lines: *${totals.acceptedOrders + totals.farmReadyOrders}* orders | plants: *${totals.acceptedPlants + totals.farmReadyPlants}*`,
    `  • ACCEPTED: ${totals.acceptedOrders} orders, ${totals.acceptedPlants} plants`,
    `  • FARM_READY: ${totals.farmReadyOrders} orders, ${totals.farmReadyPlants} plants`,
    "",
    "*Plant-wise* (orders / plants):",
  ];

  const plants = Object.keys(byPlant).sort((a, b) => a.localeCompare(b));
  for (const p of plants) {
    const b = byPlant[p];
    lines.push(
      `• *${p}*`,
      `  ACCEPTED: ${b.accepted.orders} ord / ${b.accepted.plantsQty} plants | FARM_READY: ${b.farmReady.orders} ord / ${b.farmReady.plantsQty} plants`
    );
  }
  if (!plants.length) {
    lines.push("— No orders in ACCEPTED or FARM_READY right now.");
  }
  return lines.join("\n");
}

/**
 * Future slots only (end date ≥ start of today IST). Per plant: top 3 & bottom 3 by booked plants.
 */
export async function fetchFutureSlotHighlights() {
  const todayStart = moment().utcOffset(330).startOf("day");
  const y = todayStart.year();
  const years = [y, y + 1];

  const docs = await PlantSlot.find({ year: { $in: years } })
    .select({ plantId: 1, year: 1, subtypeSlots: 1 })
    .lean();

  const plantIds = [...new Set(docs.map((d) => String(d.plantId)))].filter(
    Boolean
  );
  const plantMap = new Map();
  if (plantIds.length) {
    const plants = await PlantCms.find({ _id: { $in: plantIds } })
      .select({ name: 1, subtypes: 1 })
      .lean();
    for (const p of plants) {
      plantMap.set(String(p._id), p);
    }
  }

  /** @type {{ slotId: string, plantName: string, subtypeName: string, label: string, endM: moment.Moment, cap: number, booked: number }[]} */
  const slotRows = [];

  for (const doc of docs) {
    const pdoc = plantMap.get(String(doc.plantId));
    const plantName = pdoc?.name || "Unknown plant";
    for (const st of doc.subtypeSlots || []) {
      const sub = pdoc?.subtypes?.find(
        (s) => String(s._id) === String(st.subtypeId)
      );
      const subtypeName = sub?.name || "—";
      for (const sl of st.slots || []) {
        if (sl.status === false) {
          continue;
        }
        const endM = moment(sl.endDay, "DD-MM-YYYY", true);
        if (!endM.isValid() || endM.isBefore(todayStart, "day")) {
          continue;
        }
        const label = `${sl.startDay}–${sl.endDay} ${sl.month} ${doc.year}`;
        slotRows.push({
          slotId: String(sl._id),
          plantName,
          subtypeName,
          label,
          endM,
          cap: Number(sl.totalPlants) || 0,
        });
      }
    }
  }

  const ids = slotRows.map((r) => r.slotId);
  const bookedMap =
    ids.length > 0
      ? await calculateMultipleSlotsBookedPlants(
          ids.map((id) => new mongoose.Types.ObjectId(id))
        )
      : {};

  for (const r of slotRows) {
    r.booked = Number(bookedMap[r.slotId] || 0);
  }

  /** @type {Record<string, typeof slotRows>} */
  const byPlant = {};
  for (const r of slotRows) {
    if (!byPlant[r.plantName]) {
      byPlant[r.plantName] = [];
    }
    byPlant[r.plantName].push(r);
  }

  const sections = [];
  const plantNames = Object.keys(byPlant).sort((a, b) => a.localeCompare(b));
  const maxPlants = Math.min(plantNames.length, 6);

  sections.push(
    "📅 *Future slots* (end date ≥ today IST)",
    `Showing top/bottom booked per plant (max ${maxPlants} plants).`,
    ""
  );

  let shown = 0;
  for (const pn of plantNames) {
    if (shown >= maxPlants) {
      break;
    }
    const list = byPlant[pn];
    const sortedDesc = [...list].sort((a, b) => b.booked - a.booked);
    const sortedAsc = [...list].sort((a, b) => a.booked - b.booked);
    const top3 = sortedDesc.slice(0, 3);
    const bottom3 = sortedAsc.slice(0, 3);

    sections.push(`*${pn}*`);
    sections.push("  🔼 Most booked:");
    for (const s of top3) {
      sections.push(
        `    • ${s.label} — booked ${s.booked} / cap ${s.cap} (${s.subtypeName})`
      );
    }
    sections.push("  🔽 Least booked:");
    for (const s of bottom3) {
      sections.push(
        `    • ${s.label} — booked ${s.booked} / cap ${s.cap} (${s.subtypeName})`
      );
    }
    sections.push("");
    shown += 1;
  }

  if (!slotRows.length) {
    sections.push("— No upcoming slot windows found in PlantSlot for this year.");
  }

  return { text: sections.join("\n").trimEnd(), slotCount: slotRows.length };
}

/**
 * Five lightweight operational alerts (counts / thresholds).
 */
export async function fetchSystemAlertsSnapshot() {
  const now = new Date();
  const day7 = new Date(now - 7 * 24 * 60 * 60 * 1000);
  const day5 = new Date(now - 5 * 24 * 60 * 60 * 1000);

  const [
    stuckAccepted,
    stuckFarmReady,
    paymentPending,
    oldPendingNew,
    overflowSlots,
  ] = await Promise.all([
    Order.countDocuments({
      orderStatus: "ACCEPTED",
      createdAt: { $lt: day7 },
    }),
    Order.countDocuments({
      orderStatus: "FARM_READY",
      updatedAt: { $lt: day5 },
    }),
    Order.countDocuments({
      orderPaymentStatus: "PENDING",
      orderStatus: { $nin: ["CANCELLED", "REJECTED", "COMPLETED", "DISPATCHED"] },
    }),
    Order.countDocuments({
      orderStatus: "PENDING",
      createdAt: { $lt: day7 },
    }),
    (async () => {
      const todayStart = moment().utcOffset(330).startOf("day");
      const y = todayStart.year();
      const docs = await PlantSlot.find({ year: { $in: [y, y + 1] } })
        .select({ subtypeSlots: 1 })
        .lean();
      const ids = [];
      for (const doc of docs) {
        for (const st of doc.subtypeSlots || []) {
          for (const sl of st.slots || []) {
            if (sl.status === false) {
              continue;
            }
            const endM = moment(sl.endDay, "DD-MM-YYYY", true);
            if (!endM.isValid() || endM.isBefore(todayStart, "day")) {
              continue;
            }
            ids.push(String(sl._id));
          }
        }
      }
      if (!ids.length) {
        return 0;
      }
      const bookedMap = await calculateMultipleSlotsBookedPlants(
        ids.map((id) => new mongoose.Types.ObjectId(id))
      );
      let n = 0;
      for (const doc of docs) {
        for (const st of doc.subtypeSlots || []) {
          for (const sl of st.slots || []) {
            if (sl.status === false) {
              continue;
            }
            const endM = moment(sl.endDay, "DD-MM-YYYY", true);
            if (!endM.isValid() || endM.isBefore(todayStart, "day")) {
              continue;
            }
            const sid = String(sl._id);
            const booked = Number(bookedMap[sid] || 0);
            const cap = Number(sl.totalPlants) || 0;
            if (booked > cap) {
              n += 1;
            }
          }
        }
      }
      return n;
    })(),
  ]);

  const lines = [
    "🚨 *Alerts (snapshot)*",
    `1. ACCEPTED orders older than *7 days*: *${stuckAccepted}* (follow up / convert or release).`,
    `2. FARM_READY rows not updated *5+ days* (stale farm-ready): *${stuckFarmReady}* (dispatch / status check).`,
    `3. Orders with *payment pending* (active statuses): *${paymentPending}*.`,
    `4. Still *PENDING* (not accepted) older than *7 days*: *${oldPendingNew}*.`,
    `5. *Future slots over-capacity* (booked > slot capacity): *${overflowSlots}* slot window(s).`,
  ];

  return { text: lines.join("\n"), counts: { stuckAccepted, stuckFarmReady, paymentPending, oldPendingNew, overflowSlots } };
}

export function splitForWhatsApp(body) {
  return chunkWhatsAppText(body);
}

