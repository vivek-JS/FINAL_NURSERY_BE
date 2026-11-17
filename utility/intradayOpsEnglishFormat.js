import { formatIntradayWindowLabels } from "./intradayOpsWindow.js";

const fmt = (n) =>
  Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 0 });

const rupee = (n) => `₹${fmt(Math.round(Number(n) || 0))}`;

export function splitWhatsAppChunks(text, maxLen = 3500) {
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
  if (buf) chunks.push(buf);
  return chunks.length ? chunks : [""];
}

function noneLine(dayEnd) {
  return dayEnd ? "— none today" : "— none in this window";
}

/**
 * @param {object} snapshot — from buildIntradayOpsWhatsappSnapshot / day-end
 * @returns {string[]}
 */
export function formatIntradayOpsEnglishMessages(snapshot) {
  const {
    from,
    to,
    reportKind = "intraday",
    dateKey,
    bookingByPlant = [],
    bookingTotal = {},
    dispatchGroups = [],
    dispatchByPlant = [],
    dispatchTotal = {},
    salesperson = [],
    salespersonTotal = {},
    payments = {},
  } = snapshot || {};

  const dayEnd = reportKind === "dayEnd";
  const labels = formatIntradayWindowLabels(from, to);
  const dayLabel = dateKey
    ? labels.dateLabel
    : labels.dateLabel;

  const header = dayEnd
    ? [
        "📊 *Ram Biotech — Daily Ops Summary*",
        `🗓️ ${dayLabel} (full day IST)`,
        "━━━━━━━━━━━━━━━━━━━━",
      ]
    : [
        "📊 *Ram Biotech — 2.5h Ops Report*",
        `🕐 ${labels.rangeLabel}`,
        "━━━━━━━━━━━━━━━━━━━━",
      ];

  const bookingBlock = ["", "🌱 *BOOKING (Plant / Variety)*"];
  if (!bookingByPlant.length) {
    bookingBlock.push(noneLine(dayEnd));
  } else {
    for (const row of bookingByPlant.slice(0, 40)) {
      bookingBlock.push(
        `• *${row.label}*: ${fmt(row.plants)} plants · ${fmt(row.orders)} orders`
      );
    }
    if (bookingByPlant.length > 40) {
      bookingBlock.push(`_+${bookingByPlant.length - 40} more…_`);
    }
    bookingBlock.push(
      `*Total:* ${fmt(bookingTotal.plants)} plants · ${fmt(bookingTotal.orders)} orders`
    );
  }

  const dispatchBlock = ["", "🚚 *DISPATCH (Plant / Variety · Shed · Batch)*"];
  if (!dispatchGroups.length) {
    dispatchBlock.push(noneLine(dayEnd));
  } else {
    for (const g of dispatchGroups.slice(0, 40)) {
      dispatchBlock.push(`• *${g.label}* — ${fmt(g.plants)}`);
      for (const line of (g.lines || []).slice(0, 12)) {
        const batch = line.batch ? `Batch ${line.batch}` : "Batch —";
        const shed = line.shed || "—";
        dispatchBlock.push(`  – ${shed} · ${batch}: ${fmt(line.plants)}`);
      }
      if ((g.lines || []).length > 12) {
        dispatchBlock.push(`  _+${g.lines.length - 12} more shed/batch…_`);
      }
    }
    if (dispatchGroups.length > 40) {
      dispatchBlock.push(`_+${dispatchGroups.length - 40} more varieties…_`);
    }
    dispatchBlock.push("", "*Dispatched by plant:*");
    if (!dispatchByPlant.length) {
      dispatchBlock.push(noneLine(dayEnd));
    } else {
      for (const row of dispatchByPlant) {
        dispatchBlock.push(`• *${row.plant}*: ${fmt(row.plants)} plants`);
      }
    }
    dispatchBlock.push(`*Grand total:* ${fmt(dispatchTotal.plants)} plants`);
  }

  const salesBlock = ["", "👤 *SALESPERSON (variety · plants · amount)*"];
  if (!salesperson.length) {
    salesBlock.push(noneLine(dayEnd));
  } else {
    for (const row of salesperson.slice(0, 30)) {
      salesBlock.push(
        `• *${row.name}*: ${fmt(row.plants)} plants · ${rupee(row.amount)}`
      );
      for (const v of (row.varieties || []).slice(0, 12)) {
        salesBlock.push(
          `  – ${v.label}: ${fmt(v.plants)} plants · ${rupee(v.amount)}`
        );
      }
      if ((row.varieties || []).length > 12) {
        salesBlock.push(`  _+${row.varieties.length - 12} more varieties…_`);
      }
    }
    if (salesperson.length > 30) {
      salesBlock.push(`_+${salesperson.length - 30} more…_`);
    }
    salesBlock.push(
      `*Total:* ${fmt(salespersonTotal.plants)} plants · ${rupee(salespersonTotal.amount)}`
    );
  }

  const pay = payments || {};
  const collectedLabel = dayEnd ? "Collected (today)" : "Collected (this window)";
  const paymentBlock = [
    "",
    "💰 *PAYMENTS*",
    `✅ *${collectedLabel}:* ${rupee(pay.collectedAmount)} · ${fmt(pay.collectedCount)} payments`,
    `⏳ *Pending (open):* ${rupee(pay.pendingAmount)} · ${fmt(pay.pendingCount)} payments`,
  ];
  if (pay.pendingSamples?.length) {
    paymentBlock.push("_Top pending:_");
    for (const p of pay.pendingSamples.slice(0, 5)) {
      const farmer = p.farmerName ? ` · ${p.farmerName}` : "";
      paymentBlock.push(`  • ${p.label}${farmer}: ${rupee(p.amount)}`);
    }
  }

  const footer = [
    "",
    "━━━━━━━━━━━━━━━━━━━━",
    dayEnd
      ? `_ERP daily summary · ${labels.runLabel} IST_`
      : `_ERP 2.5h report · ${labels.runLabel} IST_`,
  ];

  const full = [
    ...header,
    ...bookingBlock,
    ...dispatchBlock,
    ...salesBlock,
    ...paymentBlock,
    ...footer,
  ].join("\n");

  return splitWhatsAppChunks(full);
}
