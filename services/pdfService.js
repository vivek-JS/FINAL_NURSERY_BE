import PDFDocument from "pdfkit";
import { formatPlantCell } from "./reportService.js";

/** Per-report colour themes — nursery / agri aesthetic */
const THEMES = {
  booking: {
    primary: "#14532d",
    primaryLight: "#166534",
    accent: "#ca8a04",
    accentSoft: "#fef3c7",
    bar: "#4ade80",
    barBg: "#dcfce7",
    kpiText: "#14532d",
    tableHead: "#166534",
    rowAlt: "#f0fdf4",
    calloutBg: "#ecfdf5",
    calloutBorder: "#86efac",
  },
  delivery: {
    primary: "#0f172a",
    primaryLight: "#1e293b",
    accent: "#f59e0b",
    accentSoft: "#fef3c7",
    bar: "#60a5fa",
    barBg: "#dbeafe",
    kpiText: "#0f172a",
    tableHead: "#1e40af",
    rowAlt: "#f8fafc",
    calloutBg: "#eff6ff",
    calloutBorder: "#93c5fd",
  },
  availability: {
    primary: "#064e3b",
    primaryLight: "#047857",
    accent: "#34d399",
    accentSoft: "#d1fae5",
    bar: "#10b981",
    barBg: "#a7f3d0",
    kpiText: "#065f46",
    tableHead: "#059669",
    rowAlt: "#ecfdf5",
    calloutBg: "#ecfdf5",
    calloutBorder: "#6ee7b7",
  },
  slots: {
    primary: "#1e3a5f",
    primaryLight: "#2563eb",
    accent: "#38bdf8",
    accentSoft: "#e0f2fe",
    bar: "#0ea5e9",
    barBg: "#bae6fd",
    kpiText: "#1e3a5f",
    tableHead: "#0369a1",
    rowAlt: "#f0f9ff",
    calloutBg: "#e0f2fe",
    calloutBorder: "#7dd3fc",
  },
  insight: {
    primary: "#312e81",
    primaryLight: "#4338ca",
    accent: "#a78bfa",
    accentSoft: "#ede9fe",
    bar: "#818cf8",
    barBg: "#c7d2fe",
    kpiText: "#312e81",
    tableHead: "#4f46e5",
    rowAlt: "#f5f3ff",
    calloutBg: "#ede9fe",
    calloutBorder: "#c4b5fd",
  },
};

const COLORS = {
  headerBar: THEMES.delivery.primary,
  headerAccent: THEMES.delivery.accent,
  headerText: "#ffffff",
  accent: THEMES.delivery.tableHead,
  muted: "#64748b",
  border: "#e2e8f0",
  rowAlt: "#f8fafc",
  kpiBg: "#ffffff",
  kpiBorder: "#e2e8f0",
  text: "#1e293b",
  textSoft: "#475569",
  white: "#ffffff",
  shadow: "#cbd5e1",
};

function formatInr(n) {
  const x = Math.round(Number(n) || 0);
  return `₹${x.toLocaleString("en-IN")}`;
}

function formatNum(n) {
  return Number(n || 0).toLocaleString("en-IN");
}

