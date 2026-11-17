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
import { sweepCancelledInstantPickups } from "./instantPickupDispatch.service.js";
import { packQtyFromOrderDispatchRow } from "../utility/packCratesFromOrder.js";
import { COMPLETED_ORDER_STATUSES, excludeDispatchIds } from "../utility/completedTrip.js";
import { DISPATCH_LEDGER_CUTOVER } from "../utility/dispatchListQuery.js";
import Trip from "../models/trip.model.js";

/** Office qty edit within this window shows "recent" on shed app cards. */
const OFFICE_EDIT_RECENT_MS = 24 * 60 * 60 * 1000;

function inferCavitySize(crateRow) {
  // Prefer plants÷crates (true plants/crate). Do NOT parse "8 Cavity" tray
  // names first — that is cells/tray, not plants/crate (× numberPerCrate).
  const crateCount = Number(crateRow?.crateCount) || 0;
  const plantCount = Number(crateRow?.plantCount) || 0;
  if (crateCount > 0 && plantCount > 0) {
    return Math.max(1, Math.round(plantCount / crateCount));
  }
  const name = String(crateRow?.cavityName || crateRow?.cavity || "").trim();
  const parsed = parseInt(name, 10);
  if (parsed > 0) return parsed;
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

/** Dispatches the shed should not list: delivered trip, invoice, or all orders completed. */
async function completedTripDispatchIds() {
  const open = {
    isDeleted: { $ne: true },
    transportStatus: { $in: DISPATCH_SHED_ALLOWED_STATUSES },
  };
  const [fromTrips, fromInvoice, fromOrders] = await Promise.all([
    Trip.distinct("dispatchId", { status: "delivered", dispatchId: { $ne: null } }),
    Dispatch.distinct("_id", {
      ...open,
      completeInvoicePdfUrl: { $type: "string", $gt: "" },
    }),
    Dispatch.aggregate([
      { $match: { ...open, "orderIds.0": { $exists: true } } },
      {
        $lookup: {
          from: "orders",
          localField: "orderIds",
          foreignField: "_id",
          pipeline: [{ $project: { _id: 0, orderStatus: 1 } }],
          as: "ords",
        },
      },
      {
        $match: {
          $expr: {
            $and: [
              { $gt: [{ $size: "$ords" }, 0] },
              {
                $allElementsTrue: {
                  $map: {
                    input: "$ords",
                    as: "o",
                    in: { $in: ["$$o.orderStatus", COMPLETED_ORDER_STATUSES] },
                  },
                },
              },
            ],
          },
        },
      },
      { $project: { _id: 1 } },
    ]),
  ]);
  const ids = new Set();
  for (const id of fromTrips) if (id) ids.add(String(id));
  for (const id of fromInvoice) if (id) ids.add(String(id));
  for (const row of fromOrders) if (row?._id) ids.add(String(row._id));
  return [...ids]
    .filter((id) => mongoose.isValidObjectId(id))
    .map((id) => new mongoose.Types.ObjectId(id));
}

function buildListFilter({ search, statusFilter, date, from, to, assignedToUserId }) {
  const filter = {
    isDeleted: { $ne: true },
    transportStatus: { $in: DISPATCH_SHED_ALLOWED_STATUSES },
  };
  if (assignedToUserId && mongoose.isValidObjectId(String(assignedToUserId))) {
    filter.assignedTo = new mongoose.Types.ObjectId(String(assignedToUserId));
  }
  const range = istRange({ date, from, to });
  const createdAt = range ? { ...range } : {};
  if (!createdAt.$gte || createdAt.$gte < DISPATCH_LEDGER_CUTOVER) {
    createdAt.$gte = DISPATCH_LEDGER_CUTOVER;
  }
  filter.createdAt = createdAt;
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
    const orderQty = Number(p.quantity ?? p.totalPlants ?? 0) || 0;
    let cratePieces = 0;
    let packFromCrates = 0;
    const crates = (p.crates || []).map((c) => {
      const mapped = mapCrateForShedList(c);
      if (!mapped) return null;
      cratePieces += mapped.crateCount;
      packFromCrates += Number(mapped.plantCount) || 0;
      return mapped;
    }).filter(Boolean);
    // Prefer pack plantCount from crates (includes free); fall back to order qty.
    const q = Math.max(orderQty, packFromCrates);
    totalQty += q;
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
      orderQuantity: orderQty,
      cratePieces,
      crates,
      sowingAllowed: pid
        ? Boolean(sowingAllowedByPlant.get(pid)) || /banana|keli|केळ/i.test(plantName)
        : false,
    };
  });

  // Skip plantsDetailPreview — Flutter uses plantRowsSummary; cuts payload/CPU.
  const plantsDetailPreview = [];

  const loadedInfo = loadedMap.get(String(d._id)) || { total: 0, byOrder: new Map() };

  let odShedLoadedSum = 0;
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
    odShedLoadedSum += shedLoadedQuantity;
    const shedLoadedFromSecondary = Boolean(
      row.shedLoadedFromSecondary || fromOutward > 0
    );
    const plantDoc = label?.plantName;
    const plantName =
      String(plantDoc?.name || label?.plantNameSnapshot || "").trim();
    const subtypeId = label?.plantSubtype ? String(label.plantSubtype) : "";
    const subtypeFromCms = (plantDoc?.subtypes || []).find(
      (st) => String(st._id) === subtypeId
    );
    const subtypeName = String(
      subtypeFromCms?.name || label?.plantSubtypeSnapshot || ""
    ).trim();
    const freePlantsPerCrate = Math.max(
      0,
      Number(plantDoc?.freePlantsPerCrate) || 0
    );
    const packQuantity = packQtyFromOrderDispatchRow(row);
    const freePlantBonus = Math.max(0, packQuantity - dispatchQuantity);
    return {
      orderId: row.orderId,
      orderIdNumeric: label?.orderId ?? null,
      publicOrderCode: label?.publicOrderCode ?? "",
      isPremium: Boolean(label?.farmer?.isPremium),
      farmerName: label?.farmer?.name || "",
      plantName,
      subtypeName,
      plantLabel:
        plantName && subtypeName
          ? `${plantName} / ${subtypeName}`
          : plantName || subtypeName || "",
      dispatchQuantity,
      packQuantity,
      freePlantsPerCrate,
      freePlantBonus,
      originalDispatchQuantity,
      officeQtyDeltaTotal,
      lastOfficeQtyDelta,
      lastOfficeEditedAt,
      shedLoadedQuantity,
      shedLoadedFromSecondary,
      isFullyLoadedFromShed:
        packQuantity > 0 && shedLoadedQuantity >= packQuantity,
      // Batches only needed when opening load sheet; keep ids light for list.
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
      packQtyOnLine: packQuantity,
    };
  });

  const odPlantTotal = orderDispatchPreview.reduce((s, r) => s + r.dispatchQuantity, 0);
  const odPackTotal = orderDispatchPreview.reduce(
    (s, r) => s + (Number(r.packQuantity) || r.dispatchQuantity || 0),
    0
  );
  let odCratePieces = 0;
  for (const line of orderDispatchPreview) {
    odCratePieces += line.cratePiecesOnLine;
  }

  if (plantRows.length === 0 && odPackTotal > 0) {
    plantRows = [
      {
        name: "Orders on vehicle (collection slip)",
        id: "orderLines",
        quantity: odPackTotal,
        cratePieces: odCratePieces,
      },
    ];
    totalQty = odPackTotal;
  }

  const unionCount = unionDispatchOrderObjectIds(d).length;
  // Load progress vs pack qty (includes free plants); DC still uses dispatchQuantity.
  const vehiclePlantQty = totalQty || odPackTotal || odPlantTotal;
  // Prefer denormalized row totals (fast); fall back to outward aggregate.
  const shedLoadedPlantsTotal = Math.max(loadedInfo.total || 0, odShedLoadedSum);
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

  const pickupFarmer = d.isInstantPickup
    ? orderLabelById.get(String(d.orderDispatchDetails?.[0]?.orderId || d.orderIds?.[0] || ""))
        ?.farmer
    : null;

  return {
    _id: d._id,
    isInstantPickup: Boolean(d.isInstantPickup),
    ...(pickupFarmer
      ? {
          farmerName: pickupFarmer.name || "",
          farmerMobile: pickupFarmer.mobileNumber ? String(pickupFarmer.mobileNumber) : "",
          farmerVillage: pickupFarmer.village || "",
        }
      : {}),
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
    assignedTo:
      d.assignedTo && typeof d.assignedTo === "object"
        ? d.assignedTo._id
        : d.assignedTo || null,
    assignedToName:
      d.assignedTo && typeof d.assignedTo === "object" ? d.assignedTo.name || "" : "",
    assignedAt: d.assignedAt || null,
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
  assignedToUserId = "",
} = {}) {
  const pageNum = Math.max(1, Number(page) || 1);
  const limitNum = Math.min(50, Math.max(1, Number(limit) || 20));
  const skip = (pageNum - 1) * limitNum;
  const qSearch = String(search || "").trim();
  const statusFilter = String(status || "").trim().toLowerCase();

  // Don't block the list on cleanup — runs in background.
  void sweepCancelledInstantPickups().catch((e) => {
    console.error("sweepCancelledInstantPickups:", e?.message || e);
  });

  const filter = buildListFilter({
    search: qSearch,
    statusFilter,
    date,
    from,
    to,
    assignedToUserId,
  });
  const countBase = buildListFilter({
    search: qSearch,
    statusFilter: "",
    date,
    from,
    to,
    assignedToUserId,
  });
  const completedIds = await completedTripDispatchIds();
  excludeDispatchIds(filter, completedIds);
  excludeDispatchIds(countBase, completedIds);
  const needLoaders = statusFilter === "loaded";
  // Pending list uses denormalized shedLoadedQuantity on rows — skip heavy outward scan.
  const needOutwardSums = statusFilter === "loaded" || statusFilter === "";

  const [total, docs, pendingTotal, loadedTotal] = await Promise.all([
    Dispatch.countDocuments(filter),
    Dispatch.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNum)
      .select(
        "transportId transportStatus isInstantPickup driverName driverMobile vehicleName vehicleNumber plantsDetails orderDispatchDetails orderIds lastOfficeEditedAt createdAt updatedAt shedReturnedPlants assignedTo assignedAt"
      )
      .populate("assignedTo", "name")
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
          .select("_id orderId publicOrderCode farmer plantName plantSubtype plantNameSnapshot plantSubtypeSnapshot")
          .populate("farmer", "isPremium name mobileNumber village")
          .populate("plantName", "name subtypes._id subtypes.name freePlantsPerCrate")
          .lean()
      : Promise.resolve([]),
    needOutwardSums
      ? sumPlantsLoadedOnDispatches(docs.map((d) => d._id))
      : Promise.resolve(new Map()),
    plantIdSet.size
      ? PlantCms.find({
          _id: { $in: [...plantIdSet].map((id) => new mongoose.Types.ObjectId(id)) },
        })
          .select("_id name sowingAllowed subtypes._id subtypes.name")
          .lean()
      : Promise.resolve([]),
  ]);

  // Loaders only on Loaded tab (pending doesn't show "loaded by").
  const loadersById = needLoaders
    ? await loadVehicleLoaders(docs, loadedMap)
    : new Map();

  const orderLabelById = new Map(previewOrderLabels.map((o) => [String(o._id), o]));
  const sowingAllowedByPlant = new Map();
  const plantCmsById = new Map();
  for (const r of cmsRows) {
    sowingAllowedByPlant.set(String(r._id), Boolean(r.sowingAllowed));
    plantCmsById.set(String(r._id), r);
  }

  const items = docs.map((d) => ({
    ...mapDispatchItem(d, loadedMap, plantCmsById, sowingAllowedByPlant, orderLabelById),
    ...(loadersById.get(String(d._id)) || { loadedBy: [], lastLoadedAt: null }),
    shedReturnedPlants: Number(d.shedReturnedPlants) || 0,
    shedReturns: [],
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
