import moment from "moment";

const fmt = (n) =>
  Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 0 });

const rupee = (n) => `₹${fmt(Math.round(Number(n) || 0))}`;

function marathiWeekday(dateKey) {
  const days = ["रविवार", "सोमवार", "मंगळवार", "बुधवार", "गुरुवार", "शुक्रवार", "शनिवार"];
  const d = moment(dateKey, "YYYY-MM-DD").utcOffset(330);
  return days[d.day()] || "";
}

function marathiDateLabel(dateKey) {
  const d = moment(dateKey, "YYYY-MM-DD").utcOffset(330);
  return `${d.format("DD MMM YYYY")} (${marathiWeekday(dateKey)})`;
}

function plantLines(rows, { plantsKey = "plants", ordersKey = "orders", max = 20 } = {}) {
  if (!rows?.length) return ["— कोणतेही डेटा नाही"];
  const shown = rows.slice(0, max);
  const lines = shown.map((r) => {
    const orders = r[ordersKey] ? ` · ${fmt(r[ordersKey])} ऑर्डर` : "";
    return `• *${r.label}*: ${fmt(r[plantsKey])} रोप${orders}`;
  });
  if (rows.length > max) {
    lines.push(`_+${rows.length - max} अधिक plant/subtype…_`);
  }
  return lines;
}

/**
 * @param {object} snapshot — from buildAdminDailyMisWhatsappSnapshot
 * @returns {string[]}
 */
export function formatAdminDailyMisMarathiMessages(snapshot) {
  const {
    dateKey,
    bookingByPlant = [],
    dispatchByPlant = [],
    bookingTotal = {},
    dispatchTotal = {},
    payments = {},
    ramAgriStock = [],
    ramAgriStockTotal = 0,
  } = snapshot;

  const header = [
    "📊 *Ram Biotech — दैनिक ERP अहवाल*",
    `🗓️ ${marathiDateLabel(dateKey)}`,
    "━━━━━━━━━━━━━━━━━━━━",
  ];

  const bookingBlock = [
    "",
    "🌱 *आजची बुकिंग (Plant / Subtype)*",
    ...plantLines(bookingByPlant),
    `*एकूण:* ${fmt(bookingTotal.plants)} रोप · ${fmt(bookingTotal.orders)} ऑर्डर`,
  ];

  const dispatchBlock = [
    "",
    "🚚 *आजचा डिस्पॅच (Plant / Subtype)*",
    ...plantLines(dispatchByPlant),
    `*एकूण:* ${fmt(dispatchTotal.plants)} रोप · ${fmt(dispatchTotal.orders)} ऑर्डर`,
  ];

  const pay = payments;
  const paymentBlock = [
    "",
    "💰 *पेमेंट*",
    `✅ *स्वीकारले (आज):* ${rupee(pay.collectedTodayAmount)} · ${fmt(pay.collectedTodayCount)} पेमेंट`,
    `⏳ *प्रलंबित (एकूण):* ${rupee(pay.pendingAmount)} · ${fmt(pay.pendingCount)} पेमेंट`,
  ];

  if (pay.pendingSamples?.length) {
    paymentBlock.push("_Top pending:_");
    for (const p of pay.pendingSamples.slice(0, 5)) {
      paymentBlock.push(`  • ${p.label}: ${rupee(p.amount)} (${p.source})`);
    }
  }

  const stockBlock = [
    "",
    "📦 *Ram Agri Input — स्टॉक*",
  ];

  if (!ramAgriStock.length) {
    stockBlock.push("— सक्रिय उत्पादने नाहीत");
  } else {
    for (const row of ramAgriStock.slice(0, 15)) {
      const unit = row.unit ? ` ${row.unit}` : "";
      stockBlock.push(`• *${row.label}*: ${fmt(row.stock)}${unit}`);
    }
    if (ramAgriStock.length > 15) {
      stockBlock.push(`_+${ramAgriStock.length - 15} अधिक वैरायटी…_`);
    }
    stockBlock.push(`*एकूण वैरायटी:* ${fmt(ramAgriStock.length)} · *Stock lines:* ${fmt(ramAgriStockTotal)}`);
  }

  const footer = [
    "",
    "━━━━━━━━━━━━━━━━━━━━",
    "_ERP Admin MIS · 7:00 PM IST_",
    "_Ram Biotech Plants 🌿_",
  ];

  const full = [
    ...header,
    ...bookingBlock,
    ...dispatchBlock,
    ...paymentBlock,
    ...stockBlock,
    ...footer,
  ].join("\n");

  return splitWhatsAppChunks(full);
}

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
