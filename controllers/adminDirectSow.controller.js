import mongoose from "mongoose";
import Order from "../models/order.model.js";
import PlantCms from "../models/plantCms.model.js";
import Product from "../models/product.model.js";
import SowingRequest from "../models/sowingRequest.model.js";
import {
  parseNum,
  pushEvent,
  applyPlantsToLinkedSlots,
  markOrdersSowed,
  recordExcessPlantsOnSlot,
} from "./sowingCompleteHelpers.js";
import {
  resolveCmsReadyDays,
  fmtDDMMYYYY,
  addDays,
  parseLocalDate as parseLocalDateHelper,
} from "./sowingSlotReadyHelpers.js";
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

    const orders = await Order.find({
      plantName: { $in: plantIds },
      ...(subtypeIds.length ? { plantSubtype: { $in: subtypeIds } } : {}),
      sowingDone: { $ne: true },
      orderStatus: {
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

    if (!orderIds.length && !(bodyPlantId && bodySubtypeId)) {
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
    const sowedAt = parseLocalDate(sowDateHint) || new Date();

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
      .select("name subtypes sowingAllowed")
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
        message: "plantsSowed must be > 0",
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
        sowDate: sowDateHint || null,
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

    await request.save();

    const orderResult = await markOrdersSowed(request, {
      sowedAt,
      plantsSowed,
      plantReadyDays,
      orderIds: linkedOrderObjectIds,
    });
    const excessPlants = Math.max(
      0,
      Number(orderResult.remainingUncovered) || 0
    );
    const orderCoveredPlants = Math.max(0, plantsSowed - excessPlants);
    if (slotResult.appliedSlotId) {
      await recordExcessPlantsOnSlot(
        slotResult.appliedSlotId,
        request._id,
        excessPlants,
        orderCoveredPlants,
        orderResult.markedIds || request.linkedOrderIds || []
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
        excessPlants,
        slotsUpdated: slotResult.slotsUpdated || 0,
        ordersMarked: orderResult.marked,
        sowingDate: slotResult.sowingDate,
        plantReadyDays: slotResult.plantReadyDays ?? plantReadyDays,
        plantReadyDate: slotResult.plantReadyDate,
        appliedSlotId: slotResult.appliedSlotId
          ? String(slotResult.appliedSlotId)
          : null,
        resolvedByReadyDate: Boolean(slotResult.resolvedByReadyDate),
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