function fmtGenDate() {
  return new Date().toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Layered hero banner with brand strip + accent line */
function drawHeroBanner(doc, ml, y, usableW, { title, subtitle, theme, badge = "RAM BIOTECH" }) {
  const h = 64;
  const t = theme || THEMES.delivery;

  doc.save();
  // soft shadow
  doc.rect(ml + 2, y + 3, usableW, h).fill(COLORS.shadow);
  // main panel
  doc.rect(ml, y, usableW, h).fill(t.primary);
  // left brand stripe
  doc.rect(ml, y, 6, h).fill(t.accent);
  // subtle top highlight
  doc.rect(ml + 6, y, usableW - 6, 14).fill(t.primaryLight).opacity(0.35);
  doc.opacity(1);

  // badge pill
  const badgeW = doc.widthOfString(badge, { font: "Helvetica-Bold", size: 7 }) + 16;
  doc.roundedRect(ml + usableW - badgeW - 14, y + 10, badgeW, 16, 8).fill(t.accent);
  doc.fillColor(t.primary).font("Helvetica-Bold").fontSize(7);
  doc.text(badge, ml + usableW - badgeW - 14, y + 14, {
    width: badgeW,
    align: "center",
  });

  doc.fillColor(COLORS.white).font("Helvetica-Bold").fontSize(23);
  doc.text(title, ml + 18, y + 16, { width: usableW - badgeW - 40 });
  doc.font("Helvetica").fontSize(10).fillColor("#cbd5e1");
  doc.text(subtitle, ml + 18, y + 42, { width: usableW - 36 });

  // accent underline
  doc.rect(ml, y + h - 3, usableW, 3).fill(t.accent);
  doc.restore();

  return y + h + 14;
}

/** KPI card row with shadow + left accent */
function drawKpiCards(doc, ml, y, usableW, kpis, theme) {
  const t = theme || THEMES.delivery;
  const gap = 12;
  const count = kpis.length;
  const kpiW = (usableW - gap * (count - 1)) / count;
  const kpiH = 62;
  let kx = ml;

  for (let i = 0; i < kpis.length; i++) {
    const k = kpis[i];
    doc.save();
    doc.rect(kx + 1, y + 2, kpiW, kpiH).fill(COLORS.shadow);
    doc.roundedRect(kx, y, kpiW, kpiH, 6).fillAndStroke(COLORS.white, COLORS.border);
    doc.rect(kx, y + 4, 4, kpiH - 8).fill(t.accent);
    doc.fillColor(t.kpiText).font("Helvetica-Bold").fontSize(22);
    doc.text(String(k.value), kx + 14, y + 12, {
      width: kpiW - 20,
      align: "left",
    });
    doc.fillColor(COLORS.muted).font("Helvetica").fontSize(8);
    doc.text(k.label, kx + 14, y + 38, { width: kpiW - 20 });
    if (k.sub) {
      doc.font("Helvetica-Oblique").fontSize(7).fillColor(COLORS.textSoft);
      doc.text(k.sub, kx + 14, y + 50, { width: kpiW - 20 });
    }
    doc.restore();
    kx += kpiW + gap;
  }
  return y + kpiH + 16;
}

function drawSectionTitle(doc, ml, y, usableW, title, theme) {
  const t = theme || THEMES.delivery;
  doc.fillColor(t.primary).font("Helvetica-Bold").fontSize(12);
  doc.text(title, ml, y, { width: usableW });
  doc.rect(ml, y + 16, 48, 3).fill(t.accent);
  return y + 26;
}

function drawCalloutBox(doc, ml, y, usableW, heading, lines, theme) {
  const t = theme || THEMES.delivery;
  const lineH = 11;
  const boxH = 18 + lines.length * lineH;
  doc.save();
  doc.roundedRect(ml, y, usableW, boxH, 5).fill(t.calloutBg);
  doc.roundedRect(ml, y, usableW, boxH, 5).stroke(t.calloutBorder);
  doc.rect(ml, y, 4, boxH).fill(t.accent);
  doc.fillColor(t.primary).font("Helvetica-Bold").fontSize(9);
  doc.text(heading, ml + 12, y + 8, { width: usableW - 20 });
  doc.font("Helvetica").fontSize(8).fillColor(COLORS.textSoft);
  let ey = y + 22;
  for (const line of lines) {
    doc.text(`• ${line}`, ml + 12, ey, { width: usableW - 20 });
    ey += lineH;
  }
  doc.restore();
  return y + boxH + 12;
}

function drawHorizontalBars(doc, ml, y, usableW, rows, theme, pageH, mt, bottomMargin) {
  if (!rows?.length) return y;
  const t = theme || THEMES.delivery;
  const maxV = Math.max(...rows.map((x) => x.value), 1);
  const rowH = 22;
  const labelW = usableW * 0.3;
  const barMax = usableW * 0.52;

  rows.forEach((row, i) => {
    if (y > pageH - bottomMargin - 50) {
      doc.addPage();
      y = mt;
    }
    doc.font("Helvetica").fontSize(8.5).fillColor(COLORS.text);
    doc.text(String(row.label).slice(0, 38), ml, y + 6, { width: labelW - 8 });
    const frac = row.value / maxV;
    const barW = Math.max(6, barMax * frac);
    doc.save();
    doc.roundedRect(ml + labelW, y + 4, barMax, rowH - 8, 3).fill(t.barBg);
    doc.roundedRect(ml + labelW, y + 4, barW, rowH - 8, 3).fill(i % 2 === 0 ? t.bar : t.primaryLight);
    doc.restore();
    doc.font("Helvetica-Bold").fontSize(9).fillColor(t.primary);
    doc.text(formatNum(row.value), ml + labelW + barMax + 8, y + 6, {
      width: 72,
      align: "right",
    });
    y += rowH;
  });
  return y + 8;
}

function drawTableHeader(doc, ml, y, usableW, columns, theme) {
  const t = theme || THEMES.delivery;
  const hh = 26;
  doc.save();
  doc.roundedRect(ml, y, usableW, hh, 4).fill(t.tableHead);
  doc.fillColor(COLORS.white).font("Helvetica-Bold").fontSize(8);
  for (const col of columns) {
    doc.text(col.label, col.x + 4, y + 9, {
      width: col.w - 8,
      align: col.align || "left",
    });
  }
  doc.restore();
  return y + hh;
}

function drawTableRow(doc, ml, y, usableW, rowH, columns, values, idx, theme) {
  const t = theme || THEMES.delivery;
  if (idx % 2 === 0) {
    doc.save();
    doc.rect(ml, y, usableW, rowH).fill(t.rowAlt);
    doc.restore();
  }
  doc.font("Helvetica").fontSize(8.5).fillColor(COLORS.text);
  values.forEach((val, i) => {
    const col = columns[i];
    const opts = { width: col.w - 8, align: col.align || "left" };
    if (col.bold) doc.font("Helvetica-Bold");
    if (col.color) doc.fillColor(col.color);
    doc.text(String(val ?? ""), col.x + 4, y + 6, opts);
    doc.font("Helvetica").fillColor(COLORS.text);
  });
  return y + rowH;
}

function drawGrandTotalBar(doc, ml, y, usableW, label, value, theme) {
  const t = theme || THEMES.booking;
  doc.save();
  doc.roundedRect(ml, y, usableW, 34, 5).fill(t.primary);
  doc.rect(ml, y, 5, 34).fill(t.accent);
  doc.fillColor(COLORS.white).font("Helvetica-Bold").fontSize(12);
  doc.text(label, ml + 16, y + 10, { width: usableW - 100 });
  doc.font("Helvetica-Bold").fontSize(14).text(formatNum(value), ml, y + 9, {
    width: usableW - 16,
    align: "right",
  });
  doc.restore();
  return y + 44;
}

function drawFooter(doc, ml, y, usableW, meta, theme) {
  const t = theme || THEMES.delivery;
  doc.moveTo(ml, y).lineTo(ml + usableW, y).strokeColor(t.calloutBorder).lineWidth(0.5).stroke();
  y += 8;
  doc.fillColor(COLORS.muted).font("Helvetica").fontSize(7.5);
  doc.text(
    `Generated ${fmtGenDate()} IST · ${meta}`,
    ml,
    y,
    { width: usableW, align: "center" }
  );
}

function drawEmptyState(doc, ml, y, usableW, message, theme) {
  const t = theme || THEMES.delivery;
  doc.save();
  doc.roundedRect(ml, y, usableW, 32, 4).fill(t.accentSoft);
  doc.fillColor(t.primary).font("Helvetica-Oblique").fontSize(9);
  doc.text(message, ml + 12, y + 10, { width: usableW - 24, align: "center" });
  doc.restore();
  return y + 40;
}

/** @param {{ plant: string, subtype: string, quantity: number }[]} summaryRows */
export function plantTotalsForBarChart(summaryRows, limit = 6) {
  const m = new Map();
  for (const r of summaryRows || []) {
    const p = r.plant || "—";
    m.set(p, (m.get(p) || 0) + (Number(r.quantity) || 0));
  }
  return [...m.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([label, value]) => ({ label, value }));
}

/** @param {{ plantName: string, booked?: number }[]} slotRows */
export function plantBookedTotalsForBarChart(slotRows, limit = 8) {
  const m = new Map();
  for (const r of slotRows || []) {
    const p = r.plantName || "—";
    m.set(p, (m.get(p) || 0) + (Number(r.booked) || 0));
  }
  return [...m.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([label, value]) => ({ label, value }));
}

/**
 * @param {object} opts
 * @param {string} opts.reportDateLabel
 * @param {{ farmerName: string, plantName: string, plantType: string, subtype: string, quantity: number }[]} opts.lineRows
 * @param {{ plant: string, subtype: string, quantity: number }[]} opts.summaryRows
 * @param {{ grandTotal: number, bookingLines: number, uniqueFarmers: number }} opts.stats
 * @param {string} [opts.dataSourceLabel] - Shown in footer (e.g. orders vs legacy bookings)
 * @param {string} [opts.bannerTitle] - Main PDF title (default: Today’s booking)
 * @param {{ name: string, quantity: number }[]} [opts.topFarmers]
 * @param {{ name: string, quantity: number }[]} [opts.topVillages]
 * @param {{ totalDue?: number, totalCollected?: number, totalOutstanding?: number, pendingPaymentOrders?: number, completedPaymentOrders?: number } | null} [opts.paymentSnapshot]
 * @param {{ label: string, value: number }[]} [opts.plantBarChart] - Horizontal bars by plant qty
 */
export function generateTodayBookingPdf({
  reportDateLabel,
  lineRows,
  summaryRows,
  stats,
  dataSourceLabel = "Farmer orders (IST)",
  bannerTitle = "Today's Booking Report",
  topFarmers = [],
  topVillages = [],
  paymentSnapshot = null,
  plantBarChart = null,
}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      layout: "landscape",
      margin: 36,
      info: {
        Title: "Today Booking Report",
        Author: "Nursery Management",
      },
    });

    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const pageW = doc.page.width;
    const pageH = doc.page.height;
    const ml = doc.page.margins.left;
    const mr = doc.page.margins.right;
    const mt = doc.page.margins.top;
    const mb = doc.page.margins.bottom;
    const usableW = pageW - ml - mr;
    const theme = THEMES.booking;

    let y = drawHeroBanner(doc, ml, mt, usableW, {
      title: bannerTitle,
      subtitle: reportDateLabel,
      theme,
      badge: "BOOKING",
    });

    y = drawKpiCards(
      doc,
      ml,
      y,
      usableW,
      [
        { label: "Total plants booked", value: formatNum(stats.grandTotal) },
        { label: "Booking lines", value: formatNum(stats.bookingLines) },
        { label: "Distinct farmers", value: formatNum(stats.uniqueFarmers) },
      ],
      theme
    );

    const bars =
      plantBarChart && plantBarChart.length
        ? plantBarChart
        : plantTotalsForBarChart(summaryRows, 6);
    if (bars.length) {
      y = drawSectionTitle(doc, ml, y, usableW, "Plant booking volume", theme);
      y = drawHorizontalBars(doc, ml, y, usableW, bars, theme, pageH, mt, mb + 50);
    }

    if (topFarmers && topFarmers.length) {
      if (y > pageH - mb - 120) {
        doc.addPage();
        y = mt;
      }
      y = drawSectionTitle(doc, ml, y, usableW, "Top farmers by quantity", theme);
      doc.font("Helvetica").fontSize(9).fillColor(COLORS.text);
      topFarmers.forEach((f, i) => {
        doc.fillColor(theme.primary).font("Helvetica-Bold").text(`${i + 1}.`, ml, y, { continued: true });
        doc.fillColor(COLORS.text).font("Helvetica").text(` ${f.name} — ${formatNum(f.quantity)} plants`, { width: usableW });
        y += 14;
      });
      y += 6;
    }

    if (topVillages && topVillages.length) {
      if (y > pageH - mb - 100) {
        doc.addPage();
        y = mt;
      }
      y = drawSectionTitle(doc, ml, y, usableW, "Top villages / areas", theme);
      doc.font("Helvetica").fontSize(9).fillColor(COLORS.text);
      topVillages.forEach((v, i) => {
        doc.fillColor(theme.primary).font("Helvetica-Bold").text(`${i + 1}.`, ml, y, { continued: true });
        doc.fillColor(COLORS.text).font("Helvetica").text(` ${v.name} — ${formatNum(v.quantity)} plants`, { width: usableW });
        y += 14;
      });
      y += 6;
    }

    if (paymentSnapshot && paymentSnapshot.totalDue != null) {
      if (y > pageH - mb - 80) {
        doc.addPage();
        y = mt;
      }
      y = drawCalloutBox(
        doc,
        ml,
        y,
        usableW,
        "Payment summary",
        [
          `Billable: ${formatInr(paymentSnapshot.totalDue)} · Collected: ${formatInr(paymentSnapshot.totalCollected)} · Outstanding: ${formatInr(paymentSnapshot.totalOutstanding)}`,
          `PENDING orders: ${paymentSnapshot.pendingPaymentOrders ?? "—"} · COMPLETED: ${paymentSnapshot.completedPaymentOrders ?? "—"}`,
        ],
        theme
      );
    }

    if (y > pageH - mb - 140) {
      doc.addPage();
      y = mt;
    }
    y = drawSectionTitle(doc, ml, y, usableW, "Booking detail", theme);
    y += 4;

    // --- Detail table (column widths as fractions of usable width) ---
    const wSr = usableW * 0.045;
    const wFarmer = usableW * 0.24;
    const wPlant = usableW * 0.255;
    const wSubtype = usableW * 0.255;
    const wQty = usableW - wSr - wFarmer - wPlant - wSubtype;

    const col = {
      sr: ml,
      farmer: ml + wSr,
      plant: ml + wSr + wFarmer,
      subtype: ml + wSr + wFarmer + wPlant,
      qty: ml + wSr + wFarmer + wPlant + wSubtype,
    };
    const widths = {
      sr: wSr - 6,
      farmer: wFarmer - 6,
      plant: wPlant - 6,
      subtype: wSubtype - 6,
      qty: wQty - 6,
    };

    const headerH = 24;
    const detailCols = [
      { label: "Sr", x: col.sr, w: widths.sr + 6 },
      { label: "Farmer", x: col.farmer, w: widths.farmer + 6 },
      { label: "Plant", x: col.plant, w: widths.plant + 6 },
      { label: "Subtype", x: col.subtype, w: widths.subtype + 6 },
      { label: "Qty", x: col.qty, w: widths.qty + 6, align: "right" },
    ];
    y = drawTableHeader(doc, ml, y, usableW, detailCols, theme);

    if (!lineRows.length) {
      y = drawEmptyState(doc, ml, y, usableW, "No bookings recorded for this period (IST).", theme);
    } else {
      lineRows.forEach((row, idx) => {
        if (y > pageH - mb - 120) {
          doc.addPage();
          y = mt;
        }
        const rowH = 26;
        const plantDisplay = formatPlantCell(row.plantName, row.plantType);
        y = drawTableRow(
          doc,
          ml,
          y,
          usableW,
          rowH,
          detailCols,
          [
            String(idx + 1),
            row.farmerName,
            plantDisplay,
            row.subtype,
            formatNum(row.quantity),
          ],
          idx,
          theme
        );
      });
    }

    y += 14;
    y = drawSectionTitle(doc, ml, y, usableW, "Summary — Plant × Subtype", theme);
    y += 4;

    const sCol = { plant: ml, subtype: ml + 280, qty: ml + 560 };
    const sW = { plant: 268, subtype: 268, qty: usableW - (560 - ml) };
    const sumCols = [
      { label: "Plant", x: sCol.plant, w: sW.plant },
      { label: "Subtype", x: sCol.subtype, w: sW.subtype },
      { label: "Total qty", x: sCol.qty, w: sW.qty, align: "right" },
    ];
    y = drawTableHeader(doc, ml, y, usableW, sumCols, theme);

    if (!summaryRows.length) {
      y = drawEmptyState(doc, ml, y, usableW, "No summary rows.", theme);
    } else {
      summaryRows.forEach((r, i) => {
        if (y > pageH - mb - 60) {
          doc.addPage();
          y = mt;
        }
        y = drawTableRow(
          doc,
          ml,
          y,
          usableW,
          20,
          sumCols,
          [r.plant, r.subtype, formatNum(r.quantity)],
          i,
          theme
        );
      });
    }

    y += 8;
    y = drawGrandTotalBar(doc, ml, y, usableW, "Grand total (plants)", stats.grandTotal, theme);
    drawFooter(doc, ml, y, usableW, `${dataSourceLabel} · ${reportDateLabel}`, theme);

    doc.end();
  });
}

