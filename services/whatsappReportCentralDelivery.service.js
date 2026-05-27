import moment from "moment";
import { runCentralReport } from "../utility/centralReportEngine/index.js";
import { formatISTRangeLabel } from "./reportService.js";

function fmtOp({ orders = 0, plants = 0 }) {
  return `${orders} ord / ${plants} plants`;
}

function sumDeliveryBucket(delivery, key) {
  const b = delivery?.[key];
  return { orders: b?.orders || 0, plants: b?.plants || 0 };
}

function deliveryPlantsTotal(delivery) {
  return delivery?.total?.plants || 0;
}

/**
 * Fetch admin daily MIS via central report engine (plant + subtype + past due).
 * @param {{ start: Date, end: Date }} range
 */
export async function fetchCentralDeliveryReport(range) {
  const startYmd = moment(range.start).utcOffset(330).format("YYYY-MM-DD");
  const endYmd = moment(range.end).utcOffset(330).format("YYYY-MM-DD");
  const result = await runCentralReport("admin-daily-mis", startYmd, endYmd, {
    includeAllPastDue: true,
  });
  if (result.error) {
    throw new Error(result.error);
  }
  return {
    data: result.data,
    rangeLabel: formatISTRangeLabel(range.start, range.end),
    startYmd,
    endYmd,
  };
}

function formatDeliveryBucketsShort(delivery) {
  const acc = sumDeliveryBucket(delivery, "accepted");
  const fr = sumDeliveryBucket(delivery, "farmReady");
  const rfd = sumDeliveryBucket(delivery, "readyForDispatch");
  const dp = sumDeliveryBucket(delivery, "dispatchProcess");
  const pc = sumDeliveryBucket(delivery, "partiallyCompleted");
  const parts = [];
  if (acc.plants) parts.push(`ACC ${acc.plants}`);
  if (fr.plants) parts.push(`FR ${fr.plants}`);
  if (rfd.plants) parts.push(`RFD ${rfd.plants}`);
  if (dp.plants) parts.push(`DP ${dp.plants}`);
  if (pc.plants) parts.push(`PC ${pc.plants}`);
  return parts.length ? parts.join(" · ") : "—";
}

/**
 * WhatsApp text for central MIS delivery (totals + plant/subtype + past due).
 */
export function formatCentralDeliveryWhatsApp({ data, rangeLabel }) {
  const varietyRows = data?.varietyTable || [];
  const varietyTotals = data?.varietyTotals || {};
  const dueSummary = data?.dueSummary || {};
  const inRangeDel = varietyTotals?.delivery || {};
  const pastDueDel = varietyTotals?.pastDue || {};

  const lines = [
    "🚚 *Delivery report*",
    `_IST window: ${rangeLabel}_`,
    "_Source: central MIS (same as Admin Stats)_",
    "",
    "📊 *In-window delivery* (date falls in selected range)",
    `Total: *${deliveryPlantsTotal(inRangeDel)}* plants | *${inRangeDel.total?.orders || 0}* orders`,
    `• ACCEPTED: ${fmtOp(inRangeDel.accepted)}`,
    `• FARM_READY: ${fmtOp(inRangeDel.farmReady)}`,
    `• READY_FOR_DISPATCH: ${fmtOp(inRangeDel.readyForDispatch)}`,
    `• DISPATCH_PROCESS: ${fmtOp(inRangeDel.dispatchProcess)}`,
    `• PARTIALLY_COMPLETED: ${fmtOp(inRangeDel.partiallyCompleted)}`,
    "",
    "⏰ *Past due* (delivery date before window start)",
    `Total: *${dueSummary.pastDue?.plants || deliveryPlantsTotal(pastDueDel)}* plants | *${dueSummary.pastDue?.orders || pastDueDel.total?.orders || 0}* orders`,
    `• ACCEPTED: ${fmtOp(pastDueDel.accepted)}`,
    `• FARM_READY: ${fmtOp(pastDueDel.farmReady)}`,
    `• READY_FOR_DISPATCH: ${fmtOp(pastDueDel.readyForDispatch)}`,
    "",
    "🌿 *Plant → subtype (in-window delivery plants)*",
  ];

  const withDelivery = varietyRows.filter(
    (r) => deliveryPlantsTotal(r.delivery) > 0 || deliveryPlantsTotal(r.pastDue) > 0
  );

  if (!withDelivery.length) {
    lines.push("— No delivery lines in this window or past-due backlog.");
  } else {
    let currentPlant = "";
    for (const row of withDelivery) {
      const plant = row.plantName || "Unknown";
      if (plant !== currentPlant) {
        if (currentPlant) lines.push("");
        lines.push(`*${plant}*`);
        currentPlant = plant;
      }
      const sub = row.subtype || "Other";
      const inWin = deliveryPlantsTotal(row.delivery);
      const past = deliveryPlantsTotal(row.pastDue);
      const bucketHint = formatDeliveryBucketsShort(row.delivery);
      lines.push(
        `  • *${sub}*: in-window *${inWin}* (${bucketHint})` +
          (past > 0 ? ` | past due *${past}*` : "")
      );
    }
  }

  lines.push("", "📎 *PDF attached* — full plant/subtype table + past due.");
  return lines.join("\n");
}

/** Group variety rows by plant for PDF bar chart. */
export function plantTotalsFromVarietyTable(varietyRows, { pastDue = false } = {}) {
  const m = new Map();
  for (const row of varietyRows || []) {
    const plant = row.plantName || "Unknown";
    const src = pastDue ? row.pastDue : row.delivery;
    const qty = deliveryPlantsTotal(src);
    if (qty <= 0) continue;
    m.set(plant, (m.get(plant) || 0) + qty);
  }
  return [...m.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([label, value]) => ({ label, value }));
}
