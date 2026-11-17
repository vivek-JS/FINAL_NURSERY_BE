import mongoose from "mongoose";
import Order from "../models/order.model.js";
import PlantCms from "../models/plantCms.model.js";
import Product from "../models/product.model.js";
import SowingRequest from "../models/sowingRequest.model.js";
import PlantSlot from "../models/slots.model.js";
import SowingEntry from "../models/sowingEntry.model.js";
import {
  parseNum,
  pushEvent,
  applyPlantsToLinkedSlots,
  markOrdersSowed,
  recordExcessPlantsOnSlot,
  findSowBatchForRequest,
  editSowEntryOnSlots,
} from "./sowingCompleteHelpers.js";
import { sowQtySlotImpact } from "../utility/lagwadSlotPlantsSplit.js";
import {
  resolveCmsReadyDays,
  fmtDDMMYYYY,
  addDays,
  parseLocalDate as parseLocalDateHelper,
  istTodayNoon,
  toSowYmd,
  findSlotByPlantReadyDate,
} from "./sowingSlotReadyHelpers.js";
import { reportedExcess, sowCoverPool } from "../utility/lagwadSlotPlantsSplit.js";
import { excessFieldsForBatch } from "../utility/sowingBatchExcessStamp.js";
import { requestCoverOrderIds } from "../services/orderSowCover.plan.js";
import { fetchSlotsBySubtype } from "../services/directSowSlotDays.service.js";

function isOfficeOrSuper(user) {
  const t = String(user?.jobTitle || user?.role || "").toUpperCase();
  return (
    t === "SUPER_ADMIN" ||
    t === "SUPERADMIN" ||
    t === "OFFICE_ADMIN" ||
    t === "OFFICEADMIN"
  );
}

function dayRange(dateStr) {
  const [y, m, d] = String(dateStr || "")
    .split("-")
    .map((n) => parseInt(n, 10));
  if (!y || !m || !d) return null;
  const start = new Date(y, m - 1, d, 0, 0, 0, 0);
  const end = new Date(y, m - 1, d, 23, 59, 59, 999);
  return { start, end };
}

function entryKindOf(body) {
  const kind = String(body?.kind || "").trim().toLowerCase();
  return kind === "komb" || kind === "excess" ? kind : "sowing";
}

function readyNowOf(body) {
  return body?.readyNow === true || body?.readyNow === "true";
}

/** Add plants onto a sowing without a new mortality buffer. */
async function addExcessOntoEntry({ entryId, qty, readyNow, sowedAt }) {
  if (!mongoose.Types.ObjectId.isValid(String(entryId || ""))) {
    const err = new Error("Choose a sowing to update");
    err.status = 400;
    throw err;
  }
  const entry = await SowingEntry.findById(entryId);
  if (!entry) {
    const err = new Error("Sowing not found");
    err.status = 404;
    throw err;
  }
  const add = Math.max(0, Math.floor(Number(qty) || 0));
  if (add <= 0) {
    const err = new Error("plantsSowed must be > 0");
    err.status = 400;
    throw err;
  }
  const oldBuffer = entry.noMortalityReserve
    ? 0
    : Math.max(0, Math.floor(Number(entry.bufferPlants) || 0));
  const newSowed = Math.max(0, Math.floor(Number(entry.plantsSowed) || 0)) + add;
  entry.plantsSowed = newSowed;
  if (oldBuffer <= 0) {
    entry.noMortalityReserve = true;
    entry.sowingBufferPct = 0;
    entry.bufferPlants = 0;
  } else {
    entry.sowingBufferPct = (oldBuffer * 100) / newSowed;
    entry.bufferPlants = oldBuffer;
  }
  const fields = excessFieldsForBatch(entry.toObject(), entry.sowingBufferPct);
  entry.bufferPlants = fields.bufferPlants;
  entry.sowingBufferPct = fields.sowingBufferPct;
  entry.excessPlants = fields.shownExcess;
  const dispatched = Math.max(0, Math.floor(Number(entry.dispatchedPlants) || 0));
  const mortality = entry.noMortalityReserve ? 0 : fields.bufferPlants;
  entry.remainingPlants = Math.max(0, newSowed - mortality - dispatched);
  if (readyNow) {
    entry.plantReadyDate = fmtDDMMYYYY(sowedAt);
  }
  await entry.save();

  if (entry.sowingRequestId) {
    const batches = await findSowBatchForRequest(entry.sowingRequestId);
    const batchId = batches[0]?.batch?._id;
    if (batchId) {
      await PlantSlot.updateOne(
        { "subtypeSlots.slots.sowingBatches._id": batchId },
        {
          $set: {
            "subtypeSlots.$[st].slots.$[sl].sowingBatches.$[b].plantsSowed": newSowed,
            "subtypeSlots.$[st].slots.$[sl].sowingBatches.$[b].sowingBufferPct": entry.sowingBufferPct,
            "subtypeSlots.$[st].slots.$[sl].sowingBatches.$[b].bufferPlants": entry.bufferPlants,
            "subtypeSlots.$[st].slots.$[sl].sowingBatches.$[b].excessPlants": entry.excessPlants,
            "subtypeSlots.$[st].slots.$[sl].sowingBatches.$[b].noMortalityReserve": Boolean(
              entry.noMortalityReserve
            ),
            ...(readyNow
              ? {
                  "subtypeSlots.$[st].slots.$[sl].sowingBatches.$[b].plantReadyDate":
                    entry.plantReadyDate,
                  "subtypeSlots.$[st].slots.$[sl].sowingBatches.$[b].plantReadyDays": 0,
                }
              : {}),
          },
        },
        {
          arrayFilters: [
            { "st.slots.sowingBatches._id": batchId },
            { "sl.sowingBatches._id": batchId },
            { "b._id": batchId },
          ],
        }
      );
    }
  }
  return entry;
}

