/** Paid-by values stored on Order.freight.paidBy */
export const FREIGHT_PAID_BY = ["FARMER", "COMPANY", "TRANSPORTER", "DEALER"];

function money(n) {
  const v = Math.max(0, Number(n) || 0);
  return Math.round(v * 100) / 100;
}

/** Farmer-borne freight that belongs on the amount owed. */
export function resolveFarmerFreightShare(order) {
  const structured = order?.freight ?? order?.details?.freight;
  if (structured && typeof structured === "object") {
    if (structured.farmerShareAmount != null && structured.farmerShareAmount !== "") {
      return money(structured.farmerShareAmount);
    }
    const total = money(structured.totalAmount);
    const pct = Number(structured.farmerSharePercent);
    if (total > 0 && Number.isFinite(pct)) {
      return money(total * (Math.min(100, Math.max(0, pct)) / 100));
    }
  }
  return money(order?.freightCharges ?? order?.details?.freightCharges ?? 0);
}

/**
 * Normalize a complete-form freight payload (object or legacy number) into
 * `{ freight, freightCharges }` where freightCharges mirrors the farmer share.
 */
export function normalizeFreightInput(raw, { userId } = {}) {
  if (raw == null || raw === "") return null;

  if (typeof raw === "number" || typeof raw === "string") {
    const farmerShareAmount = money(raw);
    return {
      freight: {
        totalAmount: farmerShareAmount,
        farmerShareAmount,
        companyShareAmount: 0,
        farmerSharePercent: 100,
        paidBy: "FARMER",
        transporterName: "",
        vehicleNumber: "",
        remark: "",
        recordedBy: userId || undefined,
        recordedAt: new Date(),
      },
      freightCharges: farmerShareAmount,
    };
  }

  const totalAmount = money(raw.totalAmount);
  let farmerShareAmount =
    raw.farmerShareAmount != null && raw.farmerShareAmount !== ""
      ? money(raw.farmerShareAmount)
      : null;
  let companyShareAmount =
    raw.companyShareAmount != null && raw.companyShareAmount !== ""
      ? money(raw.companyShareAmount)
      : null;
  let farmerSharePercent =
    raw.farmerSharePercent != null && raw.farmerSharePercent !== ""
      ? Math.min(100, Math.max(0, Number(raw.farmerSharePercent) || 0))
      : 100;

  if (farmerShareAmount == null) {
    farmerShareAmount = money(totalAmount * (farmerSharePercent / 100));
  }
  if (companyShareAmount == null) {
    companyShareAmount = money(totalAmount - farmerShareAmount);
  }
  if (totalAmount > 0) {
    farmerSharePercent = Math.round((farmerShareAmount / totalAmount) * 10000) / 100;
  }

  const paidBy = FREIGHT_PAID_BY.includes(raw.paidBy) ? raw.paidBy : "FARMER";

  return {
    freight: {
      totalAmount,
      farmerShareAmount,
      companyShareAmount,
      farmerSharePercent,
      paidBy,
      transporterName: String(raw.transporterName || "").trim(),
      vehicleNumber: String(raw.vehicleNumber || "").trim(),
      remark: String(raw.remark || "").trim(),
      recordedBy: userId || undefined,
      recordedAt: new Date(),
    },
    freightCharges: farmerShareAmount,
  };
}

/** Keep legacy `freightCharges` equal to the farmer share so older readers stay correct. */
export function applyFreightChargesMirror(doc) {
  if (!doc) return;
  if (doc.freight && typeof doc.freight === "object") {
    doc.freightCharges = money(doc.freight.farmerShareAmount);
  }
}
