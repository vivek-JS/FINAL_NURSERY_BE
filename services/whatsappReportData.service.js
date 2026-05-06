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
 * Delivery pipeline with optional Mongo match (AND with ACCEPTED + FARM_READY).
 * @param {Record<string, unknown>} [extraMatch] - e.g. deliveryDate window or null checks
 */
export async function fetchDeliveryPipelineByPlantWithMatch(extraMatch = {}) {
  const base = { orderStatus: { $in: ["ACCEPTED", "FARM_READY"] } };
  const match =
    extraMatch && Object.keys(extraMatch).length
      ? { $and: [base, extraMatch] }
      : base;

  const rows = await Order.aggregate([
    { $match: match },
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

/**
 * Full pending queue (no date filter) — same as legacy behaviour.
 */
export async function fetchDeliveryPipelineByPlant() {
  return fetchDeliveryPipelineByPlantWithMatch({});
}

/**
 * @param {{ start: Date, end: Date }} range - IST window for “due” rows
 * @param {'due_in_window'|'no_due'|'both'} mode
 */
export async function fetchDeliveryPipelineForWizard(range, mode) {
  if (mode === "due_in_window") {
    const data = await fetchDeliveryPipelineByPlantWithMatch({
      deliveryDate: { $gte: range.start, $lte: range.end },
    });
    return {
      segments: [
        {
          title: "With delivery date in window",
          ...data,
        },
      ],
    };
  }
  if (mode === "no_due") {
    const data = await fetchDeliveryPipelineByPlantWithMatch({
      $or: [{ deliveryDate: null }, { deliveryDate: { $exists: false } }],
    });
    return {
      segments: [
        {
          title: "Without delivery date (not scheduled yet)",
          ...data,
        },
      ],
    };
  }
  if (mode === "both") {
    const [dueData, noDueData] = await Promise.all([
      fetchDeliveryPipelineByPlantWithMatch({
        deliveryDate: { $gte: range.start, $lte: range.end },
      }),
      fetchDeliveryPipelineByPlantWithMatch({
        $or: [{ deliveryDate: null }, { deliveryDate: { $exists: false } }],
      }),
    ]);
    return {
      segments: [
        { title: "With delivery date in window", ...dueData },
        { title: "Without delivery date (not scheduled yet)", ...noDueData },
      ],
    };
  }
  const data = await fetchDeliveryPipelineByPlant();
  return { segments: [{ title: "All pending queue", ...data }] };
}

/**
 * Payment aggregate scope matching delivery wizard filters.
 */
export function buildDeliveryPaymentMatchForWizard(range, mode) {
  const base = { orderStatus: { $in: ["ACCEPTED", "FARM_READY"] } };
  if (mode === "due_in_window") {
    return {
      ...base,
      deliveryDate: { $gte: range.start, $lte: range.end },
    };
  }
  if (mode === "no_due") {
    return {
      ...base,
      $or: [{ deliveryDate: null }, { deliveryDate: { $exists: false } }],
    };
  }
  if (mode === "both") {
    return {
      ...base,
      $or: [
        { deliveryDate: { $gte: range.start, $lte: range.end } },
        { deliveryDate: null },
        { deliveryDate: { $exists: false } },
      ],
    };
  }
  return base;
}

export function formatDeliveryWhatsApp(data, opts = {}) {
  const { byPlant, totals } = data;
  const { skipBanner = false } = opts;
  const lines = [];
  if (!skipBanner) {
    lines.push(
      "🚚 *Delivery queue (pending dispatch)*",
      "Statuses: *ACCEPTED* (booked, not ready) + *FARM_READY* (ready at farm).",
      ""
    );
  } else {
    lines.push(
      "_Statuses: ACCEPTED + FARM_READY (not dispatched)._",
      ""
    );
  }
  lines.push(
    `Total lines: *${totals.acceptedOrders + totals.farmReadyOrders}* orders | plants: *${totals.acceptedPlants + totals.farmReadyPlants}*`,
    `  • ACCEPTED: ${totals.acceptedOrders} orders, ${totals.acceptedPlants} plants`,
    `  • FARM_READY: ${totals.farmReadyOrders} orders, ${totals.farmReadyPlants} plants`,
    "",
    "*Plant-wise* (orders / plants):"
  );

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

const DISPATCH_LIKE_STATUSES = [
  "DISPATCHED",
  "COMPLETED",
  "PARTIALLY_COMPLETED",
  "DISPATCH_PROCESS",
];

/**
 * Dispatched / completed activity in IST range: transition recorded on `statusChanges`
 * in the window, or legacy rows matched by `updatedAt` in range.
 */
export async function fetchDispatchCompletedForRange(range) {
  const { start, end } = range;
  const match = {
    orderStatus: { $in: DISPATCH_LIKE_STATUSES },
    $or: [
      {
        statusChanges: {
          $elemMatch: {
            newStatus: { $in: DISPATCH_LIKE_STATUSES },
            createdAt: { $gte: start, $lte: end },
          },
        },
      },
      {
        updatedAt: { $gte: start, $lte: end },
      },
    ],
  };

  const [byPlant, totalOrders] = await Promise.all([
    Order.aggregate([
      { $match: match },
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
          _id: "$plantLabel",
          orders: { $sum: 1 },
          plantsQty: { $sum: "$qty" },
        },
      },
      { $sort: { plantsQty: -1 } },
    ]),
    Order.countDocuments(match),
  ]);

  return { byPlant, totalOrders, range };
}

export function formatDispatchReportWhatsApp(data) {
  const { byPlant, totalOrders, range } = data;
  const label = `${moment(range.start).utcOffset(330).format("YYYY-MM-DD")} → ${moment(range.end).utcOffset(330).format("YYYY-MM-DD")} (IST)`;
  const lines = [
    "✅ *Dispatch / completed (selected period)*",
    `_Includes orders whose **status change** to dispatch/completed falls in the period, or **updated** in the period (older data without history)._`,
    `Period: _${label}_`,
    `Orders in scope: *${totalOrders}*`,
    "",
    "*By plant (plants / orders):*",
  ];
  for (const r of byPlant) {
    lines.push(`• *${r._id}* — ${r.plantsQty} plants, ${r.orders} orders`);
  }
  if (!byPlant.length) {
    lines.push("— No matching dispatch/completed orders in this period.");
  }
  return lines.join("\n");
}

/**
 * Overall order transition insights from Order + statusChanges in the selected IST range.
 * Includes booking volume for the same range and key today transition counters.
 * @param {{ start: Date, end: Date }} range
 */
export async function fetchOrderTransitionInsights(range) {
  const bookingMatch = matchOrdersInBookingRangeIST(range);
  const todayStart = moment().utcOffset(330).startOf("day").toDate();
  const todayEnd = moment().utcOffset(330).endOf("day").toDate();

  const [bookedOrders, currentStatuses, transitionMatrix, todayPairs] =
    await Promise.all([
      Order.countDocuments(bookingMatch),
      Order.aggregate([
        { $match: bookingMatch },
        {
          $group: {
            _id: "$orderStatus",
            count: { $sum: 1 },
          },
        },
        { $sort: { count: -1 } },
      ]),
      Order.aggregate([
        { $unwind: "$statusChanges" },
        {
          $match: {
            "statusChanges.createdAt": { $gte: range.start, $lte: range.end },
          },
        },
        {
          $group: {
            _id: {
              from: "$statusChanges.previousStatus",
              to: "$statusChanges.newStatus",
            },
            count: { $sum: 1 },
          },
        },
        { $sort: { count: -1 } },
      ]),
      Order.aggregate([
        { $unwind: "$statusChanges" },
        {
          $match: {
            "statusChanges.createdAt": { $gte: todayStart, $lte: todayEnd },
          },
        },
        {
          $group: {
            _id: {
              from: "$statusChanges.previousStatus",
              to: "$statusChanges.newStatus",
            },
            count: { $sum: 1 },
          },
        },
      ]),
    ]);

  const findPair = (from, to) =>
    todayPairs.find((x) => x?._id?.from === from && x?._id?.to === to)?.count ||
    0;

  return {
    range,
    bookedOrders,
    currentStatuses,
    transitionMatrix,
    todayKey: {
      acceptedToDispatched: findPair("ACCEPTED", "DISPATCHED"),
      dispatchedToCompleted: findPair("DISPATCHED", "COMPLETED"),
      farmReadyToDispatch: findPair("FARM_READY", "DISPATCHED"),
      acceptedToFarmReady: findPair("ACCEPTED", "FARM_READY"),
    },
  };
}

export function formatOrderTransitionInsightsWhatsApp(data) {
  const label = `${moment(data.range.start)
    .utcOffset(330)
    .format("YYYY-MM-DD")} → ${moment(data.range.end)
    .utcOffset(330)
    .format("YYYY-MM-DD")} (IST)`;
  const lines = [
    "📈 *Order transitions overview*",
    `Period: _${label}_`,
    `Booked orders in period: *${data.bookedOrders}*`,
    "",
    "*Today — key transitions:*",
    `• ACCEPTED → DISPATCHED: *${data.todayKey.acceptedToDispatched}*`,
    `• DISPATCHED → COMPLETED: *${data.todayKey.dispatchedToCompleted}*`,
    `• FARM_READY → DISPATCHED: *${data.todayKey.farmReadyToDispatch}*`,
    `• ACCEPTED → FARM_READY: *${data.todayKey.acceptedToFarmReady}*`,
    "",
    "*Current status mix (orders booked in selected period):*",
  ];
  for (const r of (data.currentStatuses || []).slice(0, 8)) {
    lines.push(`• ${r._id}: *${r.count}*`);
  }
  if (!data.currentStatuses?.length) {
    lines.push("— no booked orders in selected period.");
  }
  lines.push("", "*Top status transitions in selected period:*");
  for (const r of (data.transitionMatrix || []).slice(0, 10)) {
    lines.push(`• ${r._id?.from} → ${r._id?.to}: *${r.count}*`);
  }
  if (!data.transitionMatrix?.length) {
    lines.push("— no status change rows in selected period.");
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

  return {
    text: sections.join("\n").trimEnd(),
    slotCount: slotRows.length,
    /** Full future slot rows (for PDF / exports). */
    slotRows,
    byPlant,
  };
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

