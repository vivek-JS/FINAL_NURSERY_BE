import PDFDocument from "pdfkit";
import { formatPlantCell } from "./reportService.js";

const COLORS = {
  headerBar: "#1b4332",
  headerText: "#ffffff",
  accent: "#2d6a4f",
  muted: "#6c757d",
  border: "#95d5b2",
  rowAlt: "#f8f9fa",
  kpiBg: "#d8f3dc",
  kpiBorder: "#40916c",
};

function formatInr(n) {
  const x = Math.round(Number(n) || 0);
  return `₹${x.toLocaleString("en-IN")}`;
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
    const usableW = pageW - ml - mr;

    let y = mt;

    // --- Top banner ---
    doc.save();
    doc.rect(ml, y, usableW, 52).fill(COLORS.headerBar);
    doc.fillColor(COLORS.headerText).font("Helvetica-Bold").fontSize(20);
    doc.text(bannerTitle, ml + 16, y + 10, {
      width: usableW - 32,
      align: "center",
    });
    doc.font("Helvetica").fontSize(11).opacity(0.95);
    doc.text(reportDateLabel, ml + 16, y + 32, {
      width: usableW - 32,
      align: "center",
    });
    doc.opacity(1).restore();
    y += 62;

    // --- KPI figures ---
    const kpiH = 58;
    const gap = 12;
    const kpiW = (usableW - gap * 2) / 3;
    const kpis = [
      {
        label: "Total quantity (plants)",
        value: String(stats.grandTotal),
      },
      {
        label: "Booking lines",
        value: String(stats.bookingLines),
      },
      {
        label: "Farmers (named)",
        value: String(stats.uniqueFarmers),
      },
    ];
    let kx = ml;
    for (let i = 0; i < kpis.length; i++) {
      doc.save();
      doc.rect(kx, y, kpiW, kpiH).fillAndStroke(COLORS.kpiBg, COLORS.kpiBorder);
      doc.fillColor(COLORS.accent).font("Helvetica-Bold").fontSize(22);
      doc.text(kpis[i].value, kx + 8, y + 10, {
        width: kpiW - 16,
        align: "center",
      });
      doc.fillColor(COLORS.muted).font("Helvetica").fontSize(9);
      doc.text(kpis[i].label, kx + 8, y + 38, {
        width: kpiW - 16,
        align: "center",
      });
      doc.restore();
      kx += kpiW + gap;
    }
    y += kpiH + 18;

    const bars =
      plantBarChart && plantBarChart.length
        ? plantBarChart
        : plantTotalsForBarChart(summaryRows, 6);
    if (bars.length) {
      const maxV = Math.max(...bars.map((x) => x.value), 1);
      doc.font("Helvetica-Bold").fontSize(11).fillColor(COLORS.accent);
      doc.text("Plant booking volume (horizontal bars)", ml, y);
      y += 14;
      const rowH = 18;
      const labelW = usableW * 0.34;
      const barMax = usableW * 0.48;
      bars.forEach((row) => {
        if (y > pageH - doc.page.margins.bottom - 50) {
          doc.addPage();
          y = mt;
        }
        const frac = row.value / maxV;
        doc.font("Helvetica").fontSize(8).fillColor("#212529");
        doc.text(String(row.label).slice(0, 34), ml, y + 4, {
          width: labelW - 6,
        });
        doc.save();
        doc
          .rect(ml + labelW, y + 2, Math.max(4, barMax * frac), rowH - 6)
          .fillAndStroke("#d8f3dc", COLORS.kpiBorder);
        doc.restore();
        doc
          .font("Helvetica-Bold")
          .fontSize(9)
          .fillColor(COLORS.accent)
          .text(String(row.value), ml + labelW + barMax + 6, y + 4, {
            width: 80,
            align: "right",
          });
        y += rowH;
      });
      y += 12;
    }

    if (topFarmers && topFarmers.length) {
      if (y > pageH - doc.page.margins.bottom - 120) {
        doc.addPage();
        y = mt;
      }
      doc.font("Helvetica-Bold").fontSize(11).fillColor(COLORS.accent);
      doc.text("Top farmers (by plant quantity)", ml, y);
      y += 14;
      doc.font("Helvetica").fontSize(9).fillColor("#212529");
      topFarmers.forEach((f, i) => {
        doc.text(
          `${i + 1}. ${f.name} — ${f.quantity} plants`,
          ml,
          y,
          { width: usableW }
        );
        y += 13;
      });
      y += 8;
    }

    if (topVillages && topVillages.length) {
      if (y > pageH - doc.page.margins.bottom - 100) {
        doc.addPage();
        y = mt;
      }
      doc.font("Helvetica-Bold").fontSize(11).fillColor(COLORS.accent);
      doc.text("Top villages / areas (by quantity)", ml, y);
      y += 14;
      doc.font("Helvetica").fontSize(9).fillColor("#212529");
      topVillages.forEach((v, i) => {
        doc.text(
          `${i + 1}. ${v.name} — ${v.quantity} plants`,
          ml,
          y,
          { width: usableW }
        );
        y += 13;
      });
      y += 8;
    }

    if (paymentSnapshot && paymentSnapshot.totalDue != null) {
      if (y > pageH - doc.page.margins.bottom - 80) {
        doc.addPage();
        y = mt;
      }
      doc.font("Helvetica-Bold").fontSize(11).fillColor(COLORS.accent);
      doc.text("Payment summary (same order set)", ml, y);
      y += 14;
      doc.font("Helvetica").fontSize(9).fillColor("#212529");
      doc.text(
        `Billable: ${formatInr(paymentSnapshot.totalDue)} | Collected: ${formatInr(
          paymentSnapshot.totalCollected
        )} | Outstanding: ${formatInr(paymentSnapshot.totalOutstanding)}`,
        ml,
        y,
        { width: usableW }
      );
      y += 12;
      doc.text(
        `Order flags — PENDING: ${paymentSnapshot.pendingPaymentOrders ?? "—"} | COMPLETED: ${paymentSnapshot.completedPaymentOrders ?? "—"}`,
        ml,
        y,
        { width: usableW }
      );
      y += 18;
    }

    doc.fillColor("#212529").font("Helvetica-Bold").fontSize(11);
    doc.text("Detail — Farmer · Plant · Subtype · Quantity", ml, y);
    y += 16;

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
    doc.save();
    doc.rect(ml, y, usableW, headerH).fill(COLORS.accent);
    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(9);
    doc.text("Sr", col.sr + 4, y + 7, { width: widths.sr - 8 });
    doc.text("Farmer name", col.farmer, y + 7, { width: widths.farmer - 4 });
    doc.text("Plant (type)", col.plant, y + 7, { width: widths.plant - 4 });
    doc.text("Subtype (variety)", col.subtype, y + 7, {
      width: widths.subtype - 4,
    });
    doc.text("Qty", col.qty, y + 7, {
      width: widths.qty - 8,
      align: "right",
    });
    doc.restore();
    y += headerH;

    doc.font("Helvetica").fontSize(9).fillColor("#212529");

    if (!lineRows.length) {
      doc.rect(ml, y, usableW, 28).fill("#fff3cd").stroke(COLORS.border);
      doc.fillColor("#856404").text("No bookings recorded for today (IST).", ml + 10, y + 8, {
        width: usableW - 20,
      });
      y += 36;
    } else {
      lineRows.forEach((row, idx) => {
        if (y > pageH - doc.page.margins.bottom - 120) {
          doc.addPage();
          y = mt;
        }
        const rowH = 26;
        if (idx % 2 === 0) {
          doc.save();
          doc.rect(ml, y, usableW, rowH).fill(COLORS.rowAlt);
          doc.restore();
        }
        const plantDisplay = formatPlantCell(row.plantName, row.plantType);
        doc.fillColor("#212529");
        doc.text(String(idx + 1), col.sr + 4, y + 7, { width: widths.sr - 8 });
        doc.text(row.farmerName, col.farmer, y + 7, {
          width: widths.farmer,
        });
        doc.text(plantDisplay, col.plant, y + 7, {
          width: widths.plant,
        });
        doc.text(row.subtype, col.subtype, y + 7, {
          width: widths.subtype,
        });
        doc.font("Helvetica-Bold").text(String(row.quantity), col.qty, y + 7, {
          width: widths.qty - 8,
          align: "right",
        });
        doc.font("Helvetica");
        y += rowH;
      });
    }

    y += 14;
    doc.moveTo(ml, y).lineTo(ml + usableW, y).strokeColor(COLORS.border).lineWidth(1).stroke();
    y += 12;

    // --- Summary by plant / subtype ---
    doc.font("Helvetica-Bold").fontSize(11).fillColor(COLORS.accent);
    doc.text("Summary — Plant × Subtype (today’s totals)", ml, y);
    y += 16;

    const sCol = { plant: ml, subtype: ml + 280, qty: ml + 560 };
    const sW = { plant: 268, subtype: 268, qty: usableW - (560 - ml) };

    doc.save();
    doc.rect(ml, y, usableW, 22).fill("#e9ecef");
    doc.fillColor("#212529").font("Helvetica-Bold").fontSize(9);
    doc.text("Plant", sCol.plant + 6, y + 6, { width: sW.plant - 12 });
    doc.text("Subtype", sCol.subtype + 6, y + 6, { width: sW.subtype - 12 });
    doc.text("Total qty", sCol.qty + 6, y + 6, {
      width: sW.qty - 12,
      align: "right",
    });
    doc.restore();
    y += 22;

    doc.font("Helvetica").fontSize(9);
    if (!summaryRows.length) {
      doc.text("—", ml + 6, y + 4);
      y += 22;
    } else {
      summaryRows.forEach((r, i) => {
        if (y > pageH - doc.page.margins.bottom - 60) {
          doc.addPage();
          y = mt;
        }
        if (i % 2 === 1) {
          doc.save();
          doc.rect(ml, y, usableW, 20).fill("#f8f9fa");
          doc.restore();
        }
        doc.fillColor("#212529");
        doc.text(r.plant, sCol.plant + 6, y + 5, { width: sW.plant - 12 });
        doc.text(r.subtype, sCol.subtype + 6, y + 5, { width: sW.subtype - 12 });
        doc.font("Helvetica-Bold").text(String(r.quantity), sCol.qty + 6, y + 5, {
          width: sW.qty - 12,
          align: "right",
        });
        doc.font("Helvetica");
        y += 20;
      });
    }

    y += 10;
    doc.save();
    doc.rect(ml, y, usableW, 30).fill(COLORS.headerBar);
    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(11);
    doc.text("Grand total (quantity)", ml + 12, y + 9, { width: usableW - 120 });
    doc.text(String(stats.grandTotal), ml, y + 9, {
      width: usableW - 16,
      align: "right",
    });
    doc.restore();

    y += 44;
    doc.fillColor(COLORS.muted).font("Helvetica").fontSize(8);
    doc.text(
      `Generated ${new Date().toISOString()} · ${dataSourceLabel} · ${reportDateLabel}`,
      ml,
      y,
      { width: usableW, align: "center" }
    );

    doc.end();
  });
}