async function saveTaggedDirectSow(req, res, ctx) {
  const {
    entryKind,
    plant,
    subtype,
    plantId,
    subtypeId,
    plantsSowed,
    sowedAt,
    shedName,
    notes,
    product,
    userId,
  } = ctx;
  const readyNow = entryKind === "excess" && readyNowOf(req.body);
  const bodyReady = parseNum(req.body.plantReadyDays, NaN);
  const readyDateHint = String(req.body.readyDate || req.body.plantReadyDate || "").trim();
  const readyDateParsed = parseLocalDate(readyDateHint);
  let plantReadyDays;
  if (readyNow) {
    plantReadyDays = 0;
  } else if (readyDateParsed && sowedAt) {
    const s0 = new Date(sowedAt);
    s0.setHours(0, 0, 0, 0);
    const r0 = new Date(readyDateParsed);
    r0.setHours(0, 0, 0, 0);
    const diff = Math.round((r0.getTime() - s0.getTime()) / 86400000);
    if (diff < 0) {
      return res.status(400).json({
        success: false,
        message: "readyDate cannot be before sow date",
      });
    }
    plantReadyDays = diff;
  } else if (Number.isFinite(bodyReady) && bodyReady >= 0) {
    plantReadyDays = bodyReady;
  } else if (entryKind === "komb") {
    plantReadyDays = 30;
  } else {
    plantReadyDays =
      Number(subtype.plantReadyDays) || (await resolveCmsReadyDays(plantId, subtypeId));
  }
  if (!Number.isFinite(plantReadyDays) || plantReadyDays < 0) {
    return res.status(400).json({
      success: false,
      message: "plantReadyDays must be ≥ 0",
    });
  }

  const sourceEntryId =
    req.body.sourceEntryId && mongoose.Types.ObjectId.isValid(req.body.sourceEntryId)
      ? new mongoose.Types.ObjectId(req.body.sourceEntryId)
      : null;
  const requestNumber = await SowingRequest.generateRequestNumber();
  const label = entryKind === "komb" ? "Komb" : "Excess";
  const request = new SowingRequest({
    requestNumber,
    plantId: new mongoose.Types.ObjectId(plantId),
    plantName: plant.name,
    subtypeId: new mongoose.Types.ObjectId(subtypeId),
    subtypeName: subtype.name,
    ...(product?._id ? { productId: product._id } : {}),
    packetsNeeded: 0,
    packetsRequested: 0,
    excessPackets: 0,
    conversionFactor: Number(product?.conversionFactor) || 1,
    status: "issued",
    requestedBy: userId,
    issuedBy: userId,
    issuedDate: sowedAt,
    notes: notes || `${label} sow`,
    linkedSlotIds: [],
    linkedOrderIds: [],
    isExcessiveSowing: true,
    packetsFromCompany: 0,
    packetsFromRaising: 0,
    packetsIssued: 0,
    packetsUsed: 0,
    packetsReturned: 0,
    sowedQuantity: plantsSowed,
    shedName: shedName || "Office",
    completionNotes: notes || `${label} · ${plantsSowed} · no mortality`,
    completedBy: userId,
    sowingCompleted: true,
    sowingCompletedDate: sowedAt,
    sowingInProgress: false,
    remainingSowingNeeded: 0,
    completionEvents: [],
  });

  const slotResult = await applyPlantsToLinkedSlots(request, plantsSowed, {
    packetsUsed: 0,
    requestNumber,
    linkedOrderIds: [],
    isExcessiveSowing: true,
    entryKind,
    sourceEntryId,
    shedName,
    sowedAt,
    plantReadyDays,
    mortalityPct: 0,
    excessPlants: plantsSowed,
    userId,
  });
  pushEvent(request, {
    type: "SOW_COMPLETED",
    by: userId,
    quantity: plantsSowed,
    unit: entryKind === "komb" ? "komb" : "plants",
    message:
      entryKind === "komb"
        ? `Komb sow: ${plantsSowed} komb, ready in ${plantReadyDays} days`
        : `Excess sow: ${plantsSowed} plants`,
    meta: { entryKind, plantReadyDays, sourceEntryId: sourceEntryId ? String(sourceEntryId) : null },
  });
  await request.saveWithUniqueRequestNumber();

  return res.status(201).json({
    success: true,
    message: entryKind === "komb" ? "Komb saved" : "Excess saved",
    data: {
      requestId: request._id,
      requestNumber: request.requestNumber,
      plantsSowed,
      packetsUsed: 0,
      entryKind,
      orderCoveredPlants: 0,
      excessPlants: plantsSowed,
      plantReadyDays: slotResult.plantReadyDays ?? plantReadyDays,
      plantReadyDate: slotResult.plantReadyDate,
      updated: false,
    },
  });
}

function parseLocalDate(input) {
  return parseLocalDateHelper(input);
}

/** Ready-date helper for UI chips (no auto-cover window). */
function coverWindowForSow(sowStart, plantReadyDays) {
  const rd = Math.max(0, Number(plantReadyDays) || 0);
  const ready = addDays(sowStart, rd);
  return {
    readyDate: fmtDDMMYYYY(ready),
    plantReadyDays: rd,
    coverFrom: fmtDDMMYYYY(ready),
    coverTo: fmtDDMMYYYY(ready),
    coverWindowDays: 0,
  };
}

async function resolveSeedProduct(plantId, subtypeId) {
  return Product.findOne({
    plantId: new mongoose.Types.ObjectId(plantId),
    subtypeId: new mongoose.Types.ObjectId(subtypeId),
    category: { $regex: /^seeds$/i },
    isActive: true,
  })
    .select("_id name code conversionFactor primaryUnit secondaryUnit")
    .populate("primaryUnit", "name symbol")
    .populate("secondaryUnit", "name symbol")
    .lean();
}

/**
 * GET /sowing/admin-direct-sow/orders?date=YYYY-MM-DD&plantId=
 * date = optional default sow hint (defaults today). Lists all unsowed orders for plant.
 * Marking on submit only covers selected/included orderIds (no ±4d auto-cover).
 */
export const listDirectSowOrders = async (req, res) => {
  try {
    const dateStr =
      req.query.date ||
      (() => {
        const d = new Date();
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, "0");
        const day = String(d.getDate()).padStart(2, "0");
        return `${y}-${m}-${day}`;
      })();

    const sowRange = dayRange(dateStr);
    if (!sowRange) {
      return res.status(400).json({
        success: false,
        message: "Query date must be YYYY-MM-DD when provided (default sow hint)",
      });
    }

    const plantFilter =
      req.query.plantId && mongoose.Types.ObjectId.isValid(req.query.plantId)
        ? new mongoose.Types.ObjectId(req.query.plantId)
        : null;

    const plantQuery = { sowingAllowed: true };
    if (plantFilter) plantQuery._id = plantFilter;

    const plants = await PlantCms.find(plantQuery)
      .select("_id name subtypes._id subtypes.name subtypes.plantReadyDays")
      .lean();
    const plantIds = plants.map((p) => p._id);
    if (!plantIds.length) {
      return res.json({
        success: true,
        date: dateStr,
        plantId: plantFilter ? String(plantFilter) : null,
        items: [],
        groups: [],
        total: 0,
        coverWindowDays: 0,
      });
    }

    const plantMap = new Map(plants.map((p) => [String(p._id), p]));
    const subtypeIds = plants.flatMap((p) =>
      (p.subtypes || []).map((st) => st._id)
    );

    const acceptedOnly =
      String(req.query.acceptedOnly || "") === "1" ||
      String(req.query.orderStatus || "").toUpperCase() === "ACCEPTED";
    const orders = await Order.find({
      plantName: { $in: plantIds },
      ...(subtypeIds.length ? { plantSubtype: { $in: subtypeIds } } : {}),
      sowingDone: { $ne: true },
      orderStatus: acceptedOnly
        ? "ACCEPTED"
        : {
            $nin: ["CANCELLED", "TEMPORARY_CANCELLED", "REJECTED", "DELETED"],
          },
    })
      .select(
        "orderId name farmer plantName plantSubtype bookingSlot numberOfPlants additionalPlants deliveryDate sowingPlan orderStatus"
      )
      .populate("farmer", "name mobileNumber")
      .sort({ deliveryDate: 1, orderId: 1 })
      .lean();

    const items = orders.map((o) => {
      const plant = plantMap.get(String(o.plantName));
      const st = (plant?.subtypes || []).find(
        (s) => String(s._id) === String(o.plantSubtype)
      );
      const plantsQty =
        (Number(o.numberOfPlants) || 0) + (Number(o.additionalPlants) || 0);
      const plantReadyDays = Number(st?.plantReadyDays) || 0;
      const win = coverWindowForSow(sowRange.start, plantReadyDays);
      return {
        orderId: o._id,
        orderNumber: o.orderId,
        farmerName: o.farmer?.name || o.name || "",
        farmerMobile: o.farmer?.mobileNumber || "",
        plantId: o.plantName,
        plantName: plant?.name || "",
        subtypeId: o.plantSubtype,
        subtypeName: st?.name || "",
        plantReadyDays,
        readyDate: win.readyDate,
        coverFrom: win.readyDate,
        coverTo: win.readyDate,
        coverWindowDays: 0,
        availableDay: o.deliveryDate || null,
        slotId: o.bookingSlot,
        plants: plantsQty,
        deliveryDate: o.deliveryDate,
        seedSource: o.sowingPlan?.seedSource || "COMPANY",
        companySeedPackets: Number(o.sowingPlan?.companySeedPackets) || 0,
        raisingSeedPackets: Number(o.sowingPlan?.raisingSeedPackets) || 0,
        sowingPlan: o.sowingPlan || null,
      };
    });

    const groupsMap = new Map();
    for (const it of items) {
      const key = `${it.plantId}-${it.subtypeId}`;
      if (!groupsMap.has(key)) {
        groupsMap.set(key, {
          plantId: it.plantId,
          plantName: it.plantName,
          subtypeId: it.subtypeId,
          subtypeName: it.subtypeName,
          plantReadyDays: it.plantReadyDays,
          readyDate: it.readyDate,
          coverFrom: it.coverFrom,
          coverTo: it.coverTo,
          coverWindowDays: 0,
          orderCount: 0,
          totalPlants: 0,
          slotIds: new Set(),
          orders: [],
        });
      }
      const g = groupsMap.get(key);
      g.orderCount += 1;
      g.totalPlants += it.plants;
      if (it.slotId) g.slotIds.add(String(it.slotId));
      g.orders.push(it);
    }

    // When plant filtered: include subtypes with zero unsowed orders (excess sow)
    if (plantFilter) {
      for (const p of plants) {
        for (const st of p.subtypes || []) {
          const key = `${p._id}-${st._id}`;
          if (groupsMap.has(key)) continue;
          const rd = Math.max(0, Number(st.plantReadyDays) || 0);
          const win = coverWindowForSow(sowRange.start, rd);
          groupsMap.set(key, {
            plantId: p._id,
            plantName: p.name,
            subtypeId: st._id,
            subtypeName: st.name,
            plantReadyDays: rd,
            readyDate: win.readyDate,
            coverFrom: win.readyDate,
            coverTo: win.readyDate,
            coverWindowDays: 0,
            orderCount: 0,
            totalPlants: 0,
            slotIds: new Set(),
            orders: [],
          });
        }
      }
    }

    const groups = [...groupsMap.values()]
      .map((g) => ({
        ...g,
        slotIds: [...g.slotIds],
      }))
      .sort((a, b) => {
        const byPlant = String(a.plantName).localeCompare(String(b.plantName));
        if (byPlant) return byPlant;
        return String(a.subtypeName).localeCompare(String(b.subtypeName));
      });

    const productCache = new Map();
    for (const g of groups) {
      const pk = `${g.plantId}-${g.subtypeId}`;
      if (!productCache.has(pk)) {
        productCache.set(pk, await resolveSeedProduct(g.plantId, g.subtypeId));
      }
      const product = productCache.get(pk);
      g.conversionFactor = Number(product?.conversionFactor) || 1;
      g.hasSeedProduct = Boolean(product?._id);
      g.seedProductName = product?.name || null;
    }

    if (plantFilter && groups.length) {
      const slotDaysMap = await fetchSlotsBySubtype(
        plantFilter,
        groups.map((g) => g.subtypeId)
      );
      for (const g of groups) {
        g.slots = slotDaysMap.get(String(g.subtypeId)) || [];
        g.slotDays = g.slots;
      }
    } else {
      for (const g of groups) {
        g.slots = [];
        g.slotDays = [];
      }
    }

    return res.json({
      success: true,
      date: dateStr,
      plantId: plantFilter ? String(plantFilter) : null,
      coverWindowDays: 0,
      total: items.length,
      items,
      groups,
    });
  } catch (error) {
    console.error("listDirectSowOrders:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to load orders",
      error: error.message,
    });
  }
};

