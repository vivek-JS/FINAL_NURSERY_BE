import mongoose from "mongoose";
import Order from "../models/order.model.js";
import Dispatch from "../models/dispatch.model.js";
import PlantCms from "../models/plantCms.model.js";
import PlantOutward from "../models/plantOutward.model.js";
import User from "../models/user.model.js";
import {
  DISPATCH_SHED_ALLOWED_STATUSES,
  sumPlantsLoadedOnDispatches,
} from "./secondaryVehicleLoad.service.js";
import { SHED_ACTIVITY_ACTIONS } from "./shedActivity.service.js";

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

const IST_OFFSET_MS = 330 * 60 * 1000;

/** YYYY-MM-DD (IST calendar day) → start of that day as a UTC Date, or null. */
function istDayStart(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || "").trim());
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - IST_OFFSET_MS);
}

/** IST day range (inclusive) → createdAt filter, or null. `date` = single day. */
function istRange({ date, from, to }) {
  const start = istDayStart(from || date);
  const endDay = istDayStart(to || date || from);
  const range = {};
  if (start) range.$gte = start;
  if (endDay) range.$lt = new Date(endDay.getTime() + 24 * 60 * 60 * 1000);
  return Object.keys(range).length ? range : null;
}

function buildListFilter({ search, statusFilter, date, from, to }) {
  const filter = {
    isDeleted: { $ne: true },
    transportStatus: { $in: DISPATCH_SHED_ALLOWED_STATUSES },
  };
  const range = istRange({ date, from, to });
  if (range) filter.createdAt = range;
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
      { driverMobile: rx },
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
      isPremium: Boolean(label?.farmer?.isPremium),
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
    hasPremiumCustomer: orderDispatchPreview.some((r) => r.isPremium),
    orderCount: unionCount || (d.orderIds || []).length,
  };
}

/**
 * Who loaded each vehicle: shed users from the batch activity log (SECONDARY_OUTWARD),
 * or the office user from order dispatch history when the vehicle has no shed loads.
 * Returns Map dispatchId → { loadedBy: [{ name, plants, at, office }], lastLoadedAt }.
 */
async function loadVehicleLoaders(docs, loadedMap) {
  const out = new Map();
  if (!docs.length) return out;
  const ids = docs.map((d) => d._id);

  const acts = await PlantOutward.aggregate([
    { $match: { "secondaryOutward.linkedDispatchId": { $in: ids } } },
    { $project: { log: "$secondaryInward.activityLog" } },
    { $unwind: "$log" },
    { $unwind: "$log" },
    {
      $match: {
        "log.action": SHED_ACTIVITY_ACTIONS.SECONDARY_OUTWARD,
        "log.metadata.linkedDispatchId": { $in: ids },
      },
    },
    {
      $project: {
        dispatchId: "$log.metadata.linkedDispatchId",
        userId: "$log.performedBy",
        plants: "$log.quantity",
        at: "$log.performedAt",
      },
    },
  ]);

  const officeDocs = docs.filter(
    (d) =>
      d.transportStatus === "LOADED" &&
      !(loadedMap.get(String(d._id))?.total > 0)
  );
  const officeIds = officeDocs.map((d) => d._id);
  const officeOrderIds = officeDocs.flatMap((d) => unionDispatchOrderObjectIds(d));
  const officeRows = officeOrderIds.length
    ? await Order.aggregate([
        { $match: { _id: { $in: officeOrderIds } } },
        { $project: { dispatchHistory: 1 } },
        { $unwind: "$dispatchHistory" },
        { $match: { "dispatchHistory.dispatchId": { $in: officeIds } } },
        {
          $project: {
            dispatchId: "$dispatchHistory.dispatchId",
            userId: "$dispatchHistory.processedBy",
            plants: "$dispatchHistory.quantity",
            at: "$dispatchHistory.date",
          },
        },
      ])
    : [];

  const userIds = [
    ...new Set(
      [...acts, ...officeRows]
        .map((r) => (r.userId ? String(r.userId) : ""))
        .filter((id) => mongoose.isValidObjectId(id))
    ),
  ];
  const users = userIds.length
    ? await User.find({ _id: { $in: userIds } }).select("_id name").lean()
    : [];
  const nameById = new Map(users.map((u) => [String(u._id), String(u.name || "").trim()]));

  const add = (rows, office) => {
    for (const r of rows) {
      const key = String(r.dispatchId);
      const bucket = out.get(key) || { byUser: new Map(), lastLoadedAt: null };
      const name = nameById.get(String(r.userId || "")) || (office ? "Office" : "—");
      const at = r.at ? new Date(r.at) : null;
      const cur = bucket.byUser.get(name) || { name, plants: 0, at: null, office };
      cur.plants += Number(r.plants) || 0;
      if (at && (!cur.at || at > cur.at)) cur.at = at;
      if (at && (!bucket.lastLoadedAt || at > bucket.lastLoadedAt)) bucket.lastLoadedAt = at;
      bucket.byUser.set(name, cur);
      out.set(key, bucket);
    }
  };
  add(acts, false);
  add(officeRows, true);

  const result = new Map();
  for (const [key, b] of out) {
    result.set(key, {
      loadedBy: [...b.byUser.values()].sort((a, c) => (c.at || 0) - (a.at || 0)),
      lastLoadedAt: b.lastLoadedAt,
    });
  }
  return result;
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
  date = "",
  from = "",
  to = "",
} = {}) {
  const pageNum = Math.max(1, Number(page) || 1);
  const limitNum = Math.min(50, Math.max(1, Number(limit) || 20));
  const skip = (pageNum - 1) * limitNum;
  const qSearch = String(search || "").trim();
  const statusFilter = String(status || "").trim().toLowerCase();

  const filter = buildListFilter({ search: qSearch, statusFilter, date, from, to });
  const countBase = buildListFilter({ search: qSearch, statusFilter: "", date, from, to });

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
          .select("_id orderId publicOrderCode farmer")
          .populate("farmer", "isPremium")
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

  const loadersById = await loadVehicleLoaders(docs, loadedMap);

  const items = docs.map((d) => ({
    ...mapDispatchItem(d, loadedMap, plantCmsById, sowingAllowedByPlant, orderLabelById),
    ...(loadersById.get(String(d._id)) || { loadedBy: [], lastLoadedAt: null }),
  }));

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
