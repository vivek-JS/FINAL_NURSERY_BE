/**
 * Sales Sheet row mapper.
 *
 * Converts an enriched + hydrated MIS order (see misOrderEnrichment.js) into a
 * flat row matching the sales-register layout exported by the Admin MIS
 * "Sales Sheet" download button.
 *
 * DC columns:
 *   - manualDc  = deliveryChallanInvoiceNumber (reserved / reused label)
 *   - systemDc  = officialDeliveryChallanNumber (immutable auto sequence)
 */

import moment from "moment";
import { pickDispatchLegForBucket } from "./misOrderEnrichment.js";

const IST_OFFSET_MINUTES = 330;

/** Numeric columns summed in the footer Total row. */
export const SALES_SHEET_SUM_KEYS = [
  "issuePlantQty",
  "returnQty",
  "damagedQty",
  "extraPlants",
  "plantQty",
  "invAmount",
  "rentExtraCharge",
  "totalInvoiceAmount",
  "total",
];

/** Stable column keys + display labels (single source of truth, also used by FE). */
export const SALES_SHEET_COLUMNS = [
  { key: "srNo", label: "Sr. No." },
  { key: "delDate", label: "Del. Date" },
  { key: "bookingNo", label: "Booking No." },
  { key: "customerName", label: "Customer Name" },
  { key: "mobileNo", label: "Mo. No." },
  { key: "village", label: "Village" },
  { key: "taluka", label: "Taluka" },
  { key: "district", label: "District" },
  { key: "plant", label: "Plant" },
  { key: "variety", label: "Variety" },
  { key: "media", label: "Media" },
  { key: "retail", label: "Retail" },
  { key: "shadeNo", label: "Shade No." },
  { key: "nursery", label: "Nursery" },
  { key: "batch", label: "Batch" },
  { key: "issuePlantQty", label: "Issue Plant Qty." },
  { key: "returnQty", label: "Return" },
  { key: "damagedQty", label: "Damaged" },
  { key: "extraPlants", label: "Extra Plants" },
  { key: "plantQty", label: "Plant Qty" },
  { key: "reference", label: "Reference" },
  { key: "marketingReference", label: "Marketing Reference" },
  { key: "rate", label: "Rate" },
  { key: "invAmount", label: "Inv. Amt." },
  { key: "rentExtraCharge", label: "Rent/Extra Charge" },
  { key: "vehicleNo", label: "Vehicle No." },
  { key: "driverName", label: "Driver Name" },
  { key: "totalInvoiceAmount", label: "Total Invoice Amount" },
  { key: "manualDc", label: "Manual DC" },
  { key: "systemDc", label: "System Generated DC" },
  { key: "total", label: "Total" },
];

function toIstYmd(dateVal) {
  if (!dateVal) return "";
  const d = moment(dateVal);
  if (!d.isValid()) return "";
  return d.utcOffset(IST_OFFSET_MINUTES).format("DD-MM-YYYY");
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Sales-sheet Batch cell: pipeline batch name/number + optional manual Lot/batch.
 * @param {{ lotBatch?: string|null, dispatchBatchNumber?: string|null }} parts
 */
export function formatSalesSheetBatch({ lotBatch, dispatchBatchNumber } = {}) {
  const lot = String(lotBatch ?? "").trim();
  const name = String(dispatchBatchNumber ?? "").trim();
  if (lot && name && lot !== name) return `${name} · ${lot}`;
  return lot || name || "";
}

function resolveDispatchBatchNumber(order, dispatchBatchById) {
  const leg = pickDispatchLegForBucket(order, order.bucketEventAt);
  if (!leg) return "";

  const fromLookup =
    leg.dispatchBatchId && dispatchBatchById
      ? dispatchBatchById.get(String(leg.dispatchBatchId))?.batchNumber
      : null;
  if (fromLookup != null && String(fromLookup).trim()) {
    return String(fromLookup).trim();
  }

  const snap = leg.productSnapshot?.batchNumber;
  return snap != null && String(snap).trim() ? String(snap).trim() : "";
}

/** Nursery site code from order (RB, SB, GH, …). Defaults to RB when unset. */
export function formatSalesSheetNursery(expectedNursery) {
  const code = String(expectedNursery ?? "").trim().toUpperCase();
  return code || "RB";
}

/**
 * @param {object} order enriched + hydrated lean order
 * @param {{ referenceById?: Map<string, object>, trayById?: Map<string, object> }} lookups
 */
export function buildSalesSheetRow(order, lookups = {}) {
  const { referenceById, trayById, dispatchBatchById } = lookups;

  const numberOfPlants = num(order.numberOfPlants);
  const additionalPlants = num(order.additionalPlants);
  const totalPlants = num(order.totalPlants) || numberOfPlants + additionalPlants;
  const returnedPlants = num(order.returnedPlants);
  const damagedPlants = num(order.damagedPlants);

  // Net plants actually issued = total ordered − returns − damages.
  const issuePlantQty = Math.max(0, totalPlants - returnedPlants - damagedPlants);

  const rate = num(order.rate);
  const freight = num(order.freightCharges);
  const invAmount = rate * issuePlantQty;
  const totalInvoiceAmount = invAmount + freight;

  const dispatch = order.dispatch || {};

  const referenceDoc =
    order.reference && referenceById ? referenceById.get(String(order.reference)) : null;

  const trayDoc =
    order.cavity && trayById ? trayById.get(String(order.cavity)) : null;

  return {
    delDate: toIstYmd(order.deliveryDate),
    bookingNo: order.orderId ?? "",
    customerName: order.farmerName || "",
    mobileNo: order.farmerMobile || "",
    village: order.farmerVillage || "",
    taluka: order.farmerTaluka || "",
    district: order.farmerDistrict || "",
    plant: order.plantTypeName || "",
    variety: order.plantSubtypeName || "",
    media: trayDoc?.name || "",
    retail: "",
    shadeNo: "",
    nursery: formatSalesSheetNursery(order.expectedNursery),
    batch: formatSalesSheetBatch({
      lotBatch: order.batchNumber,
      dispatchBatchNumber: resolveDispatchBatchNumber(order, dispatchBatchById),
    }),
    issuePlantQty,
    returnQty: returnedPlants,
    damagedQty: damagedPlants,
    extraPlants: additionalPlants,
    plantQty: numberOfPlants,
    reference: referenceDoc?.name || "",
    marketingReference: "",
    rate,
    invAmount,
    rentExtraCharge: freight,
    vehicleNo: dispatch.vehicleName || order.assignedVehicle || "",
    driverName: dispatch.driverName || "",
    totalInvoiceAmount,
    manualDc: order.deliveryChallanInvoiceNumber || "",
    systemDc: order.officialDeliveryChallanNumber || "",
    total: totalInvoiceAmount,
  };
}

export function buildSalesSheetRows(orders, lookups = {}) {
  return (orders || []).map((order, index) => ({
    srNo: index + 1,
    ...buildSalesSheetRow(order, lookups),
  }));
}

/** Footer row with column totals for qty / amount fields. */
export function buildSalesSheetTotalsRow(rows) {
  const totals = Object.fromEntries(
    SALES_SHEET_COLUMNS.map(({ key }) => [key, ""])
  );
  totals.customerName = "Total";
  for (const key of SALES_SHEET_SUM_KEYS) {
    totals[key] = (rows || []).reduce((sum, row) => sum + num(row[key]), 0);
  }
  return totals;
}