/**
 * Delivery planning: ACCEPTED + FARM_READY, optional multiple segments (due / no due / both).
 * @param {object} opts
 * @param {string} opts.reportDateLabel
 * @param {Record<string, { accepted: { orders: number, plantsQty: number }, farmReady: { orders: number, plantsQty: number } }>} [opts.byPlant]
 * @param {{ acceptedOrders: number, farmReadyOrders: number, acceptedPlants: number, farmReadyPlants: number }} [opts.totals]
 * @param {{ title: string, byPlant: object, totals: object }[]} [opts.segments]
 * @param {null | { totalDue?: number, totalCollected?: number, totalOutstanding?: number, pendingPaymentOrders?: number, completedPaymentOrders?: number }} [opts.paymentSnapshot]
 */
export function generateDeliveryQueuePdf({
  reportDateLabel,
  byPlant = {},
  totals,
  paymentSnapshot = null,
  segments = null,
}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      layout: "landscape",
      margin: 36,
      info: {
        Title: "Delivery queue report",
        Author: "Nursery Management",
      },
    });

    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const pageW = doc.page.width;
    const pageH = doc.page.height;
    const ml = doc.page.margins.left;
    const mr = doc.page.margins.right;
    const mt = doc.page.margins.top;
    const mb = doc.page.margins.bottom;
    const usableW = pageW - ml - mr;
    const theme = THEMES.delivery;
    let y = mt;

    const segs =
      segments && segments.length > 0
        ? segments
        : [
            {
              title: "Delivery queue",
              byPlant,
              totals,
            },
          ];

    y = drawHeroBanner(doc, ml, y, usableW, {
      title: "Delivery Queue Report",
      subtitle: reportDateLabel,
      theme,
      badge: "DELIVERY",
    });

    y = drawCalloutBox(
      doc,
      ml,
      y,
      usableW,
      "How to read this report",
      [
        "ACCEPTED = approved booking; FARM_READY = plants ready at farm — both await dispatch.",
        segs.length > 1
          ? "Separate sections: orders with delivery date in window vs orders without a date."
          : "Filtered by your WhatsApp due / no-due selection.",
      ],
      theme
    );

    const kpiH = 50;
    const gap = 10;
    const kpiW = (usableW - gap) / 2;

    const drawKpi2 = (row) => {
      let kx = ml;
      for (let i = 0; i < row.length; i++) {
        doc.save();
        doc.rect(kx + 1, y + 2, kpiW, kpiH).fill(COLORS.shadow);
        doc.roundedRect(kx, y, kpiW, kpiH, 5).fillAndStroke(COLORS.white, COLORS.border);
        doc.rect(kx, y + 6, 4, kpiH - 12).fill(theme.accent);
        doc.fillColor(theme.kpiText).font("Helvetica-Bold").fontSize(18);
        doc.text(row[i].value, kx + 12, y + 8, { width: kpiW - 20, align: "left" });
        doc.fillColor(COLORS.muted).font("Helvetica").fontSize(8);
        doc.text(row[i].label, kx + 12, y + 30, { width: kpiW - 20 });
        if (row[i].sub) {
          doc.font("Helvetica-Oblique").fontSize(7).text(row[i].sub, kx + 12, y + 40, { width: kpiW - 20 });
        }
        doc.restore();
        kx += kpiW + gap;
      }
    };

    for (let si = 0; si < segs.length; si++) {
      const seg = segs[si];
      if (y > pageH - mb - 140) {
        doc.addPage();
        y = mt;
      }

      y = drawSectionTitle(doc, ml, y, usableW, seg.title, theme);

      const st = seg.totals;
      const totalOrders = st.acceptedOrders + st.farmReadyOrders;
      const totalPlants = st.acceptedPlants + st.farmReadyPlants;
      drawKpi2([
        { label: "Orders in section", value: formatNum(totalOrders), sub: "ACCEPTED + FARM_READY" },
        { label: "Plants in section", value: formatNum(totalPlants), sub: "sum of quantities" },
      ]);
      y += kpiH + 10;
      drawKpi2([
        { label: "ACCEPTED", value: `${st.acceptedOrders} ord`, sub: `${formatNum(st.acceptedPlants)} plants` },
        { label: "FARM_READY", value: `${st.farmReadyOrders} ord`, sub: `${formatNum(st.farmReadyPlants)} plants` },
      ]);
      y += kpiH + 16;

      const barSource = Object.keys(seg.byPlant || {})
        .sort((a, b) => a.localeCompare(b))
        .map((name) => {
          const b = seg.byPlant[name];
          const q = (b.accepted?.plantsQty || 0) + (b.farmReady?.plantsQty || 0);
          return { label: name, value: q };
        })
        .filter((x) => x.value > 0)
        .sort((a, b) => b.value - a.value)
        .slice(0, 8);

      if (barSource.length) {
        y = drawSectionTitle(doc, ml, y, usableW, "Plants by crop", theme);
        y = drawHorizontalBars(doc, ml, y, usableW, barSource, theme, pageH, mt, mb + 50);
      }

      y = drawSectionTitle(doc, ml, y, usableW, "Detail by plant", theme);
      y += 4;

      const plants = Object.keys(seg.byPlant || {}).sort((a, b) => a.localeCompare(b));
      const col = {
        plant: ml,
        ao: ml + usableW * 0.22,
        ap: ml + usableW * 0.34,
        fo: ml + usableW * 0.46,
        fp: ml + usableW * 0.58,
        tp: ml + usableW * 0.72,
      };
      const delCols = [
        { label: "Plant", x: col.plant, w: usableW * 0.2 },
        { label: "ACC ord", x: col.ao, w: usableW * 0.11 },
        { label: "ACC pl", x: col.ap, w: usableW * 0.11 },
        { label: "FR ord", x: col.fo, w: usableW * 0.11 },
        { label: "FR pl", x: col.fp, w: usableW * 0.13 },
        { label: "Total pl", x: col.tp, w: usableW * 0.22, align: "right" },
      ];
      y = drawTableHeader(doc, ml, y, usableW, delCols, theme);

      if (!plants.length) {
        y = drawEmptyState(doc, ml, y, usableW, "No rows in this section.", theme);
      } else {
        plants.forEach((p, idx) => {
          if (y > pageH - mb - 40) {
            doc.addPage();
            y = mt;
          }
          const b = seg.byPlant[p];
          const totP = (b.accepted?.plantsQty || 0) + (b.farmReady?.plantsQty || 0);
          y = drawTableRow(
            doc,
            ml,
            y,
            usableW,
            22,
            delCols,
            [
              p.slice(0, 36),
              String(b.accepted?.orders ?? 0),
              formatNum(b.accepted?.plantsQty ?? 0),
              String(b.farmReady?.orders ?? 0),
              formatNum(b.farmReady?.plantsQty ?? 0),
              formatNum(totP),
            ],
            idx,
            theme
          );
        });
      }
      y += 16;
    }

    if (paymentSnapshot && paymentSnapshot.totalDue != null) {
      if (y > pageH - mb - 80) {
        doc.addPage();
        y = mt;
      }
      y = drawCalloutBox(
        doc,
        ml,
        y,
        usableW,
        "Payment summary",
        [
          `Billable: ${formatInr(paymentSnapshot.totalDue)} · Collected: ${formatInr(paymentSnapshot.totalCollected)} · Outstanding: ${formatInr(paymentSnapshot.totalOutstanding)}`,
          `PENDING: ${paymentSnapshot.pendingPaymentOrders ?? "—"} · COMPLETED: ${paymentSnapshot.completedPaymentOrders ?? "—"}`,
        ],
        theme
      );
    }

    drawFooter(doc, ml, y + 6, usableW, `Delivery planning · ${reportDateLabel}`, theme);

    doc.end();
  });
}