/**
 * POST /sowing/admin-direct-sow
 * Bypass request → issue. Creates completed sow + applies slots + marks orders.
 * Body: orderIds[] and/or plantId+subtypeId for excess-only.
 */
export const submitDirectSow = async (req, res) => {
  try {
    if (!isOfficeOrSuper(req.user)) {
      return res.status(403).json({
        success: false,
        message: "Only Office Admin or Super Admin can use direct sow portal",
      });
    }

    const orderIds = Array.isArray(req.body.orderIds)
      ? req.body.orderIds.filter((id) => mongoose.Types.ObjectId.isValid(id))
      : [];

    const bodyPlantId =
      req.body.plantId && mongoose.Types.ObjectId.isValid(req.body.plantId)
        ? String(req.body.plantId)
        : null;
    const bodySubtypeId =
      req.body.subtypeId && mongoose.Types.ObjectId.isValid(req.body.subtypeId)
        ? String(req.body.subtypeId)
        : null;
    const entryKind = entryKindOf(req.body);
    const updateEntryId = String(req.body.updateEntryId || "").trim();
    const updatingExcess = entryKind === "excess" && Boolean(updateEntryId);

    if (!updatingExcess && !orderIds.length && !(bodyPlantId && bodySubtypeId)) {
      return res.status(400).json({
        success: false,
        message: "Select orders, or pass plantId + subtypeId for excess sow",
      });
    }

    const shedName =
      String(
        req.body.shedName || req.body.pollyhouse || req.body.shed || "Office"
      ).trim() || "Office";

    const notes = String(req.body.notes || req.body.completionNotes || "").trim();
    const batchNumber = String(req.body.batchNumber || "").trim();
    const laboursLadies = Math.max(0, parseNum(req.body.laboursLadies));
    const laboursGents = Math.max(0, parseNum(req.body.laboursGents));
    const sowDateHint = String(
      req.body.sowDate || req.body.sowingDate || req.body.date || ""
    ).trim();
    const sowedAt = parseLocalDate(sowDateHint) || istTodayNoon();

    if (updatingExcess) {
      try {
        const entry = await addExcessOntoEntry({
          entryId: updateEntryId,
          qty: parseNum(req.body.plantsSowed, NaN),
          readyNow: readyNowOf(req.body),
          sowedAt,
        });
        return res.status(200).json({
          success: true,
          message: "Sowing updated",
          data: {
            entryId: entry._id,
            plantsSowed: entry.plantsSowed,
            entryKind: entry.entryKind || "sowing",
            plantReadyDate: entry.plantReadyDate,
            updated: true,
          },
        });
      } catch (error) {
        return res.status(error.status || 500).json({
          success: false,
          message: error.message || "Failed to update sowing",
        });
      }
    }

    let orders = [];
    if (orderIds.length) {
      orders = await Order.find({
        _id: { $in: orderIds.map((id) => new mongoose.Types.ObjectId(id)) },
        sowingDone: { $ne: true },
        orderStatus: {
          $nin: ["CANCELLED", "TEMPORARY_CANCELLED", "REJECTED", "DELETED"],
        },
      })
        .select(
          "orderId plantName plantSubtype bookingSlot numberOfPlants additionalPlants deliveryDate sowingPlan"
        )
        .lean();

      if (!orders.length) {
        return res.status(400).json({
          success: false,
          message: "No eligible unsowed orders found",
        });
      }
    }

    let plantId = bodyPlantId;
    let subtypeId = bodySubtypeId;
    if (orders.length) {
      plantId = String(orders[0].plantName);
      subtypeId = String(orders[0].plantSubtype);
      const mixed = orders.some(
        (o) =>
          String(o.plantName) !== plantId || String(o.plantSubtype) !== subtypeId
      );
      if (mixed) {
        return res.status(400).json({
          success: false,
          message: "Select orders from one plant + subtype only",
        });
      }
    }

    const plant = await PlantCms.findById(plantId)
      .select("name subtypes sowingAllowed sowingBuffer")
      .lean();
    if (!plant?.sowingAllowed) {
      return res.status(400).json({
        success: false,
        message: "Plant is not sowing-allowed",
      });
    }
    const subtype = (plant.subtypes || []).find(
      (s) => String(s._id) === subtypeId
    );
    if (!subtype) {
      return res.status(404).json({ success: false, message: "Subtype not found" });
    }

    const product = await resolveSeedProduct(plantId, subtypeId);

    const orderPlantSum = orders.reduce(
      (s, o) =>
        s + (Number(o.numberOfPlants) || 0) + (Number(o.additionalPlants) || 0),
      0
    );
    let plantsSowed = Math.max(0, parseNum(req.body.plantsSowed, NaN));
    if (!Number.isFinite(plantsSowed) || plantsSowed <= 0) {
      plantsSowed = orderPlantSum;
    }
    if (plantsSowed <= 0) {
      return res.status(400).json({
        success: false,
        message: entryKind === "komb" ? "Enter the number of komb" : "plantsSowed must be > 0",
      });
    }

    if (entryKind === "komb" || entryKind === "excess") {
      return saveTaggedDirectSow(req, res, {
        entryKind,
        plant,
        subtype,
        plantId,
        subtypeId,
        plantsSowed,
        sowedAt,
        shedName,
        notes,
        product,
        userId: req.user._id,
      });
    }

    const isExcessOnly = orders.length === 0;
    const cf = Number(product?.conversionFactor) || 1;
    const orderPlan = orders.length === 1 ? orders[0].sowingPlan || null : null;

    let packetsFromCompany = Math.max(0, parseNum(req.body.packetsFromCompany, NaN));
    let packetsFromRaising = Math.max(0, parseNum(req.body.packetsFromRaising, NaN));
    let packetsUsed = Math.max(0, parseNum(req.body.packetsUsed, NaN));

    const bodyHasSplit =
      Number.isFinite(parseNum(req.body.packetsFromCompany, NaN)) ||
      Number.isFinite(parseNum(req.body.packetsFromRaising, NaN));

    if (bodyHasSplit) {
      if (!Number.isFinite(packetsFromCompany)) packetsFromCompany = 0;
      if (!Number.isFinite(packetsFromRaising)) packetsFromRaising = 0;
      packetsUsed = packetsFromCompany + packetsFromRaising;
    } else if (!Number.isFinite(packetsUsed)) {
      packetsUsed = product && cf > 0 ? Math.ceil(plantsSowed / cf) : 0;
    }

    if (packetsUsed <= 0 && orderPlan) {
      const planCompany = Number(orderPlan.companySeedPackets) || 0;
      const planRaising = Number(orderPlan.raisingSeedPackets) || 0;
      if (planCompany + planRaising > 0) {
        packetsFromCompany = planCompany;
        packetsFromRaising = planRaising;
        packetsUsed = planCompany + planRaising;
      }
    }

    if (!bodyHasSplit && packetsUsed > 0) {
      const src = String(
        req.body.seedSource || orderPlan?.seedSource || "COMPANY"
      ).toUpperCase();
      if (src === "RAISING") {
        packetsFromRaising = packetsUsed;
        packetsFromCompany = 0;
      } else if (src === "MIXED" && orderPlan) {
        packetsFromCompany = Number(orderPlan.companySeedPackets) || 0;
        packetsFromRaising = Number(orderPlan.raisingSeedPackets) || 0;
        if (packetsFromCompany + packetsFromRaising <= 0) {
          packetsFromCompany = packetsUsed;
          packetsFromRaising = 0;
        } else {
          packetsUsed = packetsFromCompany + packetsFromRaising;
        }
      } else {
        packetsFromCompany = packetsUsed;
        packetsFromRaising = 0;
      }
    }

    let seedSource = String(
      req.body.seedSource || orderPlan?.seedSource || "COMPANY"
    ).toUpperCase();
    if (packetsFromCompany > 0 && packetsFromRaising > 0) seedSource = "MIXED";
    else if (packetsFromRaising > 0) seedSource = "RAISING";
    else seedSource = "COMPANY";

    const linkedOrderObjectIds = orders.map((o) => o._id);

    let raisingIntakeIds = [];
    if (packetsFromRaising > 0) {
      const { allocateRaisingPackets } = await import(
        "./raisingSeed.controller.js"
      );
      const preferredIds = orderPlan?.raisingIntakeId
        ? [orderPlan.raisingIntakeId]
        : [];
      const alloc = await allocateRaisingPackets({
        plantId,
        subtypeId,
        packetsNeeded: packetsFromRaising,
        preferredIntakeIds: preferredIds,
        linkedOrderIds: linkedOrderObjectIds,
      });
      if (alloc.shortfall > 0.001 && packetsFromCompany <= 0) {
        return res.status(400).json({
          success: false,
          message: `Not enough raising seed in hand (need ${packetsFromRaising}, available ${alloc.allocated})`,
        });
      }
      raisingIntakeIds = alloc.intakeIds || [];
      packetsFromRaising = alloc.allocated;
      packetsUsed = packetsFromCompany + packetsFromRaising;
    }

    if (packetsUsed <= 0) {
      packetsUsed = product && cf > 0 ? Math.ceil(plantsSowed / cf) : 0;
      if (seedSource === "RAISING") {
        packetsFromRaising = packetsUsed;
        packetsFromCompany = 0;
      } else {
        packetsFromCompany = packetsUsed;
        packetsFromRaising = 0;
      }
    }

    let slotIds = [
      ...new Set(orders.map((o) => String(o.bookingSlot)).filter(Boolean)),
    ].map((id) => new mongoose.Types.ObjectId(id));

    const bodySlotId =
      req.body.slotId && mongoose.Types.ObjectId.isValid(req.body.slotId)
        ? new mongoose.Types.ObjectId(req.body.slotId)
        : null;
    if (bodySlotId && (isExcessOnly || !slotIds.length)) {
      slotIds = [bodySlotId];
    }

    if (!isExcessOnly && !slotIds.length) {
      return res.status(400).json({
        success: false,
        message: "Order has no booking slot — cannot apply sow to slots",
      });
    }

    const requestNumber = await SowingRequest.generateRequestNumber();
    const userId = req.user._id;
    const pktRecord = Math.max(0, packetsUsed);
    const noProductHint = product ? "" : " · no seed product";

    const request = new SowingRequest({
      requestNumber,
      plantId: new mongoose.Types.ObjectId(plantId),
      plantName: plant.name,
      subtypeId: new mongoose.Types.ObjectId(subtypeId),
      subtypeName: subtype.name,
      ...(product?._id ? { productId: product._id } : {}),
      packetsNeeded: pktRecord,
      packetsRequested: pktRecord,
      excessPackets: 0,
      primaryUnit: product?.primaryUnit?._id,
      secondaryUnit: product?.secondaryUnit?._id,
      conversionFactor: cf,
      unitName:
        product?.primaryUnit?.symbol ||
        product?.primaryUnit?.name ||
        "packets",
      status: "issued",
      requestedBy: userId,
      issuedBy: userId,
      issuedDate: sowedAt,
      notes:
        notes ||
        `Admin direct sow${sowDateHint ? ` · sow ${sowDateHint}` : ""}${
          batchNumber ? ` · batch ${batchNumber}` : ""
        }${isExcessOnly ? " · excess only" : ""}${noProductHint}`,
      linkedSlotIds: slotIds,
      linkedOrderIds: linkedOrderObjectIds,
      isExcessiveSowing: isExcessOnly,
      seedSource,
      packetsFromCompany,
      packetsFromRaising,
      raisingIntakeIds,
      packetsIssued: packetsFromCompany,
      packetsUsed: pktRecord,
      packetsReturned: 0,
      sowedQuantity: plantsSowed,
      laboursLadies,
      laboursGents,
      shedName: shedName || "Office",
      completionNotes:
        notes ||
        `Office/Super Admin direct sow (plants + date; inventory bypassed)${
          batchNumber ? ` · Batch ${batchNumber}` : ""
        }${isExcessOnly ? " · excess only" : ""}${noProductHint}`,
      completedBy: userId,
      sowingCompleted: true,
      sowingCompletedDate: sowedAt,
      sowingInProgress: false,
      remainingSowingNeeded: 0,
      completionEvents: [],
    });

    const cmsReady = await resolveCmsReadyDays(plantId, subtypeId);
    const bodyReady = parseNum(req.body.plantReadyDays, NaN);
    const readyDateHint = String(
      req.body.readyDate || req.body.plantReadyDate || ""
    ).trim();
    const readyDateParsed = parseLocalDate(readyDateHint);

    let plantReadyDays;
    if (readyDateParsed && sowedAt) {
      const s0 = new Date(sowedAt);
      s0.setHours(0, 0, 0, 0);
      const r0 = new Date(readyDateParsed);
      r0.setHours(0, 0, 0, 0);
      const diff = Math.round((r0.getTime() - s0.getTime()) / 86400000);
      if (diff < 0) {
        return res.status(400).json({
          success: false,
          message: "readyDate cannot be before sow date",
        });
      }
      plantReadyDays = diff;
    } else if (Number.isFinite(bodyReady) && bodyReady >= 0) {
      plantReadyDays = bodyReady;
    } else {
      plantReadyDays = Number(subtype.plantReadyDays) || cmsReady;
    }

    if (!(plantReadyDays >= 0) || !Number.isFinite(plantReadyDays)) {
      return res.status(400).json({
        success: false,
        message: "plantReadyDays must be ≥ 0 (or pass readyDate)",
      });
    }
    if (
      plantReadyDays === 0 &&
      !readyDateParsed &&
      !(Number.isFinite(bodyReady) && bodyReady === 0)
    ) {
      // CMS/default must still be > 0 unless explicit readyDate / days=0
      const fallback = Number(subtype.plantReadyDays) || cmsReady;
      if (!(fallback > 0)) {
        return res.status(400).json({
          success: false,
          message: "plantReadyDays must be > 0",
        });
      }
      plantReadyDays = fallback;
    }

    const slotResult = await applyPlantsToLinkedSlots(request, plantsSowed, {
      packetsUsed: pktRecord,
      requestNumber,
      linkedOrderIds: linkedOrderObjectIds,
      isExcessiveSowing: isExcessOnly,
      shedName,
      sowedAt,
      plantReadyDays,
      resolveByReadyDate: true,
      userId,
    });

    pushEvent(request, {
      type: "SOW_COMPLETED",
      by: userId,
      quantity: plantsSowed,
      unit: "plants",
      message: `Admin direct sow: ${plantsSowed} plants, ${pktRecord} pkt (no inventory issue)${noProductHint}`,
      meta: {
        adminBypass: true,
        noSeedProduct: !product,
        excessOnly: isExcessOnly,
        sowDate: toSowYmd(sowedAt) || null,
        plantReadyDays: slotResult.plantReadyDays ?? plantReadyDays,
        plantReadyDate: slotResult.plantReadyDate || null,
        appliedSlotId: slotResult.appliedSlotId
          ? String(slotResult.appliedSlotId)
          : null,
        orderCount: orders.length,
        batchNumber: batchNumber || null,
      },
    });
    if (pktRecord > 0) {
      pushEvent(request, {
        type: "PACKETS_USED",
        by: userId,
        quantity: pktRecord,
        unit: "pkt",
        message: `${pktRecord} packets recorded (inventory not deducted — admin bypass)`,
        meta: { adminBypass: true, batchNumber: batchNumber || null },
      });
    }

    await request.saveWithUniqueRequestNumber();

    const coverPool = sowCoverPool(plantsSowed, plant?.sowingBuffer);
    // Saleable pool only — do not finish orders from mortality buffer.
    const orderResult = await markOrdersSowed(request, {
      sowedAt,
      plantsSowed: coverPool,
      coverPoolAlreadySaleable: true,
      sowingBufferPct: Number(plant?.sowingBuffer) || 0,
      plantReadyDays,
      orderIds: linkedOrderObjectIds?.length
        ? linkedOrderObjectIds
        : requestCoverOrderIds(request),
    });
    const orderCoveredPlants = Math.max(
      0,
      Number(orderResult.orderPlantsCovered) ||
        coverPool - (Number(orderResult.remainingUncovered) || 0)
    );
    const excessPlants = Math.max(0, Number(orderResult.remainingUncovered) || 0);
    if (slotResult.appliedSlotId && !isExcessOnly) {
      await recordExcessPlantsOnSlot(
        slotResult.appliedSlotId,
        request._id,
        excessPlants,
        orderCoveredPlants,
        orderResult.batchLinkedIds || orderResult.markedIds || request.linkedOrderIds || []
      );
    }
    pushEvent(request, {
      type: "ORDERS_MARKED_SOWED",
      by: userId,
      quantity: orderResult.marked,
      unit: "orders",
      message: `${orderResult.marked} included orders marked sowingDone`,
      meta: {
        remainingUncovered: orderResult.remainingUncovered ?? 0,
        plantsSowed,
        orderCoveredPlants,
        excessPlants,
        readyDate: orderResult.readyDate || null,
        plantReadyDays: orderResult.plantReadyDays ?? plantReadyDays,
        eligibleCount: orderResult.eligibleCount ?? 0,
      },
    });
    await request.save();

    setImmediate(() => {
      import("./sowingCardsLite.controller.js")
        .then((m) => m.bustTodaySowingCardsLiteCache?.())
        .catch(() => {});
    });

    return res.status(201).json({
      success: true,
      message: product
        ? "Direct sow saved (packet issue bypassed)"
        : "Direct sow saved (plants + date; no seed product)",
      data: {
        requestId: request._id,
        requestNumber: request.requestNumber,
        plantsSowed,
        packetsUsed: pktRecord,
        noSeedProduct: !product,
        excessOnly: isExcessOnly,
        orderCoveredPlants,
        excessPlants: reportedExcess({
          plantsSowed,
          orderCoveredPlants,
          sowingBufferPct: plant?.sowingBuffer,
        }),
        slotsUpdated: slotResult.slotsUpdated || 0,
        ordersMarked: orderResult.marked,
        sowingDate: slotResult.sowingDate,
        plantReadyDays: slotResult.plantReadyDays ?? plantReadyDays,
        plantReadyDate: slotResult.plantReadyDate,
        appliedSlotId: slotResult.appliedSlotId
          ? String(slotResult.appliedSlotId)
          : null,
        resolvedByReadyDate: Boolean(slotResult.resolvedByReadyDate),
        actualPlants: slotResult.actualPlants ?? null,
        expectedMortality: slotResult.expectedMortality ?? null,
      },
    });
  } catch (error) {
    console.error("submitDirectSow:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to save direct sow",
      error: error.message,
    });
  }
};

