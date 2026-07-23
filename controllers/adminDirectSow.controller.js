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
} from "./sowingCompleteHelpers.js";

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
  // dateStr: YYYY-MM-DD (local calendar day → UTC bounds for Date fields)
  const [y, m, d] = String(dateStr || "")
    .split("-")
    .map((n) => parseInt(n, 10));
  if (!y || !m || !d) return null;
  const start = new Date(y, m - 1, d, 0, 0, 0, 0);
  const end = new Date(y, m - 1, d, 23, 59, 59, 999);
  return { start, end };
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
 * GET /sowing/admin-direct-sow/orders?date=YYYY-MM-DD
 * Orders with deliveryDate on that day (sowing-allowed plants), not yet sowingDone.
 */
export const listDirectSowOrders = async (req, res) => {
  try {
    if (!isOfficeOrSuper(req.user)) {
      return res.status(403).json({
        success: false,
        message: "Only Office Admin or Super Admin can use direct sow portal",
      });
    }

    const range = dayRange(req.query.date);
    if (!range) {
      return res.status(400).json({
        success: false,
        message: "Query date=YYYY-MM-DD is required",
      });
    }

    const plants = await PlantCms.find({ sowingAllowed: true })
      .select("_id name subtypes._id subtypes.name subtypes.plantReadyDays")
      .lean();
    const plantIds = plants.map((p) => p._id);
    if (!plantIds.length) {
      return res.json({ success: true, date: req.query.date, items: [], total: 0 });
    }

    const plantMap = new Map(plants.map((p) => [String(p._id), p]));

    const orders = await Order.find({
      plantName: { $in: plantIds },
      deliveryDate: { $gte: range.start, $lte: range.end },
      sowingDone: { $ne: true },
      orderStatus: { $nin: ["CANCELLED", "TEMPORARY_CANCELLED", "REJECTED", "DELETED"] },
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
      return {
        orderId: o._id,
        orderNumber: o.orderId,
        farmerName: o.farmer?.name || o.name || "",
        farmerMobile: o.farmer?.mobileNumber || "",
        plantId: o.plantName,
        plantName: plant?.name || "",
        subtypeId: o.plantSubtype,
        subtypeName: st?.name || "",
        plantReadyDays: Number(st?.plantReadyDays) || 0,
        slotId: o.bookingSlot,
        plants: plantsQty,
        deliveryDate: o.deliveryDate,
        seedSource: o.sowingPlan?.seedSource || "COMPANY",
        companySeedPackets: Number(o.sowingPlan?.companySeedPackets) || 0,
        raisingSeedPackets: Number(o.sowingPlan?.raisingSeedPackets) || 0,
      };
    });

    // Group helper for UI
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

    const groups = [...groupsMap.values()].map((g) => ({
      ...g,
      slotIds: [...g.slotIds],
    }));

    return res.json({
      success: true,
      date: req.query.date,
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
 * Bypass request → issue. Creates completed sow entry + applies slots + marks orders.
 * Body: { date, orderIds[], plantsSowed?, packetsUsed?, shedName, notes?, laboursLadies?, laboursGents? }
 * Plants default = sum of selected order plants. Packets optional (recorded only — no inventory).
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
    if (!orderIds.length) {
      return res.status(400).json({
        success: false,
        message: "Select at least one order",
      });
    }

    const shedName = String(
      req.body.shedName || req.body.pollyhouse || req.body.shed || "Office"
    ).trim() || "Office";

    const notes = String(req.body.notes || req.body.completionNotes || "").trim();
    const batchNumber = String(req.body.batchNumber || "").trim();
    const laboursLadies = Math.max(0, parseNum(req.body.laboursLadies));
    const laboursGents = Math.max(0, parseNum(req.body.laboursGents));
    const sowDateHint = String(req.body.date || "").trim();

    const orders = await Order.find({
      _id: { $in: orderIds.map((id) => new mongoose.Types.ObjectId(id)) },
      sowingDone: { $ne: true },
      orderStatus: { $nin: ["CANCELLED", "TEMPORARY_CANCELLED", "REJECTED", "DELETED"] },
    })
      .select(
        "orderId plantName plantSubtype bookingSlot numberOfPlants additionalPlants deliveryDate"
      )
      .lean();

    if (!orders.length) {
      return res.status(400).json({
        success: false,
        message: "No eligible unsowed orders found",
      });
    }

    // One plant+subtype per submit (UI groups that way)
    const plantId = String(orders[0].plantName);
    const subtypeId = String(orders[0].plantSubtype);
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

    const plant = await PlantCms.findById(plantId).select("name subtypes sowingAllowed").lean();
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
    if (!product) {
      return res.status(400).json({
        success: false,
        message: "No active seed packing (product) for this plant/subtype",
      });
    }

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

    const cf = Number(product.conversionFactor) || 1;
    let packetsUsed = Math.max(0, parseNum(req.body.packetsUsed, NaN));
    if (!Number.isFinite(packetsUsed)) {
      packetsUsed = cf > 0 ? Math.ceil(plantsSowed / cf) : 0;
    }

    const slotIds = [
      ...new Set(
        orders.map((o) => String(o.bookingSlot)).filter(Boolean)
      ),
    ].map((id) => new mongoose.Types.ObjectId(id));

    const linkedOrderObjectIds = orders.map((o) => o._id);
    const requestNumber = await SowingRequest.generateRequestNumber();
    const userId = req.user._id;

    const request = new SowingRequest({
      requestNumber,
      plantId: new mongoose.Types.ObjectId(plantId),
      plantName: plant.name,
      subtypeId: new mongoose.Types.ObjectId(subtypeId),
      subtypeName: subtype.name,
      productId: product._id,
      packetsNeeded: Math.max(0.01, packetsUsed || plantsSowed / (cf || 1)),
      packetsRequested: Math.max(0.01, packetsUsed || plantsSowed / (cf || 1)),
      excessPackets: 0,
      primaryUnit: product.primaryUnit?._id,
      secondaryUnit: product.secondaryUnit?._id,
      conversionFactor: cf,
      unitName:
        product.primaryUnit?.symbol ||
        product.primaryUnit?.name ||
        "packets",
      status: "issued",
      requestedBy: userId,
      issuedBy: userId,
      issuedDate: new Date(),
      notes:
        notes ||
        `Admin direct sow${sowDateHint ? ` · delivery ${sowDateHint}` : ""}${
          batchNumber ? ` · batch ${batchNumber}` : ""
        }`,
      linkedSlotIds: slotIds,
      linkedOrderIds: linkedOrderObjectIds,
      isExcessiveSowing: false,
      seedSource: "COMPANY",
      packetsFromCompany: packetsUsed,
      packetsFromRaising: 0,
      packetsIssued: packetsUsed,
      packetsUsed,
      packetsReturned: 0,
      sowedQuantity: plantsSowed,
      laboursLadies,
      laboursGents,
      shedName: shedName || "Office",
      completionNotes:
        notes ||
        `Office/Super Admin direct sow (bypassed packet issue)${
          batchNumber ? ` · Batch ${batchNumber}` : ""
        }`,
      completedBy: userId,
      sowingCompleted: true,
      sowingCompletedDate: new Date(),
      sowingInProgress: false,
      remainingSowingNeeded: 0,
      completionEvents: [],
    });

    pushEvent(request, {
      type: "SOW_COMPLETED",
      by: userId,
      quantity: plantsSowed,
      unit: "plants",
      message: `Admin direct sow: ${plantsSowed} plants, ${packetsUsed} pkt (no inventory issue)`,
      meta: {
        adminBypass: true,
        deliveryDate: sowDateHint || null,
        orderCount: orders.length,
        batchNumber: batchNumber || null,
      },
    });
    pushEvent(request, {
      type: "PACKETS_USED",
      by: userId,
      quantity: packetsUsed,
      unit: "pkt",
      message: `${packetsUsed} packets recorded (inventory not deducted — admin bypass)`,
      meta: { adminBypass: true, batchNumber: batchNumber || null },
    });

    // Slots first (same helper as complete-sow)
    const slotResult = await applyPlantsToLinkedSlots(request, plantsSowed, {
      packetsUsed,
      requestNumber,
      linkedOrderIds: linkedOrderObjectIds,
      isExcessiveSowing: false,
      shedName,
    });

    await request.save();

    const orderResult = await markOrdersSowed(request);
    pushEvent(request, {
      type: "ORDERS_MARKED_SOWED",
      by: userId,
      quantity: orderResult.marked,
      unit: "orders",
      message: `${orderResult.marked} orders marked sowingDone`,
    });
    await request.save();

    // Bust lite cache
    setImmediate(() => {
      import("./sowingCardsLite.controller.js")
        .then((m) => m.bustTodaySowingCardsLiteCache?.())
        .catch(() => {});
    });

    return res.status(201).json({
      success: true,
      message: "Direct sow saved (packet issue bypassed)",
      data: {
        requestId: request._id,
        requestNumber: request.requestNumber,
        plantsSowed,
        packetsUsed,
        slotsUpdated: slotResult.slotsUpdated || 0,
        ordersMarked: orderResult.marked,
        sowingDate: slotResult.sowingDate,
        plantReadyDays: Number(subtype.plantReadyDays) || 0,
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