/**
 * Delivery queue: ACCEPTED + FARM_READY live snapshot (not filtered by booking dates).
 * @param {object} opts
 * @param {string} opts.reportDateLabel - Usually session / “generated at” IST label
 * @param {Record<string, { accepted: { orders: number, plantsQty: number }, farmReady: { orders: number, plantsQty: number } }>} opts.byPlant
 * @param {{ acceptedOrders: number, farmReadyOrders: number, acceptedPlants: number, farmReadyPlants: number }} opts.totals
 * @param {null | { totalDue?: number, totalCollected?: number, totalOutstanding?: number, pendingPaymentOrders?: number, completedPaymentOrders?: number }} [opts.paymentSnapshot]
 */
export function generateDeliveryQueuePdf({
  reportDateLabel,
  byPlant = {},
  totals,
  paymentSnapshot = null,
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
    const usableW = pageW - ml - mr;
    let y = mt;

    const totalOrders = totals.acceptedOrders + totals.farmReadyOrders;
    const totalPlants = totals.acceptedPlants + totals.farmReadyPlants;

    const EXPLAIN = [
      "ACCEPTED = order approved but plants not yet marked ready at the farm.",
      "FARM_READY = stock is ready; these lines are usually next in line for dispatch.",
      "This list is a live snapshot: it is not cut by the date range you picked in the wizard (the range only anchors the report session).",
    ];

    doc.save();
    doc.rect(ml, y, usableW, 52).fill(COLORS.headerBar);
    doc.fillColor(COLORS.headerText).font("Helvetica-Bold").fontSize(20);
    doc.text("Delivery queue report", ml + 16, y + 8, {
      width: usableW - 32,
      align: "center",
    });
    doc.font("Helvetica").fontSize(10).opacity(0.95);
    doc.text(reportDateLabel, ml + 16, y + 32, {
      width: usableW - 32,
      align: "center",
    });
    doc.opacity(1).restore();
    y += 60;

    doc.save();
    doc.rect(ml, y, usableW, 44).fill("#e7f1ff").stroke(COLORS.kpiBorder);
    doc.fillColor("#1a1a2e").font("Helvetica-Bold").fontSize(10);
    doc.text("How to read this report", ml + 10, y + 6, { width: usableW - 20 });
    doc.font("Helvetica").fontSize(8.5).fillColor("#333");
    let ey = y + 22;
    for (const line of EXPLAIN) {
      doc.text(`• ${line}`, ml + 10, ey, { width: usableW - 20 });
      ey += 12;
    }
    doc.restore();
    y += 50;

    const gap = 10;
    const kpiW = (usableW - gap) / 2;
    const kpiH = 50;
    const kpiRow = [
      {
        label: "Total orders in queue",
        value: String(totalOrders),
        sub: "ACCEPTED + FARM_READY",
      },
      {
        label: "Total plants in queue",
        value: String(totalPlants),
        sub: "sum of plant quantities",
      },
    ];
    const kpiRow2 = [
      {
        label: "ACCEPTED",
        value: `${totals.acceptedOrders} ord`,
        sub: `${totals.acceptedPlants} plants`,
      },
      {
        label: "FARM_READY",
        value: `${totals.farmReadyOrders} ord`,
        sub: `${totals.farmReadyPlants} plants`,
      },
    ];

    const drawKpi2 = (row) => {
      let kx = ml;
      for (let i = 0; i < row.length; i++) {
        doc.save();
        doc.rect(kx, y, kpiW, kpiH).fillAndStroke(COLORS.kpiBg, COLORS.kpiBorder);
        doc.fillColor(COLORS.accent).font("Helvetica-Bold").fontSize(20);
        doc.text(row[i].value, kx + 8, y + 8, {
          width: kpiW - 16,
          align: "center",
        });
        doc.fillColor(COLORS.muted).font("Helvetica").fontSize(8);
        doc.text(row[i].label, kx + 8, y + 32, {
          width: kpiW - 16,
          align: "center",
        });
        if (row[i].sub) {
          doc.text(row[i].sub, kx + 8, y + 40, {
            width: kpiW - 16,
            align: "center",
          });
        }
        doc.restore();
        kx += kpiW + gap;
      }
    };
    drawKpi2(kpiRow);
    y += kpiH + 8;
    drawKpi2(kpiRow2);
    y += kpiH + 16;

    const barSource = Object.keys(byPlant)
      .sort((a, b) => a.localeCompare(b))
      .map((name) => {
        const b = byPlant[name];
        const q =
          (b.accepted?.plantsQty || 0) + (b.farmReady?.plantsQty || 0);
        return { label: name, value: q };
      })
      .filter((x) => x.value > 0)
      .sort((a, b) => b.value - a.value)
      .slice(0, 8);

    const maxV = Math.max(...barSource.map((x) => x.value), 1);
    if (barSource.length) {
      doc.font("Helvetica-Bold").fontSize(11).fillColor(COLORS.accent);
      doc.text("Plants in delivery queue by crop (horizontal bars)", ml, y);
      y += 14;
      const rowH = 18;
      const labelW = usableW * 0.32;
      const barMax = usableW * 0.5;
      barSource.forEach((row) => {
        if (y > pageH - doc.page.margins.bottom - 50) {
          doc.addPage();
          y = mt;
        }
        const frac = row.value / maxV;
        doc.font("Helvetica").fontSize(8).fillColor("#212529");
        doc.text(String(row.label).slice(0, 40), ml, y + 4, {
          width: labelW - 6,
        });
        doc.save();
        doc
          .rect(ml + labelW, y + 2, Math.max(4, barMax * frac), rowH - 6)
          .fillAndStroke("#d8f3dc", COLORS.kpiBorder);
        doc.restore();
        doc
          .font("Helvetica-Bold")
          .fontSize(9)
          .fillColor(COLORS.accent)
          .text(String(row.value), ml + labelW + barMax + 6, y + 4, {
            width: 80,
            align: "right",
          });
        y += rowH;
      });
      y += 12;
    }

    if (paymentSnapshot && paymentSnapshot.totalDue != null) {
      if (y > pageH - doc.page.margins.bottom - 80) {
        doc.addPage();
        y = mt;
      }
      doc.font("Helvetica-Bold").fontSize(11).fillColor(COLORS.accent);
      doc.text("Payment summary (only orders in ACCEPTED + FARM_READY)", ml, y);
      y += 14;
      doc.font("Helvetica").fontSize(9).fillColor("#212529");
      doc.text(
        `Billable: ${formatInr(paymentSnapshot.totalDue)} | Collected: ${formatInr(
          paymentSnapshot.totalCollected
        )} | Outstanding: ${formatInr(paymentSnapshot.totalOutstanding)}`,
        ml,
        y,
        { width: usableW }
      );
      y += 12;
      doc.text(
        `Order payment flags — PENDING: ${paymentSnapshot.pendingPaymentOrders ?? "—"} | COMPLETED: ${paymentSnapshot.completedPaymentOrders ?? "—"}`,
        ml,
        y,
        { width: usableW }
      );
      y += 18;
    }

    doc.fillColor("#212529").font("Helvetica-Bold").fontSize(11);
    doc.text("Detail — by plant (queue breakdown)", ml, y);
    y += 14;

    const plants = Object.keys(byPlant).sort((a, b) => a.localeCompare(b));
    const col = {
      plant: ml,
      ao: ml + usableW * 0.22,
      ap: ml + usableW * 0.34,
      fo: ml + usableW * 0.46,
      fp: ml + usableW * 0.58,
      tp: ml + usableW * 0.72,
    };
    const headerH = 22;
    doc.save();
    doc.rect(ml, y, usableW, headerH).fill(COLORS.accent);
    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(8);
    doc.text("Plant", col.plant + 4, y + 7, { width: usableW * 0.18 });
    doc.text("ACC orders", col.ao, y + 7, { width: usableW * 0.11 });
    doc.text("ACC plants", col.ap, y + 7, { width: usableW * 0.11 });
    doc.text("FR orders", col.fo, y + 7, { width: usableW * 0.11 });
    doc.text("FR plants", col.fp, y + 7, { width: usableW * 0.13 });
    doc.text("Total plants", col.tp, y + 7, {
      width: usableW * 0.2,
      align: "right",
    });
    doc.restore();
    y += headerH;

    doc.font("Helvetica").fontSize(8.5).fillColor("#212529");
    if (!plants.length) {
      doc.rect(ml, y, usableW, 28).fill("#fff3cd").stroke(COLORS.border);
      doc.fillColor("#856404").text("No orders in ACCEPTED or FARM_READY right now.", ml + 8, y + 8, {
        width: usableW - 16,
      });
      y += 36;
    } else {
      plants.forEach((p, idx) => {
        if (y > pageH - doc.page.margins.bottom - 40) {
          doc.addPage();
          y = mt;
        }
        const b = byPlant[p];
        const rowH = 22;
        if (idx % 2 === 0) {
          doc.save();
          doc.rect(ml, y, usableW, rowH).fill(COLORS.rowAlt);
          doc.restore();
        }
        const totP =
          (b.accepted?.plantsQty || 0) + (b.farmReady?.plantsQty || 0);
        doc.fillColor("#212529");
        doc.text(p.slice(0, 36), col.plant + 4, y + 5, { width: usableW * 0.18 });
        doc.text(String(b.accepted?.orders ?? 0), col.ao, y + 5, {
          width: usableW * 0.11,
        });
        doc.text(String(b.accepted?.plantsQty ?? 0), col.ap, y + 5, {
          width: usableW * 0.11,
        });
        doc.text(String(b.farmReady?.orders ?? 0), col.fo, y + 5, {
          width: usableW * 0.11,
        });
        doc.text(String(b.farmReady?.plantsQty ?? 0), col.fp, y + 5, {
          width: usableW * 0.11,
        });
        doc.font("Helvetica-Bold").text(String(totP), col.tp, y + 5, {
          width: usableW * 0.22,
          align: "right",
        });
        doc.font("Helvetica");
        y += rowH;
      });
    }

    y += 14;
    doc.fillColor(COLORS.muted).font("Helvetica").fontSize(8);
    doc.text(
      `Generated ${new Date().toISOString()} · Live queue · ${reportDateLabel}`,
      ml,
      y,
      { width: usableW, align: "center" }
    );

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
    const usableW = pageW - ml - mr;
    let y = mt;

    const EXPLAIN = [
      "Only slot windows whose end date is today or later (Indian Standard Time) are included.",
      "“Booked” is calculated from live orders tied to each slot; “Cap” is the slot’s plant capacity.",
      "Bars below show total booked plants per crop (summed across all future windows). The table lists the busiest individual windows first.",
    ];

    let sumCap = 0;
    let sumBooked = 0;
    for (const r of slotRows) {
      sumCap += Number(r.cap) || 0;
      sumBooked += Number(r.booked) || 0;
    }
    const fillPct =
      sumCap > 0 ? Math.round((100 * sumBooked) / sumCap) : 0;

    doc.save();
    doc.rect(ml, y, usableW, 52).fill("#1d3557");
    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(20);
    doc.text("Slots outlook report", ml + 16, y + 8, {
      width: usableW - 32,
      align: "center",
    });
    doc.font("Helvetica").fontSize(10).opacity(0.95);
    doc.text(reportDateLabel, ml + 16, y + 32, {
      width: usableW - 32,
      align: "center",
    });
    doc.opacity(1).restore();
    y += 60;

    doc.save();
    doc.rect(ml, y, usableW, 44).fill("#e8f4f8").stroke("#457b9d");
    doc.fillColor("#1d3557").font("Helvetica-Bold").fontSize(10);
    doc.text("How to read this report", ml + 10, y + 6, { width: usableW - 20 });
    doc.font("Helvetica").fontSize(8.5).fillColor("#333");
    let ey = y + 22;
    for (const line of EXPLAIN) {
      doc.text(`• ${line}`, ml + 10, ey, { width: usableW - 20 });
      ey += 12;
    }
    doc.restore();
    y += 50;

    const gap = 10;
    const kpiW = (usableW - 3 * gap) / 4;
    const kpiH = 52;
    const kpis = [
      { label: "Future slot windows", value: String(slotRows.length) },
      { label: "Σ capacity (plants)", value: String(sumCap) },
      { label: "Σ booked (plants)", value: String(sumBooked) },
      { label: "Overall fill", value: `${fillPct}%` },
    ];
    let kx = ml;
    for (let i = 0; i < kpis.length; i++) {
      doc.save();
      doc.rect(kx, y, kpiW, kpiH).fillAndStroke("#f1faee", "#457b9d");
      doc.fillColor("#1d3557").font("Helvetica-Bold").fontSize(18);
      doc.text(kpis[i].value, kx + 6, y + 10, {
        width: kpiW - 12,
        align: "center",
      });
      doc.fillColor(COLORS.muted).font("Helvetica").fontSize(8);
      doc.text(kpis[i].label, kx + 6, y + 34, {
        width: kpiW - 12,
        align: "center",
      });
      doc.restore();
      kx += kpiW + gap;
    }
    y += kpiH + 16;

    const bars = plantBookedTotalsForBarChart(slotRows, 8);
    const maxV = Math.max(...bars.map((x) => x.value), 1);
    if (bars.length) {
      doc.font("Helvetica-Bold").fontSize(11).fillColor("#1d3557");
      doc.text("Booked plants by crop (all future windows combined)", ml, y);
      y += 14;
      const rowH = 18;
      const labelW = usableW * 0.32;
      const barMax = usableW * 0.5;
      bars.forEach((row) => {
        if (y > pageH - doc.page.margins.bottom - 50) {
          doc.addPage();
          y = mt;
        }
        const frac = row.value / maxV;
        doc.font("Helvetica").fontSize(8).fillColor("#212529");
        doc.text(String(row.label).slice(0, 40), ml, y + 4, {
          width: labelW - 6,
        });
        doc.save();
        doc
          .rect(ml + labelW, y + 2, Math.max(4, barMax * frac), rowH - 6)
          .fillAndStroke("#a8dadc", "#457b9d");
        doc.restore();
        doc
          .font("Helvetica-Bold")
          .fontSize(9)
          .fillColor("#1d3557")
          .text(String(row.value), ml + labelW + barMax + 6, y + 4, {
            width: 80,
            align: "right",
          });
        y += rowH;
      });
      y += 12;
    }

    const sorted = [...slotRows].sort(
      (a, b) => (Number(b.booked) || 0) - (Number(a.booked) || 0)
    );
    const detail = sorted.slice(0, maxDetailRows);
    const truncated = slotRows.length > maxDetailRows;

    doc.font("Helvetica-Bold").fontSize(11).fillColor("#1d3557");
    doc.text(
      `Busiest slot windows (top ${detail.length}${truncated ? ` of ${slotRows.length}` : ""})`,
      ml,
      y
    );
    y += 14;

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

    const hh = 22;
    doc.save();
    doc.rect(ml, y, usableW, hh).fill("#457b9d");
    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(7.5);
    doc.text("Plant", c0 + 3, y + 7, { width: w1 - 6 });
    doc.text("Subtype", c1 + 3, y + 7, { width: w2 - 6 });
    doc.text("Window", c2 + 3, y + 7, { width: w3 - 6 });
    doc.text("Booked", c3 + 3, y + 7, { width: w4 - 6, align: "right" });
    doc.text("Cap", c4 + 3, y + 7, { width: w5 - 6, align: "right" });
    doc.text("Fill %", c5 + 3, y + 7, { width: w6 - 6, align: "right" });
    doc.restore();
    y += hh;

    doc.font("Helvetica").fontSize(7.5).fillColor("#212529");
    if (!detail.length) {
      doc.rect(ml, y, usableW, 28).fill("#fff3cd").stroke("#457b9d");
      doc.fillColor("#856404").text("No upcoming slot windows in configured PlantSlot data.", ml + 8, y + 8, {
        width: usableW - 16,
      });
      y += 36;
    } else {
      detail.forEach((r, idx) => {
        if (y > pageH - doc.page.margins.bottom - 36) {
          doc.addPage();
          y = mt;
        }
        const rowH = 20;
        if (idx % 2 === 0) {
          doc.save();
          doc.rect(ml, y, usableW, rowH).fill("#f8f9fa");
          doc.restore();
        }
        const cap = Number(r.cap) || 0;
        const bk = Number(r.booked) || 0;
        const pct = cap > 0 ? Math.round((100 * bk) / cap) : 0;
        doc.fillColor("#212529");
        doc.text(String(r.plantName || "—").slice(0, 28), c0 + 3, y + 5, {
          width: w1 - 6,
        });
        doc.text(String(r.subtypeName || "—").slice(0, 22), c1 + 3, y + 5, {
          width: w2 - 6,
        });
        doc.text(String(r.label || "—").slice(0, 42), c2 + 3, y + 5, {
          width: w3 - 6,
        });
        doc.text(String(bk), c3 + 3, y + 5, {
          width: w4 - 6,
          align: "right",
        });
        doc.text(String(cap), c4 + 3, y + 5, {
          width: w5 - 6,
          align: "right",
        });
        doc.font("Helvetica-Bold").text(String(pct), c5 + 3, y + 5, {
          width: w6 - 6,
          align: "right",
        });
        doc.font("Helvetica");
        y += rowH;
      });
    }

    if (truncated) {
      y += 6;
      doc.font("Helvetica-Oblique").fontSize(8).fillColor(COLORS.muted);
      doc.text(
        `…and ${slotRows.length - maxDetailRows} more windows not printed (open full data in the nursery app).`,
        ml,
        y,
        { width: usableW }
      );
      y += 14;
    }

    y += 10;
    doc.fillColor(COLORS.muted).font("Helvetica").fontSize(8);
    doc.text(
      `Generated ${new Date().toISOString()} · PlantSlot future windows · ${reportDateLabel}`,
      ml,
      y,
      { width: usableW, align: "center" }
    );

    doc.end();
  });
}