function deliveryPlantsFromBucket(delivery, key) {
  return delivery?.[key]?.plants || 0;
}

function deliveryTotalPlants(delivery) {
  return delivery?.total?.plants || 0;
}

/**
 * Central MIS delivery PDF — plant/subtype table with in-window + past due columns.
 */
export function generateCentralDeliveryPdf({
  reportDateLabel,
  varietyRows = [],
  varietyTotals = {},
  dueSummary = {},
}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      layout: "landscape",
      margin: 36,
      info: { Title: "Delivery Report", Author: "Nursery Management" },
    });

    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const pageW = doc.page.width;
    const pageH = doc.page.height;
    const ml = doc.page.margins.left;
    const usableW = pageW - ml - doc.page.margins.right;
    const mt = doc.page.margins.top;
    const mb = doc.page.margins.bottom;
    const theme = THEMES.delivery;

    let y = drawHeroBanner(doc, ml, mt, usableW, {
      title: "Delivery Report",
      subtitle: `${reportDateLabel} · Central MIS`,
      theme,
      badge: "MIS",
    });

    const inRange = varietyTotals?.delivery || {};
    const pastDue = varietyTotals?.pastDue || {};
    y = drawKpiCards(
      doc,
      ml,
      y,
      usableW,
      [
        {
          label: "In-window plants",
          value: formatNum(deliveryTotalPlants(inRange)),
          sub: `${inRange.total?.orders || 0} orders`,
        },
        {
          label: "Past due plants",
          value: formatNum(dueSummary?.pastDue?.plants || deliveryTotalPlants(pastDue)),
          sub: `${dueSummary?.pastDue?.orders || pastDue.total?.orders || 0} orders`,
        },
        {
          label: "Combined pipeline",
          value: formatNum(
            deliveryTotalPlants(inRange) +
              (dueSummary?.pastDue?.plants || deliveryTotalPlants(pastDue))
          ),
          sub: "in-window + backlog",
        },
      ],
      theme
    );

    const barSource = [];
    const plantMap = new Map();
    for (const row of varietyRows) {
      const p = row.plantName || "Unknown";
      const inWin = deliveryTotalPlants(row.delivery);
      const past = deliveryTotalPlants(row.pastDue);
      if (inWin + past <= 0) continue;
      plantMap.set(p, (plantMap.get(p) || 0) + inWin + past);
    }
    for (const [label, value] of plantMap) {
      barSource.push({ label, value });
    }
    barSource.sort((a, b) => b.value - a.value);
    const topBars = barSource.slice(0, 8);

    if (topBars.length) {
      y = drawSectionTitle(doc, ml, y, usableW, "Plants by crop (in-window + past due)", theme);
      y = drawHorizontalBars(doc, ml, y, usableW, topBars, theme, pageH, mt, mb + 50);
    }

    y = drawSectionTitle(doc, ml, y, usableW, "Plant → subtype detail", theme);
    y += 4;

    const col = {
      plant: ml,
      sub: ml + usableW * 0.14,
      inWin: ml + usableW * 0.28,
      past: ml + usableW * 0.38,
      acc: ml + usableW * 0.48,
      fr: ml + usableW * 0.56,
      rfd: ml + usableW * 0.64,
      dp: ml + usableW * 0.72,
    };
    const misCols = [
      { label: "Plant", x: col.plant, w: usableW * 0.13 },
      { label: "Subtype", x: col.sub, w: usableW * 0.13 },
      { label: "In-win", x: col.inWin, w: usableW * 0.09 },
      { label: "Past", x: col.past, w: usableW * 0.09 },
      { label: "ACC", x: col.acc, w: usableW * 0.07 },
      { label: "FR", x: col.fr, w: usableW * 0.07 },
      { label: "RFD", x: col.rfd, w: usableW * 0.07 },
      { label: "DP/PC", x: col.dp, w: usableW * 0.1 },
    ];
    y = drawTableHeader(doc, ml, y, usableW, misCols, theme);

    const detailRows = (varietyRows || []).filter(
      (r) =>
        deliveryTotalPlants(r.delivery) > 0 || deliveryTotalPlants(r.pastDue) > 0
    );

    if (!detailRows.length) {
      y = drawEmptyState(doc, ml, y, usableW, "No rows in this period.", theme);
    } else {
      detailRows.forEach((row, idx) => {
        if (y > pageH - mb - 36) {
          doc.addPage();
          y = mt;
        }
        const d = row.delivery || {};
        const dpPc =
          deliveryPlantsFromBucket(d, "dispatchProcess") +
          deliveryPlantsFromBucket(d, "partiallyCompleted");
        y = drawTableRow(
          doc,
          ml,
          y,
          usableW,
          20,
          misCols,
          [
            String(row.plantName || "").slice(0, 18),
            String(row.subtype || "").slice(0, 16),
            formatNum(deliveryTotalPlants(d)),
            formatNum(deliveryTotalPlants(row.pastDue)),
            formatNum(deliveryPlantsFromBucket(d, "accepted")),
            formatNum(deliveryPlantsFromBucket(d, "farmReady")),
            formatNum(deliveryPlantsFromBucket(d, "readyForDispatch")),
            formatNum(dpPc),
          ],
          idx,
          theme
        );
      });
    }

    drawFooter(doc, ml, y + 12, usableW, `Central MIS delivery · ${reportDateLabel}`, theme);
    doc.end();
  });
}

