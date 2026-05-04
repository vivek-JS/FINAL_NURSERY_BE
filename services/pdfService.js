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

/**
 * @param {object} opts
 * @param {string} opts.reportDateLabel
 * @param {{ farmerName: string, plantName: string, plantType: string, subtype: string, quantity: number }[]} opts.lineRows
 * @param {{ plant: string, subtype: string, quantity: number }[]} opts.summaryRows
 * @param {{ grandTotal: number, bookingLines: number, uniqueFarmers: number }} opts.stats
 * @param {string} [opts.dataSourceLabel] - Shown in footer (e.g. orders vs legacy bookings)
 * @param {string} [opts.bannerTitle] - Main PDF title (default: Today’s booking)
 */
export function generateTodayBookingPdf({
  reportDateLabel,
  lineRows,
  summaryRows,
  stats,
  dataSourceLabel = "Farmer orders (IST)",
  bannerTitle = "Today's Booking Report",
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
