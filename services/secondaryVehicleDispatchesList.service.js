import mongoose from "mongoose";
import Order from "../models/order.model.js";
import Dispatch from "../models/dispatch.model.js";
import PlantCms from "../models/plantCms.model.js";
import {
  DISPATCH_SHED_ALLOWED_STATUSES,
  sumPlantsLoadedOnDispatches,
} from "./secondaryVehicleLoad.service.js";

/** Office qty edit within this window shows "recent" on shed app cards. */
const OFFICE_EDIT_RECENT_MS = 24 * 60 * 60 * 1000;

function inferCavitySize(crateRow) {
  const name = String(crateRow?.cavityName || crateRow?.cavity || "").trim();
  const parsed = parseInt(name, 10);
  if (parsed > 0) return parsed;
  const crateCount = Number(crateRow?.crateCount) || 0;
  const plantCount = Number(crateRow?.plantCount) || 0;
  if (crateCount > 0 && plantCount > 0) {
    return Math.max(1, Math.round(plantCount / crateCount));
  }
  return 0;
}

function mapCrateForShedList(crateRow) {
  if (!crateRow) return null;
  const crateCount = Number(crateRow.crateCount) || 0;
  const plantCount = Number(crateRow.plantCount) || 0;
  const cavityName = String(crateRow.cavityName || crateRow.cavity || "").trim() || "—";
  const cavitySize =
    Number(crateRow.cavitySize) > 0
      ? Number(crateRow.cavitySize)
      : inferCavitySize(crateRow);
  const numberPerCrate =
    Number(crateRow.numberPerCrate) > 0 ? Number(crateRow.numberPerCrate) : 1;
  const rawDetails = Array.isArray(crateRow.crateDetails) ? crateRow.crateDetails : [];
  const crateDetails =
    rawDetails.length > 0
      ? rawDetails.map((d) => ({
          crateCount: Number(d.crateCount) || 0,
          plantCount: Number(d.plantCount) || 0,
        }))
      : undefined;

  return {
    cavityName,
    crateCount,
    plantCount,
    cavitySize,
    numberPerCrate,
    crateDetails,
  };
}