/**
 * Slot availability PDF for WhatsApp wizard.
 */
export function generateAvailabilityPdf({
  reportTitle,
  reportDateLabel,
  summary = {},
  rows = [],
}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      layout: "landscape",
      margin: 36,
      info: { Title: "Availability Report", Author: "Nursery Management" },
    });

    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const pageW = doc.page.width;
    const pageH = doc.page.height;
    const ml = doc.page.margins.left;
    const usableW = pageW - ml - doc.page.margins.right;
    const mt = doc.page.margins.top;
    const mb = doc.page.margins.bottom;
    const theme = THEMES.availability;

    let y = drawHeroBanner(doc, ml, mt, usableW, {
      title: reportTitle || "Availability Report",
      subtitle: reportDateLabel,
      theme,
      badge: "STOCK",
    });

    y = drawKpiCards(
      doc,
      ml,
      y,
      usableW,
      [
        { label: "Active slots", value: formatNum(summary.slotCount || 0) },
        { label: "Available plants", value: formatNum(summary.available || 0) },
        { label: "Total capacity", value: formatNum(summary.totalCapacity || 0) },
      ],
      theme
    );

    y = drawSectionTitle(doc, ml, y, usableW, "Slot availability detail", theme);
    y += 4;

    const col = {
      plant: ml,
      sub: ml + usableW * 0.16,
      window: ml + usableW * 0.28,
      month: ml + usableW * 0.46,
      cap: ml + usableW * 0.56,
      booked: ml + usableW * 0.66,
      avail: ml + usableW * 0.76,
    };
    const availCols = [
      { label: "Plant", x: col.plant, w: usableW * 0.15 },
      { label: "Subtype", x: col.sub, w: usableW * 0.11 },
      { label: "Window", x: col.window, w: usableW * 0.17 },
      { label: "Month", x: col.month, w: usableW * 0.09 },
      { label: "Cap", x: col.cap, w: usableW * 0.09 },
      { label: "Booked", x: col.booked, w: usableW * 0.09 },
      { label: "Available", x: col.avail, w: usableW * 0.13, align: "right" },
    ];
    y = drawTableHeader(doc, ml, y, usableW, availCols, theme);

    const list = rows.slice(0, 60);
    if (!list.length) {
      y = drawEmptyState(doc, ml, y, usableW, "No slots match this filter.", theme);
    } else {
      list.forEach((row, idx) => {
        if (y > pageH - mb - 36) {
          doc.addPage();
          y = mt;
        }
        const availColor = row.availablePlants > 0 ? theme.primaryLight : "#dc2626";
        y = drawTableRow(
          doc,
          ml,
          y,
          usableW,
          20,
          availCols.map((c, i) =>
            i === availCols.length - 1 ? { ...c, bold: true, color: availColor } : c
          ),
          [
            String(row.plantName || "").slice(0, 20),
            String(row.subtypeName || "").slice(0, 14),
            `${row.startDay}–${row.endDay}`,
            String(row.month || "").slice(0, 10),
            formatNum(row.totalPlants),
            formatNum(row.bookedPlants),
            formatNum(row.availablePlants),
          ],
          idx,
          theme
        );
      });
    }

    drawFooter(doc, ml, y + 10, usableW, reportDateLabel, theme);
    doc.end();
  });
}