/**
 * POST /sowing/ready-plants-sow
 * Create ready-plants sowing entry + excess (same split as complete-sow).
 *
 * pendingReceive=true (Gap Analysis pre-order): no truck batch yet →
 * readyPlantsReceived=false on the slot batch; labour optional.
 * Otherwise (legacy one-shot receive): batchNumber + labour required,
 * readyPlantsReceived=true.
 */
export const submitReadyPlantsSow = async (req, res) => {
  try {
    const pendingReceive =
      req.body.pendingReceive === true ||
      req.body.pendingReceive === "true" ||
      req.body.readyPlantsReceived === false ||
      req.body.readyPlantsReceived === "false";

    const plantId =
      req.body.plantId && mongoose.Types.ObjectId.isValid(req.body.plantId)
        ? String(req.body.plantId)
        : null;
    const subtypeId =
      req.body.subtypeId && mongoose.Types.ObjectId.isValid(req.body.subtypeId)
        ? String(req.body.subtypeId)
        : null;
    if (!plantId || !subtypeId) {
      return res.status(400).json({
        success: false,
        message: "plantId and subtypeId are required",
      });
    }

    const plantsSowed = Math.max(0, parseNum(req.body.plantsSowed, NaN));
    if (!Number.isFinite(plantsSowed) || plantsSowed <= 0) {
      return res.status(400).json({
        success: false,
        message: "plantsSowed must be > 0",
      });
    }

    let shedName =
      String(
        req.body.shedName || req.body.pollyhouse || req.body.shed || ""
      ).trim() || "";
    // Pending (Gap) may omit shed — truck receive stamps the real shed.
    if (!shedName && pendingReceive) {
      shedName = "Pending receive";
    }
    if (!shedName) {
      return res.status(400).json({
        success: false,
        message: "shedName is required",
      });
    }

    let batchNumber = String(req.body.batchNumber || "").trim();
    if (!pendingReceive && !batchNumber) {
      return res.status(400).json({
        success: false,
        message: "batchNumber is required",
      });
    }

    const laboursLadies = Math.max(0, parseNum(req.body.laboursLadies));
    const laboursGents = Math.max(0, parseNum(req.body.laboursGents));
    if (!pendingReceive && laboursLadies + laboursGents < 1) {
      return res.status(400).json({
        success: false,
        message: "Enter ladies or gents labour (≥ 1)",
      });
    }

    const sowDateHint = String(
      req.body.sowDate || req.body.sowingDate || req.body.date || ""
    ).trim();
    const sowedAt = parseLocalDate(sowDateHint) || istTodayNoon();

    const plant = await PlantCms.findById(plantId)
      .select("name subtypes sowingAllowed sowingBuffer")
      .lean();
    if (!plant?.sowingAllowed) {
      return res.status(400).json({
        success: false,
        message: "Plant is not sowing-allowed (use Planting Ready / lagwad)",
      });
    }
    const subtype = (plant.subtypes || []).find(
      (s) => String(s._id) === subtypeId
    );
    if (!subtype) {
      return res.status(404).json({ success: false, message: "Subtype not found" });
    }

    const cmsReady = await resolveCmsReadyDays(plantId, subtypeId);
    const bodyReady = parseNum(req.body.plantReadyDays, NaN);
    const readyDateHint = String(
      req.body.readyDate || req.body.plantReadyDate || ""
    ).trim();
    const readyDateParsed = parseLocalDate(readyDateHint);

    let plantReadyDays;
    if (readyDateParsed && sowedAt) {
      const s0 = new Date(sowedAt);
      s0.setHours(0, 0, 0, 0);
      const r0 = new Date(readyDateParsed);
      r0.setHours(0, 0, 0, 0);
      const diff = Math.round((r0.getTime() - s0.getTime()) / 86400000);
      // Ready plants may be same-day (diff 0) — excess on that ready date.
      if (diff < 0) {
        return res.status(400).json({
          success: false,
          message: "readyDate cannot be before sow date",
        });
      }
      plantReadyDays = diff;
    } else if (Number.isFinite(bodyReady) && bodyReady >= 0) {
      plantReadyDays = bodyReady;
    } else if (pendingReceive) {
      // Already-ready plants: no grow cycle — ready day is the excess day.
      plantReadyDays = 0;
    } else {
      plantReadyDays = Number(subtype.plantReadyDays) || cmsReady;
    }
    if (!(plantReadyDays >= 0) || !Number.isFinite(plantReadyDays)) {
      return res.status(400).json({
        success: false,
        message: "plantReadyDays must be ≥ 0",
      });
    }
    if (
      !pendingReceive &&
      plantReadyDays === 0 &&
      !readyDateParsed &&
      !(Number.isFinite(bodyReady) && bodyReady === 0)
    ) {
      const fallback = Number(subtype.plantReadyDays) || cmsReady;
      if (!(fallback > 0)) {
        return res.status(400).json({
          success: false,
          message: "plantReadyDays must be > 0",
        });
      }
      plantReadyDays = fallback;
    }

    const bodySlotId =
      req.body.slotId && mongoose.Types.ObjectId.isValid(req.body.slotId)
        ? new mongoose.Types.ObjectId(req.body.slotId)
        : null;
    const slotIds = bodySlotId ? [bodySlotId] : [];

    const product = await resolveSeedProduct(plantId, subtypeId);
    const requestNumber = await SowingRequest.generateRequestNumber();
    if (pendingReceive && !batchNumber) {
      batchNumber = `PENDING-${requestNumber}`;
    }
    const userId = req.user._id;
    const notes = String(req.body.notes || "").trim();
    const noteLine =
      notes ||
      (pendingReceive
        ? `Ready plants · not received · ${plantsSowed} plants`
        : `Ready plants sow · batch ${batchNumber} · ${plantsSowed} plants`);

    const request = new SowingRequest({
      requestNumber,
      plantId: new mongoose.Types.ObjectId(plantId),
      plantName: plant.name,
      subtypeId: new mongoose.Types.ObjectId(subtypeId),
      subtypeName: subtype.name,
      ...(product?._id ? { productId: product._id } : {}),
      packetsNeeded: 0,
      packetsRequested: 0,
      excessPackets: 0,
      primaryUnit: product?.primaryUnit?._id,
      secondaryUnit: product?.secondaryUnit?._id,
      conversionFactor: Number(product?.conversionFactor) || 1,
      unitName:
        product?.primaryUnit?.symbol ||
        product?.primaryUnit?.name ||
        "packets",
      status: "issued",
      requestedBy: userId,
      issuedBy: userId,
      issuedDate: sowedAt,
      notes: noteLine,
      linkedSlotIds: slotIds,
      linkedOrderIds: [],
      isExcessiveSowing: true,
      seedSource: "COMPANY",
      packetsFromCompany: 0,
      packetsFromRaising: 0,
      raisingIntakeIds: [],
      packetsIssued: 0,
      packetsUsed: 0,
      packetsReturned: 0,
      sowedQuantity: plantsSowed,
      laboursLadies,
      laboursGents,
      shedName,
      completionNotes: noteLine,
      completedBy: userId,
      sowingCompleted: true,
      sowingCompletedDate: sowedAt,
      sowingInProgress: false,
      remainingSowingNeeded: 0,
      completionEvents: [],
    });

    const slotResult = await applyPlantsToLinkedSlots(request, plantsSowed, {
      packetsUsed: 0,
      requestNumber,
      linkedOrderIds: [],
      isExcessiveSowing: true,
      // Ready plants are already grown — no expected mortality reserve.
      mortalityPct: 0,
      shedName,
      sowedAt,
      plantReadyDays,
      resolveByReadyDate: true,
      userId,
      batchNumber,
      readyPlantsReceived: !pendingReceive,
      laboursLadies,
      laboursGents,
    });

    pushEvent(request, {
      type: "SOW_COMPLETED",
      by: userId,
      quantity: plantsSowed,
      unit: "plants",
      message: pendingReceive
        ? `Ready plants pending receive: ${plantsSowed} plants`
        : `Ready plants sow: ${plantsSowed} plants · batch ${batchNumber}`,
      meta: {
        readyPlantsImport: true,
        pendingReceive: Boolean(pendingReceive),
        readyPlantsReceived: !pendingReceive,
        excessOnly: true,
        sowDate: toSowYmd(sowedAt) || null,
        plantReadyDays: slotResult.plantReadyDays ?? plantReadyDays,
        plantReadyDate: slotResult.plantReadyDate || null,
        appliedSlotId: slotResult.appliedSlotId
          ? String(slotResult.appliedSlotId)
          : null,
        batchNumber,
      },
    });

    await request.saveWithUniqueRequestNumber();

    setImmediate(() => {
      import("./sowingCardsLite.controller.js")
        .then((m) => m.bustTodaySowingCardsLiteCache?.())
        .catch(() => {});
    });

    return res.status(201).json({
      success: true,
      message: pendingReceive
        ? "Ready plants sowing entry created (not received)"
        : "Ready plants saved as sowing entry",
      data: {
        requestId: request._id,
        requestNumber: request.requestNumber,
        plantsSowed,
        excessOnly: true,
        batchNumber,
        pendingReceive: Boolean(pendingReceive),
        readyPlantsReceived: !pendingReceive,
        slotsUpdated: slotResult.slotsUpdated || 0,
        sowingDate: slotResult.sowingDate,
        plantReadyDays: slotResult.plantReadyDays ?? plantReadyDays,
        plantReadyDate: slotResult.plantReadyDate,
        appliedSlotId: slotResult.appliedSlotId
          ? String(slotResult.appliedSlotId)
          : null,
        resolvedByReadyDate: Boolean(slotResult.resolvedByReadyDate),
        actualPlants: slotResult.actualPlants ?? null,
        expectedMortality: slotResult.expectedMortality ?? null,
      },
    });
  } catch (error) {
    console.error("submitReadyPlantsSow:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to save ready plants sow",
      error: error.message,
    });
  }
};