function unionDispatchOrderObjectIds(dispatchDoc) {
  const plain = dispatchDoc?.toObject?.() ?? dispatchDoc;
  const ids = new Set();
  for (const id of plain.orderIds || []) {
    if (id) ids.add(String(id));
  }
  for (const ord of plain.orderDispatchDetails || []) {
    if (ord?.orderId) ids.add(String(ord.orderId));
  }
  return [...ids]
    .filter((id) => mongoose.isValidObjectId(id))
    .map((id) => new mongoose.Types.ObjectId(id));
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildListFilter({ search, statusFilter }) {
  const filter = {
    isDeleted: { $ne: true },
    transportStatus: { $in: DISPATCH_SHED_ALLOWED_STATUSES },
  };
  if (statusFilter === "loaded") {
    filter.transportStatus = "LOADED";
  } else if (statusFilter === "pending") {
    filter.transportStatus = { $in: ["PENDING", "IN_TRANSIT"] };
  }
  if (search) {
    const rx = new RegExp(escapeRegex(search), "i");
    filter.$or = [
      { transportId: rx },
      { driverName: rx },
      { vehicleName: rx },
      { vehicleNumber: rx },
    ];
  }
  return filter;
}

function mapDispatchItem(d, loadedMap, plantCmsById, sowingAllowedByPlant, orderLabelById) {
  let totalQty = 0;
  let plantRows = (d.plantsDetails || []).map((p, plantRowIndex) => {
    const q = Number(p.quantity ?? p.totalPlants ?? 0) || 0;
    totalQty += q;
    let cratePieces = 0;
    const crates = (p.crates || []).map((c) => {
      const mapped = mapCrateForShedList(c);
      if (!mapped) return null;
      cratePieces += mapped.crateCount;
      return mapped;
    }).filter(Boolean);
    const pid = p.plantId ? String(p.plantId) : "";
    const sid = p.subTypeId ? String(p.subTypeId) : "";
    const cms = pid ? plantCmsById.get(pid) : null;
    const subtypeDoc = (cms?.subtypes || []).find((st) => String(st._id) === sid);
    const plantName = cms?.name || "";
    const subtypeName = subtypeDoc?.name || "";
    const label =
      plantName && subtypeName
        ? `${plantName} / ${subtypeName}`
        : String(p.name || "").trim() || plantName || subtypeName || "Plant";
    return {
      plantRowIndex,
      name: label,
      plantName: plantName || label,
      subtypeName: subtypeName || "",
      id: p.id,
      plantId: p.plantId,
      subTypeId: p.subTypeId,
      quantity: q,
      cratePieces,
      crates,
      sowingAllowed: pid ? Boolean(sowingAllowedByPlant.get(pid)) : false,
    };
  });

  const plantsDetailPreview = (d.plantsDetails || []).map((p) => {
    const q = Number(p.quantity ?? p.totalPlants ?? 0) || 0;
    const crates = (p.crates || []).map((c) => mapCrateForShedList(c)).filter(Boolean);
    const shadeMap = new Map();
    for (const pd of p.pickupDetails || []) {
      const label = String(pd.shadeName || pd.shade || "").trim() || "—";
      const qty = Number(pd.quantity || 0) || 0;
      shadeMap.set(label, (shadeMap.get(label) || 0) + qty);
    }
    const pickupByShade = [...shadeMap.entries()].map(([shadeName, quantity]) => ({
      shadeName,
      quantity,
    }));
    return {
      name: p.name,
      quantity: q,
      crates,
      pickupByShade,
    };
  });

  const loadedInfo = loadedMap.get(String(d._id)) || { total: 0, byOrder: new Map() };

  const orderDispatchPreview = (d.orderDispatchDetails || []).map((row) => {
    const oid = String(row.orderId || "");
    const label = orderLabelById.get(oid);
    let lineCratePieces = 0;
    const crates = (row.crates || []).map((c) => {
      const mapped = mapCrateForShedList(c);
      if (!mapped) return null;
      lineCratePieces += mapped.crateCount;
      return mapped;
    }).filter(Boolean);
    const dispatchQuantity = Number(row.dispatchQuantity || 0) || 0;
    const originalDispatchQuantity =
      row.originalDispatchQuantity != null &&
      Number.isFinite(Number(row.originalDispatchQuantity))
        ? Number(row.originalDispatchQuantity)
        : dispatchQuantity;
    const officeQtyDeltaTotal = dispatchQuantity - originalDispatchQuantity;
    const lastOfficeQtyDelta = Number(row.lastOfficeQtyDelta) || 0;
    const lastOfficeEditedAt = row.lastOfficeEditedAt || null;
    const fromOutward = loadedInfo.byOrder?.get(oid) || 0;
    const shedLoadedQuantity = Math.max(
      Number(row.shedLoadedQuantity) || 0,
      fromOutward
    );
    const shedLoadedFromSecondary = Boolean(
      row.shedLoadedFromSecondary || fromOutward > 0
    );
    return {
      orderId: row.orderId,
      orderIdNumeric: label?.orderId ?? null,
      publicOrderCode: label?.publicOrderCode ?? "",
      dispatchQuantity,
      originalDispatchQuantity,
      officeQtyDeltaTotal,
      lastOfficeQtyDelta,
      lastOfficeEditedAt,
      shedLoadedQuantity,
      shedLoadedFromSecondary,
      isFullyLoadedFromShed:
        dispatchQuantity > 0 && shedLoadedQuantity >= dispatchQuantity,
      shedLoadedBatches: Array.isArray(row.shedLoadedBatches)
        ? row.shedLoadedBatches.map((b) => ({
            batchId: b.batchId,
            batchNumber: b.batchNumber != null ? String(b.batchNumber) : "",
            plants: Number(b.plants) || 0,
            secondaryInwardId: b.secondaryInwardId,
            pollyhouse: b.pollyhouse != null ? String(b.pollyhouse) : "",
            loadedAt: b.loadedAt || null,
          }))
        : [],
      crates,
      cratePiecesOnLine: lineCratePieces,
      plantQtyOnLine: dispatchQuantity,
    };
  });

  const odPlantTotal = orderDispatchPreview.reduce((s, r) => s + r.dispatchQuantity, 0);
  let odCratePieces = 0;
  for (const line of orderDispatchPreview) {
    odCratePieces += line.cratePiecesOnLine;
  }

  if (plantRows.length === 0 && odPlantTotal > 0) {
    plantRows = [
      {
        name: "Orders on vehicle (collection slip)",
        id: "orderLines",
        quantity: odPlantTotal,
        cratePieces: odCratePieces,
      },
    ];
    totalQty = odPlantTotal;
  }

  const unionCount = unionDispatchOrderObjectIds(d).length;
  const vehiclePlantQty = totalQty || odPlantTotal;
  const shedLoadedPlantsTotal = loadedInfo.total || 0;
  const loadProgressPct =
    vehiclePlantQty > 0
      ? Math.min(100, Math.round((shedLoadedPlantsTotal / vehiclePlantQty) * 100))
      : 0;

  const officeQtyDeltaTotal = orderDispatchPreview.reduce(
    (s, r) => s + (Number(r.officeQtyDeltaTotal) || 0),
    0
  );
  const lastOfficeEditedAt = d.lastOfficeEditedAt || null;
  const hasRecentOfficeEdit =
    lastOfficeEditedAt != null &&
    Date.now() - new Date(lastOfficeEditedAt).getTime() < OFFICE_EDIT_RECENT_MS;

  return {
    _id: d._id,
    transportId: d.transportId,
    transportStatus: d.transportStatus,
    driverName: d.driverName,
    driverMobile: d.driverMobile,
    vehicleName: d.vehicleName,
    vehicleNumber: d.vehicleNumber,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    totalPlantQty: vehiclePlantQty,
    vehiclePlantQty,
    shedLoadedPlantsTotal,
    loadProgressPct,
    officeQtyDeltaTotal,
    lastOfficeEditedAt,
    hasRecentOfficeEdit,
    plantRowsSummary: plantRows,
    plantsDetailPreview,
    orderDispatchPreview,
    orderCount: unionCount || (d.orderIds || []).length,
  };
}

/**
 * Paginated vehicle dispatches for secondary shed UI.
 * status: pending | loaded | (empty = all allowed)
 * Batches outward load sums in one query (fast).
 */
export async function listSecondaryVehicleDispatches({
  page = 1,
  limit = 20,
  search = "",
  status = "",
} = {}) {
  const pageNum = Math.max(1, Number(page) || 1);
  const limitNum = Math.min(50, Math.max(1, Number(limit) || 20));
  const skip = (pageNum - 1) * limitNum;
  const qSearch = String(search || "").trim();
  const statusFilter = String(status || "").trim().toLowerCase();

  const filter = buildListFilter({ search: qSearch, statusFilter });
  const countBase = buildListFilter({ search: qSearch, statusFilter: "" });

  const [total, docs, pendingTotal, loadedTotal] = await Promise.all([
    Dispatch.countDocuments(filter),
    Dispatch.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNum)
      .select(
        "transportId transportStatus driverName driverMobile vehicleName vehicleNumber plantsDetails orderDispatchDetails orderIds lastOfficeEditedAt createdAt updatedAt"
      )
      .lean(),
    Dispatch.countDocuments({
      ...countBase,
      transportStatus: { $in: ["PENDING", "IN_TRANSIT"] },
    }),
    Dispatch.countDocuments({
      ...countBase,
      transportStatus: "LOADED",
    }),
  ]);

  const previewOrderIdSet = new Set();
  const plantIdSet = new Set();
  for (const d of docs) {
    for (const ord of d.orderDispatchDetails || []) {
      if (ord.orderId && mongoose.isValidObjectId(String(ord.orderId))) {
        previewOrderIdSet.add(String(ord.orderId));
      }
    }
    for (const p of d.plantsDetails || []) {
      if (p.plantId && mongoose.isValidObjectId(String(p.plantId))) {
        plantIdSet.add(String(p.plantId));
      }
    }
  }

  const previewOrderOids = [...previewOrderIdSet].map(
    (id) => new mongoose.Types.ObjectId(id)
  );

  const [previewOrderLabels, loadedMap, cmsRows] = await Promise.all([
    previewOrderOids.length
      ? Order.find({ _id: { $in: previewOrderOids } })
          .select("_id orderId publicOrderCode")
          .lean()
      : Promise.resolve([]),
    sumPlantsLoadedOnDispatches(docs.map((d) => d._id)),
    plantIdSet.size
      ? PlantCms.find({
          _id: { $in: [...plantIdSet].map((id) => new mongoose.Types.ObjectId(id)) },
        })
          .select("_id name sowingAllowed subtypes._id subtypes.name")
          .lean()
      : Promise.resolve([]),
  ]);

  const orderLabelById = new Map(previewOrderLabels.map((o) => [String(o._id), o]));
  const sowingAllowedByPlant = new Map();
  const plantCmsById = new Map();
  for (const r of cmsRows) {
    sowingAllowedByPlant.set(String(r._id), Boolean(r.sowingAllowed));
    plantCmsById.set(String(r._id), r);
  }

  const items = docs.map((d) =>
    mapDispatchItem(d, loadedMap, plantCmsById, sowingAllowedByPlant, orderLabelById)
  );

  return {
    items,
    page: pageNum,
    limit: limitNum,
    total,
    totalPages: Math.ceil(total / limitNum) || 1,
    pendingTotal,
    loadedTotal,
  };
}