/**
 * Future slot windows (end ≥ today IST) with booked vs capacity.
 * @param {object} opts
 * @param {string} opts.reportDateLabel
 * @param {{ plantName: string, subtypeName: string, label: string, cap: number, booked: number }[]} opts.slotRows
 * @param {number} [opts.maxDetailRows]
 */
export function generateSlotsOutlookPdf({
  reportDateLabel,
  slotRows = [],
  maxDetailRows = 48,
}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      layout: "landscape",
      margin: 36,
      info: {
        Title: "Slots outlook report",
        Author: "Nursery Management",
      },
    });

    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const pageW = doc.page.width;
    const pageH = doc.page.height;
    const ml = doc.page.margins.left;
    const mr = doc.page.margins.right;
    const mt = doc.page.margins.top;
    const mb = doc.page.margins.bottom;
    const usableW = pageW - ml - mr;
    const theme = THEMES.slots;

    let sumCap = 0;
    let sumBooked = 0;
    for (const r of slotRows) {
      sumCap += Number(r.cap) || 0;
      sumBooked += Number(r.booked) || 0;
    }
    const fillPct = sumCap > 0 ? Math.round((100 * sumBooked) / sumCap) : 0;

    let y = drawHeroBanner(doc, ml, mt, usableW, {
      title: "Slots Outlook Report",
      subtitle: reportDateLabel,
      theme,
      badge: "SLOTS",
    });

    y = drawCalloutBox(
      doc,
      ml,
      y,
      usableW,
      "How to read this report",
      [
        "Only slot windows whose end date is today or later (IST) are included.",
        "Booked = live orders on each slot; Cap = plant capacity.",
        "Table lists busiest individual windows first.",
      ],
      theme
    );

    y = drawKpiCards(
      doc,
      ml,
      y,
      usableW,
      [
        { label: "Future windows", value: formatNum(slotRows.length) },
        { label: "Total capacity", value: formatNum(sumCap) },
        { label: "Total booked", value: formatNum(sumBooked) },
        { label: "Overall fill", value: `${fillPct}%` },
      ],
      theme
    );

    const bars = plantBookedTotalsForBarChart(slotRows, 8);
    if (bars.length) {
      y = drawSectionTitle(doc, ml, y, usableW, "Booked plants by crop", theme);
      y = drawHorizontalBars(doc, ml, y, usableW, bars, theme, pageH, mt, mb + 50);
    }

    const sorted = [...slotRows].sort(
      (a, b) => (Number(b.booked) || 0) - (Number(a.booked) || 0)
    );
    const detail = sorted.slice(0, maxDetailRows);
    const truncated = slotRows.length > maxDetailRows;

    y = drawSectionTitle(
      doc,
      ml,
      y,
      usableW,
      `Busiest slot windows (top ${detail.length}${truncated ? ` of ${slotRows.length}` : ""})`,
      theme
    );
    y += 4;

    const w1 = usableW * 0.2;
    const w2 = usableW * 0.14;
    const w3 = usableW * 0.28;
    const w4 = usableW * 0.12;
    const w5 = usableW * 0.12;
    const w6 = usableW - w1 - w2 - w3 - w4 - w5;
    const c0 = ml;
    const c1 = c0 + w1;
    const c2 = c1 + w2;
    const c3 = c2 + w3;
    const c4 = c3 + w4;
    const c5 = c4 + w5;

    const slotCols = [
      { label: "Plant", x: c0, w: w1 },
      { label: "Subtype", x: c1, w: w2 },
      { label: "Window", x: c2, w: w3 },
      { label: "Booked", x: c3, w: w4, align: "right" },
      { label: "Cap", x: c4, w: w5, align: "right" },
      { label: "Fill %", x: c5, w: w6, align: "right" },
    ];
    y = drawTableHeader(doc, ml, y, usableW, slotCols, theme);

    if (!detail.length) {
      y = drawEmptyState(doc, ml, y, usableW, "No upcoming slot windows found.", theme);
    } else {
      detail.forEach((r, idx) => {
        if (y > pageH - mb - 36) {
          doc.addPage();
          y = mt;
        }
        const cap = Number(r.cap) || 0;
        const bk = Number(r.booked) || 0;
        const pct = cap > 0 ? Math.round((100 * bk) / cap) : 0;
        y = drawTableRow(
          doc,
          ml,
          y,
          usableW,
          20,
          slotCols,
          [
            String(r.plantName || "—").slice(0, 28),
            String(r.subtypeName || "—").slice(0, 22),
            String(r.label || "—").slice(0, 42),
            formatNum(bk),
            formatNum(cap),
            `${pct}%`,
          ],
          idx,
          theme
        );
      });
    }

    if (truncated) {
      y += 6;
      doc.font("Helvetica-Oblique").fontSize(8).fillColor(COLORS.muted);
      doc.text(
        `…and ${slotRows.length - maxDetailRows} more windows not shown.`,
        ml,
        y,
        { width: usableW }
      );
      y += 14;
    }

    drawFooter(doc, ml, y + 8, usableW, `PlantSlot future windows · ${reportDateLabel}`, theme);

    doc.end();
  });
}