/**
 * POST /sowing/ready-plants-receive
 * Truck arrival: stamp batch number, received qty, ladies on a not-received
 * ready-plants sowing batch and flip readyPlantsReceived=true.
 */
export const submitReadyPlantsReceive = async (req, res) => {
  try {
    const requestId =
      req.body.requestId && mongoose.Types.ObjectId.isValid(req.body.requestId)
        ? String(req.body.requestId)
        : null;
    const slotId =
      req.body.slotId && mongoose.Types.ObjectId.isValid(req.body.slotId)
        ? String(req.body.slotId)
        : null;
    const batchId =
      req.body.batchId && mongoose.Types.ObjectId.isValid(req.body.batchId)
        ? String(req.body.batchId)
        : null;
    if (!requestId && !(slotId && batchId)) {
      return res.status(400).json({
        success: false,
        message: "requestId or (slotId + batchId) required",
      });
    }

    const batchNumber = String(req.body.batchNumber || "").trim();
    if (!batchNumber || /^PENDING-/i.test(batchNumber)) {
      return res.status(400).json({
        success: false,
        message: "Enter the truck batch number",
      });
    }

    const plants = Math.max(0, Math.floor(parseNum(req.body.plants, NaN)));
    if (!Number.isFinite(plants) || plants <= 0) {
      return res.status(400).json({
        success: false,
        message: "plants must be > 0",
      });
    }

    const laboursLadies = Math.max(0, parseNum(req.body.laboursLadies));
    const laboursGents = Math.max(0, parseNum(req.body.laboursGents));
    if (laboursLadies + laboursGents < 1) {
      return res.status(400).json({
        success: false,
        message: "Enter ladies or gents labour (≥ 1)",
      });
    }

    const shedName = String(
      req.body.shedName || req.body.pollyhouse || req.body.shed || ""
    ).trim();
    if (!shedName || /^pending/i.test(shedName)) {
      return res.status(400).json({
        success: false,
        message: "Select shed / polyhouse",
      });
    }

    // Optional ready-date override (no plantReadyDays input — dates only).
    const readyDateHintEarly = String(
      req.body.readyDate || req.body.plantReadyDate || ""
    ).trim();
    const readyDateParsedEarly = parseLocalDate(readyDateHintEarly);

    let slotDoc = null;
    let stIdx = -1;
    let slIdx = -1;
    let batchIdx = -1;
    let batch = null;

    if (slotId && batchId) {
      slotDoc = await PlantSlot.findOne({ "subtypeSlots.slots._id": slotId });
      if (!slotDoc) {
        return res.status(404).json({ success: false, message: "Slot not found" });
      }
      for (let i = 0; i < (slotDoc.subtypeSlots || []).length; i++) {
        const st = slotDoc.subtypeSlots[i];
        for (let j = 0; j < (st.slots || []).length; j++) {
          if (String(st.slots[j]._id) !== slotId) continue;
          const batches = st.slots[j].sowingBatches || [];
          const bi = batches.findIndex((b) => String(b._id) === batchId);
          if (bi >= 0) {
            stIdx = i;
            slIdx = j;
            batchIdx = bi;
            batch = batches[bi];
          }
        }
      }
    } else {
      const rows = await findSowBatchForRequest(requestId);
      const row =
        (rows || []).find((r) => r.batch && r.batch.readyPlantsReceived === false) ||
        (rows || [])[0];
      if (!row?.batch || !row.slotId) {
        return res.status(404).json({
          success: false,
          message: "Sowing batch not found for this request",
        });
      }
      slotDoc = await PlantSlot.findById(row._id);
      if (!slotDoc) {
        slotDoc = await PlantSlot.findOne({
          "subtypeSlots.slots._id": row.slotId,
        });
      }
      if (!slotDoc) {
        return res.status(404).json({ success: false, message: "Slot not found" });
      }
      const wantSlot = String(row.slotId);
      const wantBatch = String(row.batch._id);
      for (let i = 0; i < (slotDoc.subtypeSlots || []).length; i++) {
        const st = slotDoc.subtypeSlots[i];
        for (let j = 0; j < (st.slots || []).length; j++) {
          if (String(st.slots[j]._id) !== wantSlot) continue;
          const batches = st.slots[j].sowingBatches || [];
          const bi = batches.findIndex((b) => String(b._id) === wantBatch);
          if (bi >= 0) {
            stIdx = i;
            slIdx = j;
            batchIdx = bi;
            batch = batches[bi];
          }
        }
      }
    }

    if (!batch || stIdx < 0 || slIdx < 0 || batchIdx < 0) {
      return res.status(404).json({ success: false, message: "Batch not found on slot" });
    }
    if (batch.readyPlantsReceived !== false) {
      return res.status(400).json({
        success: false,
        message: "This entry is already received",
      });
    }

    // Keep order/sow date from the pending entry; ready date may change on receive.
    const orderSowAt =
      parseLocalDate(batch.sowingDate) ||
      (batch.sowedAt ? new Date(batch.sowedAt) : null) ||
      istTodayNoon();
    const readyAt =
      readyDateParsedEarly ||
      parseLocalDate(batch.plantReadyDate) ||
      orderSowAt;
    const s0 = new Date(orderSowAt);
    s0.setHours(0, 0, 0, 0);
    const r0 = new Date(readyAt);
    r0.setHours(0, 0, 0, 0);
    if (r0.getTime() < s0.getTime()) {
      return res.status(400).json({
        success: false,
        message: "readyDate cannot be before order/sow date",
      });
    }
    const readyDays = Math.round((r0.getTime() - s0.getTime()) / 86400000);
    const sowingDateStr = fmtDDMMYYYY(orderSowAt);
    const plantReadyDateStr = fmtDDMMYYYY(readyAt);

    // If ready date moved to another calendar window, reslot first.
    const prevReadyStr = String(batch.plantReadyDate || "");
    const reqOidForMove = batch.sowingRequestId || requestId;
    if (
      plantReadyDateStr !== prevReadyStr &&
      reqOidForMove &&
      mongoose.Types.ObjectId.isValid(String(reqOidForMove))
    ) {
      const curSlotId = String(slotDoc.subtypeSlots[stIdx].slots[slIdx]._id);
      const requestForMove = await SowingRequest.findById(reqOidForMove);
      const plantForSlot = requestForMove?.plantId || slotDoc.plantId;
      const subtypeForSlot =
        requestForMove?.subtypeId ||
        slotDoc.subtypeSlots?.[stIdx]?.subtypeId;
      const target = await findSlotByPlantReadyDate(
        plantForSlot,
        subtypeForSlot,
        plantReadyDateStr
      );
      if (
        requestForMove &&
        target?.slotId &&
        String(target.slotId) !== curSlotId
      ) {
        await editSowEntryOnSlots(requestForMove, {
          by: req.user?._id || null,
          sowDate: sowingDateStr,
          plantReadyDate: plantReadyDateStr,
          plantsSowed: plants,
          reason: "READY_PLANTS_RECEIVE_READY_DATE",
        });
        await requestForMove.save();
        // Reload batch on the new slot.
        const rows = await findSowBatchForRequest(reqOidForMove);
        const row = (rows || [])[0];
        if (!row?.batch || !row.slotId) {
          return res.status(404).json({
            success: false,
            message: "Batch not found after ready-date move",
          });
        }
        slotDoc = await PlantSlot.findOne({
          "subtypeSlots.slots._id": row.slotId,
        });
        if (!slotDoc) {
          return res.status(404).json({
            success: false,
            message: "Slot not found after ready-date move",
          });
        }
        stIdx = -1;
        slIdx = -1;
        batchIdx = -1;
        batch = null;
        const wantSlot = String(row.slotId);
        const wantBatch = String(row.batch._id);
        for (let i = 0; i < (slotDoc.subtypeSlots || []).length; i++) {
          const st = slotDoc.subtypeSlots[i];
          for (let j = 0; j < (st.slots || []).length; j++) {
            if (String(st.slots[j]._id) !== wantSlot) continue;
            const batches = st.slots[j].sowingBatches || [];
            const bi = batches.findIndex((b) => String(b._id) === wantBatch);
            if (bi >= 0) {
              stIdx = i;
              slIdx = j;
              batchIdx = bi;
              batch = batches[bi];
            }
          }
        }
        if (!batch) {
          return res.status(404).json({
            success: false,
            message: "Batch not found after ready-date move",
          });
        }
      } else if (requestForMove && plantReadyDateStr !== prevReadyStr) {
        // Same slot window — still stamp new ready date / days on the request path below.
        batch.plantReadyDate = plantReadyDateStr;
        batch.plantReadyDays = readyDays;
      }
    }

    // Recompute deltas after possible reslot (batch qty may already match plants).
    const prevPlants2 = Math.max(0, Math.floor(Number(batch.plantsSowed) || 0));
    const prevAvail2 = Math.max(
      0,
      Math.floor(Number(batch.availablePlantsApplied) || 0)
    );
    const prevActual2 = Math.max(
      0,
      Math.floor(Number(batch.actualPlantsApplied) || 0)
    );
    const prevMort2 = Math.max(
      0,
      Math.floor(Number(batch.expectedMortalityApplied) || 0)
    );

    // Ready plants: full qty is saleable excess — no expected mortality.
    const impact = sowQtySlotImpact(plants, { isExcess: true, mortalityPct: 0 });
    const deltaAvail = impact.availablePlants - prevAvail2;
    const deltaActual = impact.actualPlants - prevActual2;
    const deltaMort = impact.expectedMortality - prevMort2;
    const deltaPlants = plants - prevPlants2;

    batch.batchNumber = batchNumber;
    batch.plantsSowed = plants;
    batch.excessPlants = plants;
    batch.shownExcess = plants;
    batch.orderCoveredPlants = 0;
    batch.availablePlantsApplied = impact.availablePlants;
    batch.actualPlantsApplied = impact.actualPlants;
    batch.expectedMortalityApplied = impact.expectedMortality;
    batch.mortalityPct = 0;
    batch.noMortalityReserve = true;
    batch.sowingBufferPct = 0;
    batch.bufferPlants = 0;
    batch.laboursLadies = laboursLadies;
    batch.laboursGents = laboursGents;
    batch.readyPlantsReceived = true;
    batch.readyPlantsReceivedAt = new Date();
    // Keep order sow date; ready date is the excess day (editable on receive).
    batch.sowedAt = orderSowAt;
    batch.sowingDate = sowingDateStr;
    batch.plantReadyDays = readyDays;
    batch.plantReadyDate = plantReadyDateStr;
    batch.shedName = shedName;

    const slot = slotDoc.subtypeSlots[stIdx].slots[slIdx];
    if (deltaPlants !== 0) {
      slot.plantsSowed = Math.max(0, (Number(slot.plantsSowed) || 0) + deltaPlants);
      slot.totalPlants = Math.max(0, (Number(slot.totalPlants) || 0) + deltaPlants);
    }
    if (deltaActual !== 0) {
      slot.actualPlants = Math.max(0, (Number(slot.actualPlants) || 0) + deltaActual);
    }
    if (deltaMort !== 0) {
      slot.expectedMortality = Math.max(
        0,
        (Number(slot.expectedMortality) || 0) + deltaMort
      );
    }
    if (deltaAvail !== 0) {
      slot.availablePlants = Math.max(
        0,
        (Number(slot.availablePlants) || 0) + deltaAvail
      );
      if (slot.excessiveSowing && typeof slot.excessiveSowing === "object") {
        slot.excessiveSowing.plants = Math.max(
          0,
          (Number(slot.excessiveSowing.plants) || 0) + deltaAvail
        );
      }
    }
    slot.sowingDate = sowingDateStr;
    slot.plantReadyDate = plantReadyDateStr;
    slot.plantReadyDays = readyDays;

    slotDoc.markModified("subtypeSlots");
    await slotDoc.save();

    const reqOid = batch.sowingRequestId || requestId;
    if (reqOid && mongoose.Types.ObjectId.isValid(String(reqOid))) {
      const request = await SowingRequest.findById(reqOid);
      if (request) {
        request.sowedQuantity = plants;
        request.laboursLadies = laboursLadies;
        request.laboursGents = laboursGents;
        request.shedName = shedName;
        request.sowingCompletedDate = orderSowAt;
        request.completionNotes = `Ready plants received · batch ${batchNumber} · ${plants} plants · shed ${shedName} · ready ${plantReadyDateStr}`;
        pushEvent(request, {
          type: "SOW_COMPLETED",
          by: req.user?._id || null,
          quantity: plants,
          unit: "plants",
          message: `Ready plants received · batch ${batchNumber}: ${plants} plants · shed ${shedName} · ready ${plantReadyDateStr}`,
          meta: {
            readyPlantsReceived: true,
            batchNumber,
            batchId: String(batch._id),
            slotId: String(slot._id),
            laboursLadies,
            laboursGents,
            shedName,
            sowDate: sowingDateStr,
            plantReadyDate: plantReadyDateStr,
          },
        });
        await request.save();
      }
    }

    setImmediate(() => {
      import("./sowingCardsLite.controller.js")
        .then((m) => m.bustTodaySowingCardsLiteCache?.())
        .catch(() => {});
    });

    return res.status(200).json({
      success: true,
      message: "Ready plants received",
      data: {
        batchId: String(batch._id),
        slotId: String(slot._id),
        batchNumber,
        plants,
        readyPlantsReceived: true,
        laboursLadies,
        laboursGents,
        shedName,
        sowingDate: sowingDateStr,
        plantReadyDays: readyDays,
        plantReadyDate: plantReadyDateStr,
      },
    });
  } catch (error) {
    console.error("submitReadyPlantsReceive:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to receive ready plants",
      error: error.message,
    });
  }
};