/**
 * Overall order transition insight report.
 * @param {object} opts
 * @param {string} opts.reportDateLabel
 * @param {number} opts.bookedOrders
 * @param {{ acceptedToDispatched: number, dispatchedToCompleted: number, farmReadyToDispatch: number, acceptedToFarmReady: number }} opts.todayKey
 * @param {{ _id: string, count: number }[]} opts.currentStatuses
 * @param {{ _id: { from: string, to: string }, count: number }[]} opts.transitionMatrix
 */
export function generateOrderTransitionInsightsPdf({
  reportDateLabel,
  bookedOrders = 0,
  todayKey = {},
  currentStatuses = [],
  transitionMatrix = [],
}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      layout: "landscape",
      margin: 36,
      info: {
        Title: "Order transition insights",
        Author: "Nursery Management",
      },
    });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const pageW = doc.page.width;
    const pageH = doc.page.height;
    const ml = doc.page.margins.left;
    const mr = doc.page.margins.right;
    const mt = doc.page.margins.top;
    const mb = doc.page.margins.bottom;
    const usableW = pageW - ml - mr;
    const theme = THEMES.insight;

    let y = drawHeroBanner(doc, ml, mt, usableW, {
      title: "Order Status Insights",
      subtitle: reportDateLabel,
      theme,
      badge: "INSIGHTS",
    });

    y = drawKpiCards(
      doc,
      ml,
      y,
      usableW,
      [
        { label: "Booked orders", value: formatNum(bookedOrders) },
        { label: "Today ACC→DISP", value: formatNum(todayKey.acceptedToDispatched || 0) },
        { label: "Today DISP→COMP", value: formatNum(todayKey.dispatchedToCompleted || 0) },
        { label: "Today FR→DISP", value: formatNum(todayKey.farmReadyToDispatch || 0) },
        { label: "Today ACC→FR", value: formatNum(todayKey.acceptedToFarmReady || 0) },
      ],
      theme
    );

    y = drawSectionTitle(doc, ml, y, usableW, "Current status mix (booked in period)", theme);
    doc.font("Helvetica").fontSize(9).fillColor(COLORS.text);
    for (const row of currentStatuses.slice(0, 10)) {
      doc.fillColor(theme.primary).font("Helvetica-Bold").text("•", ml, y, { continued: true });
      doc.fillColor(COLORS.text).font("Helvetica").text(` ${row._id}: ${formatNum(row.count)}`, { width: usableW });
      y += 12;
    }
    if (!currentStatuses.length) {
      doc.text("— no booked orders in selected period.", ml, y, { width: usableW });
      y += 12;
    }
    y += 8;

    y = drawSectionTitle(doc, ml, y, usableW, "Top status transitions", theme);
    y += 4;

    const c1 = ml;
    const c3 = ml + usableW * 0.78;
    const transCols = [
      { label: "Transition", x: c1, w: usableW * 0.72 },
      { label: "Count", x: c3, w: usableW * 0.22, align: "right" },
    ];
    y = drawTableHeader(doc, ml, y, usableW, transCols, theme);

    const top = transitionMatrix.slice(0, 16);
    if (!top.length) {
      y = drawEmptyState(doc, ml, y, usableW, "No status transitions in selected period.", theme);
    } else {
      top.forEach((r, i) => {
        y = drawTableRow(
          doc,
          ml,
          y,
          usableW,
          20,
          transCols,
          [`${r._id?.from || "—"} → ${r._id?.to || "—"}`, formatNum(r.count || 0)],
          i,
          theme
        );
      });
    }

    drawFooter(doc, ml, y + 12, usableW, reportDateLabel, theme);

    doc.end();
  });
}

const STATUS_SHORT = {
  ACCEPTED: "ACC",
  FARM_READY: "FR",
  READY_FOR_DISPATCH: "RFD",
  DISPATCH_PROCESS: "DP",
  PARTIALLY_COMPLETED: "PC",
  DISPATCHED: "DISP",
  COMPLETED: "COMP",
};

/**
 * Full delivery order list (line-level) — landscape table, paginated.
 * @param {object} opts
 * @param {string} opts.reportDateLabel
 * @param {{ orderId: any, farmerName: string, mobile: string, village: string, plant: string, subtype: string, quantity: number, status: string, deliveryDate: string }[]} opts.rows
 * @param {{ orders: number, plants: number, byStatus: Record<string, { orders: number, plants: number }> }} opts.totals
 */
export function generateDeliveryOrdersListPdf({ reportDateLabel, rows = [], totals = {} }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      layout: "landscape",
      margin: 36,
      info: { Title: "Delivery orders list", Author: "Nursery Management" },
    });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const pageW = doc.page.width;
    const pageH = doc.page.height;
    const ml = doc.page.margins.left;
    const mr = doc.page.margins.right;
    const mt = doc.page.margins.top;
    const mb = doc.page.margins.bottom;
    const usableW = pageW - ml - mr;
    const theme = THEMES.delivery;

    let y = drawHeroBanner(doc, ml, mt, usableW, {
      title: "Delivery Orders — Full List",
      subtitle: reportDateLabel,
      theme,
      badge: "ORDERS",
    });

    y = drawKpiCards(
      doc,
      ml,
      y,
      usableW,
      [
        { label: "Total orders", value: formatNum(totals.orders || 0) },
        { label: "Total plants", value: formatNum(totals.plants || 0) },
        {
          label: "Statuses",
          value: String(Object.keys(totals.byStatus || {}).length || 0),
          sub: "distinct order states",
        },
      ],
      theme
    );

    const statusLines = Object.entries(totals.byStatus || {})
      .sort((a, b) => (b[1].plants || 0) - (a[1].plants || 0))
      .map(([s, v]) => `${s}: ${v.orders} ord / ${formatNum(v.plants)} pl`);
    if (statusLines.length) {
      y = drawCalloutBox(
        doc,
        ml,
        y,
        usableW,
        "Status breakdown (delivery date in window)",
        [statusLines.join("  ·  ")],
        theme
      );
    }

    y = drawSectionTitle(doc, ml, y, usableW, "Order list", theme);
    y += 2;

    const col = {
      idx: ml,
      oid: ml + usableW * 0.05,
      farmer: ml + usableW * 0.13,
      village: ml + usableW * 0.33,
      plant: ml + usableW * 0.49,
      sub: ml + usableW * 0.63,
      qty: ml + usableW * 0.77,
      status: ml + usableW * 0.85,
      del: ml + usableW * 0.93,
    };
    const cols = [
      { label: "#", x: col.idx, w: usableW * 0.05 },
      { label: "Order", x: col.oid, w: usableW * 0.08 },
      { label: "Farmer", x: col.farmer, w: usableW * 0.2 },
      { label: "Village", x: col.village, w: usableW * 0.16 },
      { label: "Plant", x: col.plant, w: usableW * 0.14 },
      { label: "Subtype", x: col.sub, w: usableW * 0.14 },
      { label: "Qty", x: col.qty, w: usableW * 0.08, align: "right" },
      { label: "Status", x: col.status, w: usableW * 0.08 },
      { label: "Delivery", x: col.del, w: usableW * 0.07 },
    ];

    y = drawTableHeader(doc, ml, y, usableW, cols, theme);

    if (!rows.length) {
      y = drawEmptyState(doc, ml, y, usableW, "No delivery orders in this window.", theme);
    } else {
      rows.forEach((r, i) => {
        if (y > pageH - mb - 30) {
          doc.addPage();
          y = mt;
          y = drawTableHeader(doc, ml, y, usableW, cols, theme);
        }
        y = drawTableRow(
          doc,
          ml,
          y,
          usableW,
          18,
          cols,
          [
            String(i + 1),
            String(r.orderId ?? "—"),
            String(r.farmerName || "—").slice(0, 26),
            String(r.village || "—").slice(0, 22),
            String(r.plant || "—").slice(0, 18),
            String(r.subtype || "—").slice(0, 18),
            formatNum(r.quantity || 0),
            STATUS_SHORT[r.status] || r.status || "—",
            r.deliveryDate || "—",
          ],
          i,
          theme
        );
      });
      y = drawGrandTotalBar(doc, ml, y + 4, usableW, "Total plants", totals.plants || 0, theme);
    }

    drawFooter(doc, ml, y + 8, usableW, `Delivery orders · ${reportDateLabel}`, theme);
    doc.end();
  });
}
