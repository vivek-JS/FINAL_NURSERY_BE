import multer from "multer";
import mongoose from "mongoose";
import SowingRequest from "../models/sowingRequest.model.js";
import Order from "../models/order.model.js";
import InventoryOutward from "../models/inventoryOutward.model.js";
import PlantSlot from "../models/slots.model.js";
import {
  parseNum,
  pushEvent,
  applyPlantsToLinkedSlots,
  settleOutwardAndReturns,
  markOrdersSowed,
  recordExcessPlantsOnSlot,
  reclaimExcessForCoveredOrders,
  uploadCompleteSowPhotos,
  editSowEntryOnSlots,
  companyPacketShare,
  getRemainingCompanyPackets,
} from "./sowingCompleteHelpers.js";
import {
  resolveCmsReadyDays,
  parseLocalDate,
} from "./sowingSlotReadyHelpers.js";
import { resolveSowingPlantsPerPacket } from "../utility/sowingPlantsPerPacket.js";

/** Collect applied slot ids from completion meta + linkedSlotIds. */
function collectSlotIdsFromRequest(r) {
  const ids = new Set();
  for (const id of r.linkedSlotIds || []) {
    if (id && mongoose.Types.ObjectId.isValid(id)) ids.add(String(id));
  }
  for (const ev of r.completionEvents || []) {
    const meta = ev?.meta || {};
    const aid = meta.appliedSlotId || meta.toSlotId || meta.slotId;
    if (aid && mongoose.Types.ObjectId.isValid(aid)) ids.add(String(aid));
  }
  return [...ids];
}

export const completeSowUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 5 },
});

function bustLiteCacheAsync() {
  setImmediate(() => {
    import("./sowingCardsLite.controller.js")
      .then((m) => m.bustTodaySowingCardsLiteCache?.())
      .catch(() => {});
  });
}

/**
 * POST /sowing/request/:requestId/complete-sow
 */
export const completeSowingRequest = async (req, res) => {
  try {
    const { requestId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(requestId)) {
      return res.status(400).json({ success: false, message: "Invalid requestId" });
    }

    const plantsSowed = Math.max(0, parseNum(req.body.plantsSowed));
    const laboursLadies = Math.max(0, parseNum(req.body.laboursLadies));
    const laboursGents = Math.max(0, parseNum(req.body.laboursGents));
    const notes = String(req.body.notes || req.body.completionNotes || "").trim();
    const shedName = String(
      req.body.shedName || req.body.pollyhouse || req.body.shed || ""
    ).trim();
    const completeSowing =
      String(req.body.completeSowing ?? "true").toLowerCase() !== "false";
    const packetsToReturnRaw = parseNum(req.body.packetsToReturn, NaN);
    const hasReturnInput = Number.isFinite(packetsToReturnRaw);

    if (!(plantsSowed > 0) && !(hasReturnInput && packetsToReturnRaw > 0)) {
      return res.status(400).json({
        success: false,
        message: "Enter plantsSowed > 0 and/or packetsToReturn > 0",
      });
    }
    if (!shedName) {
      return res.status(400).json({
        success: false,
        message: "shedName is required (where sowing was done)",
      });
    }

    const locked = await SowingRequest.findOneAndUpdate(
      {
        _id: requestId,
        status: "issued",
        sowingCompleted: { $ne: true },
      },
      { $set: { sowingInProgress: true } },
      { new: true }
    );

    if (!locked) {
      const existing = await SowingRequest.findById(requestId)
        .select("status sowingCompleted requestNumber")
        .lean();
      if (!existing) {
        return res.status(404).json({ success: false, message: "Request not found" });
      }
      if (existing.sowingCompleted) {
        return res.status(400).json({
          success: false,
          message: `Already completed (${existing.requestNumber})`,
        });
      }
      return res.status(400).json({
        success: false,
        message: `Cannot complete. Status must be issued (current: ${existing.status})`,
      });
    }

    try {
      const cf = resolveSowingPlantsPerPacket(locked);
      const expected = Number(
        ((Number(locked.packetsRequested) || 0) * cf).toFixed(0)
      );

      const companyPkts = companyPacketShare(locked);
      const packetsIssued =
        Number(locked.packetsIssued) ||
        Number(locked.packetsRequested) ||
        companyPkts ||
        0;
      const remainingPkt = await getRemainingCompanyPackets(locked);

      // Prefer explicit packetsUsed. Do NOT infer used = remaining − return
      // just because packetsToReturn was sent (0 used to burn all bags).
      let packetsUsed = parseNum(req.body.packetsUsed, NaN);
      let packetsToReturn = hasReturnInput
        ? Math.max(0, packetsToReturnRaw)
        : NaN;

      if (!Number.isFinite(packetsUsed)) {
        const fromPlants = cf > 0 ? plantsSowed / cf : 0;
        packetsUsed = Math.min(remainingPkt, Math.max(0, fromPlants));
      } else {
        packetsUsed = Math.min(remainingPkt, Math.max(0, packetsUsed));
      }

      if (!Number.isFinite(packetsToReturn)) {
        // Complete: auto-return leftover. Partial: leave bags open.
        packetsToReturn = completeSowing
          ? Math.max(0, remainingPkt - packetsUsed)
          : 0;
      } else {
        packetsToReturn = Math.min(
          Math.max(0, remainingPkt - packetsUsed),
          packetsToReturn
        );
        if (completeSowing) {
          // Force-close: any unused after this use must be returned.
          packetsToReturn = Math.max(0, remainingPkt - packetsUsed);
        }
      }

      if (packetsUsed + packetsToReturn > remainingPkt && remainingPkt >= 0) {
        packetsToReturn = Math.max(0, remainingPkt - packetsUsed);
      }

      const userId = req.user._id;
      const cmsReady = await resolveCmsReadyDays(locked.plantId, locked.subtypeId);
      const bodyReady = parseNum(req.body.plantReadyDays, NaN);
      const plantReadyDays =
        Number.isFinite(bodyReady) && bodyReady > 0 ? bodyReady : cmsReady;
      const sowedAt =
        parseLocalDate(req.body.sowDate || req.body.sowingDate) || new Date();

      // Slots first (fail before creating return requests), then inventory + photos in parallel
      const slotResult =
        plantsSowed > 0
          ? await applyPlantsToLinkedSlots(locked, plantsSowed, {
              packetsUsed,
              requestNumber: locked.requestNumber,
              linkedOrderIds: locked.linkedOrderIds,
              isExcessiveSowing: locked.isExcessiveSowing,
              shedName,
              sowedAt,
              plantReadyDays,
              resolveByReadyDate: true,
              userId,
            })
          : { slotsUpdated: 0 };

      const [inv, photos] = await Promise.all([
        settleOutwardAndReturns(locked, packetsUsed, packetsToReturn, userId),
        uploadCompleteSowPhotos(req.files),
      ]);

      const prevSowed = Number(locked.sowedQuantity) || 0;
      locked.sowedQuantity = prevSowed + plantsSowed;
      locked.laboursLadies = laboursLadies;
      locked.laboursGents = laboursGents;
      locked.packetsIssued = packetsIssued;
      locked.packetsUsed = Number(locked.packetsUsed || 0) + (inv.used || 0);
      locked.packetsReturned =
        Number(locked.packetsReturned || 0) + (inv.returned || 0);
      if (inv.returnRequestIds?.length) {
        locked.returnRequestIds = [
          ...(locked.returnRequestIds || []),
          ...inv.returnRequestIds,
        ];
      }
      if (notes) locked.completionNotes = notes;
      locked.shedName = shedName;
      if (photos.length) {
        locked.completionPhotos = [
          ...(locked.completionPhotos || []),
          ...photos,
        ];
      }
      locked.completedBy = userId;

      // Remaining open bags after this settle (0 → auto-complete).
      const remainingAfter = Math.max(
        0,
        remainingPkt - (inv.used || 0) - (inv.returned || 0)
      );
      locked.remainingSowingNeeded = Math.max(
        0,
        expected - locked.sowedQuantity
      );

      const noCompanyLeft =
        companyPkts <= 0
          ? locked.remainingSowingNeeded <= 0
          : remainingAfter <= 0;

      locked.sowingCompleted = Boolean(completeSowing || noCompanyLeft);
      if (locked.sowingCompleted) {
        locked.remainingSowingNeeded = 0;
        locked.sowingCompletedDate = sowedAt;
      }
      // Always release lock so the next partial entry can re-acquire.
      locked.sowingInProgress = false;

      // Mark only orders linked / included on this sowing request (no ±4d auto-cover)
      const orderResult =
        plantsSowed > 0
          ? await markOrdersSowed(locked, {
              sowedAt,
              plantsSowed,
              plantReadyDays,
              orderIds: locked.linkedOrderIds || [],
            })
          : { marked: 0, remainingUncovered: plantsSowed || 0 };

      // Leftover after included orders → saleable availablePlants; covered → orderReservedPlants
      const excessPlants = Math.max(
        0,
        Number(orderResult.remainingUncovered) || 0
      );
      const orderCoveredPlants = Math.max(0, plantsSowed - excessPlants);
      let excessSlotResult = { excessPlants: 0 };
      if (slotResult.appliedSlotId) {
        if (locked.isExcessiveSowing) {
          // Apply already counted all as excess — reclaim what covered nearby orders
          if (orderCoveredPlants > 0) {
            excessSlotResult = await reclaimExcessForCoveredOrders(
              slotResult.appliedSlotId,
              locked._id,
              orderCoveredPlants,
              excessPlants
            );
          } else {
            excessSlotResult = { excessPlants, orderCoveredPlants: 0 };
          }
        } else if (excessPlants > 0 || orderCoveredPlants >= 0) {
          excessSlotResult = await recordExcessPlantsOnSlot(
            slotResult.appliedSlotId,
            locked._id,
            excessPlants,
            orderCoveredPlants,
            orderResult.markedIds || locked.linkedOrderIds || []
          );
        }
      }

      pushEvent(locked, {
        type: locked.sowingCompleted ? "SOW_COMPLETED" : "PLANTS_SOWED",
        by: userId,
        quantity: plantsSowed,
        unit: "plants",
        message: locked.sowingCompleted
          ? "Sowing completed"
          : "Sowing progress saved (bags still open)",
        meta: {
          packetsIssued: locked.packetsIssued,
          packetsUsed: locked.packetsUsed,
          packetsReturned: locked.packetsReturned,
          packetsRemaining: remainingAfter,
          completeSowing,
          sowedQuantity: locked.sowedQuantity,
          orderCoveredPlants,
          excessPlants: excessSlotResult.excessPlants || excessPlants,
          slotsUpdated: slotResult.slotsUpdated,
          plantReadyDays: slotResult.plantReadyDays ?? plantReadyDays,
          plantReadyDate: slotResult.plantReadyDate,
          appliedSlotId: slotResult.appliedSlotId
            ? String(slotResult.appliedSlotId)
            : null,
          resolvedByReadyDate: Boolean(slotResult.resolvedByReadyDate),
          laboursLadies,
          laboursGents,
          ordersMarked: orderResult.marked,
          remainingUncovered: orderResult.remainingUncovered ?? 0,
          orderReadyDate: orderResult.readyDate || null,
          orderPlantReadyDays: orderResult.plantReadyDays ?? plantReadyDays,
          orderCoverWindowDays: orderResult.coverWindowDays ?? 0,
          orderCoverFrom: orderResult.coverFrom || null,
          orderCoverTo: orderResult.coverTo || null,
          photoCount: photos.length,
          shedName,
          notes: notes || undefined,
        },
      });
      for (const evt of inv.events || []) pushEvent(locked, evt);

      await locked.save();
      bustLiteCacheAsync();

      let uncoveredLinkedOrders = [];
      let suggestCoverFromStock = false;
      const finalExcess = excessSlotResult.excessPlants || excessPlants;
      if (finalExcess > 0 && (locked.linkedOrderIds || []).length) {
        const pendingLinked = await Order.find({
          _id: { $in: locked.linkedOrderIds },
          sowingDone: { $ne: true },
          orderStatus: {
            $nin: ["CANCELLED", "TEMPORARY_CANCELLED", "REJECTED", "DELETED"],
          },
        })
          .select("orderId numberOfPlants additionalPlants deliveryDate")
          .lean();
        uncoveredLinkedOrders = pendingLinked.map((o) => ({
          orderMongoId: String(o._id),
          orderId: o.orderId,
          plantsNeeded:
            (Number(o.numberOfPlants) || 0) + (Number(o.additionalPlants) || 0),
          deliveryDate: o.deliveryDate || null,
        }));
        suggestCoverFromStock =
          uncoveredLinkedOrders.length > 0 || finalExcess > 0;
      } else if (finalExcess > 0) {
        suggestCoverFromStock = true;
      }

      return res.status(200).json({
        success: true,
        message: locked.sowingCompleted
          ? "Sowing completed successfully"
          : "Sowing progress saved",
        data: {
          requestId: locked._id,
          requestNumber: locked.requestNumber,
          sowingCompleted: locked.sowingCompleted,
          expectedPlants: expected,
          plantsSowed,
          shedName,
          packetsIssued: locked.packetsIssued,
          packetsUsed: locked.packetsUsed,
          packetsReturned: locked.packetsReturned,
          packetsRemaining: remainingAfter,
          slotsUpdated: slotResult.slotsUpdated,
          plantReadyDays: slotResult.plantReadyDays ?? plantReadyDays,
          plantReadyDate: slotResult.plantReadyDate,
          appliedSlotId: slotResult.appliedSlotId
            ? String(slotResult.appliedSlotId)
            : null,
          inventory: {
            used: inv.used,
            returned: inv.returned,
            returnRequestIds: inv.returnRequestIds,
          },
          ordersMarked: orderResult.marked,
          orderCoveredPlants,
          excessPlants: finalExcess,
          uncoveredLinkedOrders,
          suggestCoverFromStock,
          orderCoverWindowDays: orderResult.coverWindowDays ?? 0,
          orderCoverFrom: orderResult.coverFrom || null,
          orderCoverTo: orderResult.coverTo || null,
          orderReadyDate: orderResult.readyDate || null,
        },
      });
    } catch (inner) {
      await SowingRequest.updateOne(
        { _id: requestId, sowingCompleted: { $ne: true } },
        { $set: { sowingInProgress: false } }
      );
      throw inner;
    }
  } catch (error) {
    console.error("completeSowingRequest:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to complete sowing",
    });
  }
};

function isOfficeOrSuper(user) {
  const t = String(user?.jobTitle || user?.role || "").toUpperCase();
  return (
    t === "SUPER_ADMIN" ||
    t === "SUPERADMIN" ||
    t === "OFFICE_ADMIN" ||
    t === "OFFICEADMIN"
  );
}

/**
 * PATCH /sowing/request/:requestId/sow-entry
 * Edit sow date / plantReadyDays / plantsSowed; reslot by new ready date; append slotHistory.
 */
export const editSowEntry = async (req, res) => {
  try {
    if (!isOfficeOrSuper(req.user)) {
      return res.status(403).json({
        success: false,
        message: "Only Office Admin or Super Admin can edit sow entry",
      });
    }
    const { requestId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(requestId)) {
      return res.status(400).json({ success: false, message: "Invalid requestId" });
    }

    const request = await SowingRequest.findById(requestId);
    if (!request) {
      return res.status(404).json({ success: false, message: "Request not found" });
    }
    if (!request.sowingCompleted) {
      return res.status(400).json({
        success: false,
        message: "Sow entry can only be edited after sowing is completed",
      });
    }

    const bodyReady = parseNum(req.body.plantReadyDays, NaN);
    const bodyPlants = parseNum(req.body.plantsSowed, NaN);
    const result = await editSowEntryOnSlots(request, {
      by: req.user._id,
      sowDate: req.body.sowDate || req.body.sowingDate,
      plantReadyDays: Number.isFinite(bodyReady) && bodyReady > 0 ? bodyReady : undefined,
      plantsSowed: Number.isFinite(bodyPlants) && bodyPlants > 0 ? bodyPlants : undefined,
      reason: req.body.reason,
    });

    pushEvent(request, {
      type: "SOW_ENTRY_EDITED",
      by: req.user._id,
      quantity: result.plantsSowed,
      unit: "plants",
      message: result.slotChanged
        ? `Sow entry edited — moved slot (${result.fromReadyDate} → ${result.toReadyDate})`
        : `Sow entry edited — ready ${result.toReadyDate}`,
      meta: result,
    });
    await request.save();
    bustLiteCacheAsync();

    return res.json({
      success: true,
      message: result.slotChanged
        ? "Sow entry updated and plants moved to ready-date slot"
        : "Sow entry updated",
      data: result,
    });
  } catch (error) {
    console.error("editSowEntry:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to edit sow entry",
    });
  }
};

/**
 * GET /sowing/request/issued-queue
 */
export const getIssuedSowingQueue = async (req, res) => {
  try {
    const rows = await SowingRequest.find({
      status: "issued",
      sowingCompleted: { $ne: true },
    })
      .select(
        "requestNumber plantId plantName subtypeId subtypeName productId packetsNeeded packetsRequested packetsIssued packetsUsed packetsReturned conversionFactor tentativePlantsPerPacket seedSource packetsFromCompany packetsFromRaising linkedOrderIds linkedSlotIds isExcessiveSowing sowedQuantity remainingSowingNeeded issuedDate sowingStartedDate sowingInProgress outwardId"
      )
      .sort({ issuedDate: 1 })
      .lean();

    const orderIds = [
      ...new Set(
        rows.flatMap((r) => (r.linkedOrderIds || []).map((id) => String(id)))
      ),
    ];
    const orders = orderIds.length
      ? await Order.find({ _id: { $in: orderIds } })
          .select("orderId name farmer numberOfPlants additionalPlants sowingDone")
          .populate("farmer", "name mobileNumber")
          .lean()
      : [];
    const orderMap = new Map(orders.map((o) => [String(o._id), o]));

    const readyPairs = [
      ...new Map(
        rows.map((r) => [
          `${r.plantId}-${r.subtypeId}`,
          { plantId: r.plantId, subtypeId: r.subtypeId },
        ])
      ).values(),
    ];
    const readyMap = new Map();
    await Promise.all(
      readyPairs.map(async ({ plantId, subtypeId }) => {
        const d = await resolveCmsReadyDays(plantId, subtypeId);
        readyMap.set(`${plantId}-${subtypeId}`, d);
      })
    );

    const data = await Promise.all(
      rows.map(async (r) => {
      const cf = resolveSowingPlantsPerPacket(r);
      const expectedPlants = Number(
        ((Number(r.packetsRequested) || 0) * cf).toFixed(0)
      );
      const already = Number(r.sowedQuantity) || 0;
      const remainingPlants = Math.max(
        0,
        Number(r.remainingSowingNeeded) || expectedPlants - already
      );
      const companyPkts = companyPacketShare(r);
      const packetsIssued =
        Number(r.packetsIssued) || Number(r.packetsRequested) || companyPkts || 0;
      const packetsUsed = Number(r.packetsUsed) || 0;
      const packetsReturned = Number(r.packetsReturned) || 0;
      const packetsRemaining = await getRemainingCompanyPackets(r);
      const linked = (r.linkedOrderIds || []).map((id) => {
        const o = orderMap.get(String(id));
        return o
          ? {
              orderId: o._id,
              orderNumber: o.orderId,
              farmerName: o.farmer?.name || o.name || "",
              plants:
                (Number(o.numberOfPlants) || 0) +
                (Number(o.additionalPlants) || 0),
              sowingDone: Boolean(o.sowingDone),
            }
          : { orderId: id, orderNumber: null };
      });

      return {
        ...r,
        conversionFactor: cf,
        tentativePlantsPerPacket: r.tentativePlantsPerPacket ?? null,
        expectedPlants,
        remainingPlants,
        packetsIssued,
        packetsUsed,
        packetsReturned,
        packetsRemaining,
        plantReadyDays:
          readyMap.get(`${r.plantId}-${r.subtypeId}`) || 0,
        linkedOrderCount: linked.length,
        linkedOrders: linked,
        isExcess: Boolean(r.isExcessiveSowing),
      };
    })
    );

    return res.json({ success: true, data, count: data.length });
  } catch (error) {
    console.error("getIssuedSowingQueue:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to load issued queue",
      error: error.message,
    });
  }
};

/**
 * GET /sowing/completions?page&limit&q&from&to&plantId&subtypeId
 */
export const getSowingCompletions = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const skip = (page - 1) * limit;
    const q = String(req.query.q || "").trim();

    const match = { sowingCompleted: true };
    if (req.query.plantId && mongoose.Types.ObjectId.isValid(req.query.plantId)) {
      match.plantId = new mongoose.Types.ObjectId(req.query.plantId);
    }
    if (
      req.query.subtypeId &&
      mongoose.Types.ObjectId.isValid(req.query.subtypeId)
    ) {
      match.subtypeId = new mongoose.Types.ObjectId(req.query.subtypeId);
    }
    if (req.query.from || req.query.to) {
      match.sowingCompletedDate = {};
      if (req.query.from) match.sowingCompletedDate.$gte = new Date(req.query.from);
      if (req.query.to) match.sowingCompletedDate.$lte = new Date(req.query.to);
    }

    let orderIdFilter = null;
    if (q) {
      const orderHits = await Order.find({
        $or: [
          { orderId: { $regex: q, $options: "i" } },
          { name: { $regex: q, $options: "i" } },
        ],
      })
        .select("_id")
        .limit(200)
        .lean();
      orderIdFilter = orderHits.map((o) => o._id);

      match.$or = [
        { requestNumber: { $regex: q, $options: "i" } },
        { plantName: { $regex: q, $options: "i" } },
        { subtypeName: { $regex: q, $options: "i" } },
        ...(orderIdFilter.length
          ? [{ linkedOrderIds: { $in: orderIdFilter } }]
          : []),
      ];
    }

    const [total, rows] = await Promise.all([
      SowingRequest.countDocuments(match),
      SowingRequest.find(match)
        .select(
          "requestNumber plantId plantName subtypeId subtypeName packetsRequested conversionFactor sowedQuantity laboursLadies laboursGents completionPhotos completionNotes shedName sowingCompletedDate isExcessiveSowing linkedOrderIds linkedSlotIds seedSource packetsFromCompany packetsFromRaising packetsIssued packetsUsed packetsReturned returnRequestIds completionEvents completedBy outwardId"
        )
        .populate("completedBy", "name")
        .sort({ sowingCompletedDate: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
    ]);

    const requestIds = rows.map((r) => r._id).filter(Boolean);
    const outwardIds = [
      ...new Set(
        rows.map((r) => r.outwardId).filter(Boolean).map((id) => String(id))
      ),
    ];
    const allSlotIds = [
      ...new Set(rows.flatMap((r) => collectSlotIdsFromRequest(r))),
    ].map((id) => new mongoose.Types.ObjectId(id));

    const [ordersByRequest, outwards, slotRows] = await Promise.all([
      // Orders actually covered by each completion (delivery matched at mark time)
      requestIds.length
        ? Order.find({ sowingDoneRequestId: { $in: requestIds } })
            .select(
              "orderId name farmer numberOfPlants additionalPlants sowingDone sowingDoneAt sowingDoneRequestId deliveryDate orderBookingDate createdAt"
            )
            .populate("farmer", "name mobileNumber")
            .sort({ deliveryDate: 1, createdAt: 1 })
            .lean()
        : Promise.resolve([]),
      outwardIds.length
        ? InventoryOutward.find({ _id: { $in: outwardIds } })
            .select("outwardNumber outwardDate items.batch")
            .populate("items.batch", "batchNumber")
            .lean()
        : Promise.resolve([]),
      allSlotIds.length
        ? PlantSlot.aggregate([
            { $match: { "subtypeSlots.slots._id": { $in: allSlotIds } } },
            { $unwind: "$subtypeSlots" },
            { $unwind: "$subtypeSlots.slots" },
            { $match: { "subtypeSlots.slots._id": { $in: allSlotIds } } },
            {
              $project: {
                slotId: "$subtypeSlots.slots._id",
                startDay: "$subtypeSlots.slots.startDay",
                endDay: "$subtypeSlots.slots.endDay",
                month: "$subtypeSlots.slots.month",
                year: { $ifNull: ["$subtypeSlots.slots.year", "$year"] },
                primarySowed: "$subtypeSlots.slots.primarySowed",
                officeSowed: "$subtypeSlots.slots.officeSowed",
                plantsSowed: "$subtypeSlots.slots.plantsSowed",
                availablePlants: "$subtypeSlots.slots.availablePlants",
                orderReservedPlants: {
                  $ifNull: ["$subtypeSlots.slots.orderReservedPlants", 0],
                },
                totalBookedPlants: "$subtypeSlots.slots.totalBookedPlants",
                totalPlants: "$subtypeSlots.slots.totalPlants",
                sowingDate: "$subtypeSlots.slots.sowingDate",
                plantReadyDate: "$subtypeSlots.slots.plantReadyDate",
                plantReadyDays: "$subtypeSlots.slots.plantReadyDays",
                excessivePlants: {
                  $ifNull: ["$subtypeSlots.slots.excessiveSowing.plants", 0],
                },
                sowingBatches: {
                  $slice: [
                    { $ifNull: ["$subtypeSlots.slots.sowingBatches", []] },
                    8,
                  ],
                },
              },
            },
          ])
        : Promise.resolve([]),
    ]);

    const ordersByReqMap = new Map();
    for (const o of ordersByRequest) {
      const key = String(o.sowingDoneRequestId);
      if (!ordersByReqMap.has(key)) ordersByReqMap.set(key, []);
      ordersByReqMap.get(key).push(o);
    }
    const outwardMap = new Map(outwards.map((o) => [String(o._id), o]));
    const slotMap = new Map(slotRows.map((s) => [String(s.slotId), s]));

    const items = rows.map((r) => {
      const cf = resolveSowingPlantsPerPacket(r);
      const outward = r.outwardId ? outwardMap.get(String(r.outwardId)) : null;
      const batchNumbers = [
        ...new Set(
          (outward?.items || [])
            .map((it) => it?.batch?.batchNumber || it?.batchNumber || "")
            .filter(Boolean)
        ),
      ];
      const covered = ordersByReqMap.get(String(r._id)) || [];
      const sowCompletedEv = Array.isArray(r.completionEvents)
        ? r.completionEvents.find((e) => e?.type === "SOW_COMPLETED")
        : null;
      const sowingDate = r.sowingCompletedDate || sowCompletedEv?.at || null;
      const readyDateMeta =
        sowCompletedEv?.meta?.orderReadyDate ||
        sowCompletedEv?.meta?.plantReadyDate ||
        null;
      const coverWindowDays = Number(
        sowCompletedEv?.meta?.orderCoverWindowDays ?? 4
      );
      const linkedOrders = covered.map((o) => {
        let coverOffsetDays = null;
        if (o.deliveryDate && readyDateMeta) {
          try {
            const del = new Date(o.deliveryDate);
            let ready = null;
            const dmy = String(readyDateMeta).match(
              /^(\d{2})-(\d{2})-(\d{4})$/
            );
            if (dmy) {
              ready = new Date(
                Number(dmy[3]),
                Number(dmy[2]) - 1,
                Number(dmy[1]),
                12,
                0,
                0
              );
            } else {
              ready = new Date(readyDateMeta);
            }
            if (
              !Number.isNaN(del.getTime()) &&
              ready &&
              !Number.isNaN(ready.getTime())
            ) {
              const d0 = Date.UTC(
                del.getFullYear(),
                del.getMonth(),
                del.getDate()
              );
              const r0 = Date.UTC(
                ready.getFullYear(),
                ready.getMonth(),
                ready.getDate()
              );
              coverOffsetDays = Math.round((d0 - r0) / 86400000);
            }
          } catch {
            coverOffsetDays = null;
          }
        }
        return {
          orderId: o._id,
          orderNumber: o.orderId,
          farmerName: o.farmer?.name || o.name || "",
          farmerMobile: o.farmer?.mobileNumber || "",
          plants:
            (Number(o.numberOfPlants) || 0) + (Number(o.additionalPlants) || 0),
          sowingDone: Boolean(o.sowingDone),
          sowingDoneAt: o.sowingDoneAt,
          bookingDate: o.orderBookingDate || o.createdAt || null,
          deliveryDate: o.deliveryDate || null,
          coverOffsetDays,
          inCoverWindow:
            coverOffsetDays == null
              ? true
              : Math.abs(coverOffsetDays) <= coverWindowDays,
        };
      });

      const preferredSlotId =
        sowCompletedEv?.meta?.appliedSlotId ||
        collectSlotIdsFromRequest(r)[0] ||
        null;
      const slotRaw = preferredSlotId
        ? slotMap.get(String(preferredSlotId))
        : null;
      const reqBatch = (slotRaw?.sowingBatches || []).find(
        (b) => String(b.sowingRequestId) === String(r._id)
      );
      const affectedSlot = slotRaw
        ? {
            slotId: String(slotRaw.slotId),
            label:
              slotRaw.startDay === slotRaw.endDay
                ? slotRaw.startDay || "—"
                : `${slotRaw.startDay || "—"} → ${slotRaw.endDay || "—"}`,
            startDay: slotRaw.startDay || null,
            endDay: slotRaw.endDay || null,
            month: slotRaw.month || null,
            year: slotRaw.year || null,
            primarySowed: Number(slotRaw.primarySowed) || 0,
            officeSowed: Number(slotRaw.officeSowed) || 0,
            plantsSowed: Number(slotRaw.plantsSowed) || 0,
            availablePlants: Number(slotRaw.availablePlants) || 0,
            orderReservedPlants: Number(slotRaw.orderReservedPlants) || 0,
            totalBookedPlants: Number(slotRaw.totalBookedPlants) || 0,
            totalPlants: Number(slotRaw.totalPlants) || 0,
            excessivePlants: Number(slotRaw.excessivePlants) || 0,
            sowingDate: reqBatch?.sowingDate || slotRaw.sowingDate || null,
            plantReadyDate:
              reqBatch?.plantReadyDate || slotRaw.plantReadyDate || null,
            plantReadyDays:
              reqBatch?.plantReadyDays ?? slotRaw.plantReadyDays ?? null,
            batchPlantsSowed: Number(reqBatch?.plantsSowed) || 0,
            batchPacketsUsed: Number(reqBatch?.packetsUsed) || 0,
            shedName: reqBatch?.shedName || r.shedName || "",
          }
        : null;

      return {
        ...r,
        expectedPlants: Number(((Number(r.packetsRequested) || 0) * cf).toFixed(0)),
        isExcess: Boolean(r.isExcessiveSowing),
        linkedOrders,
        labourTotal:
          (Number(r.laboursLadies) || 0) + (Number(r.laboursGents) || 0),
        batchNumber: batchNumbers.join(", ") || "",
        batchNumbers,
        outwardNumber: outward?.outwardNumber || "",
        sowingDate,
        affectedSlot,
      };
    });

    return res.json({
      success: true,
      items,
      total,
      page,
      limit,
      pages: Math.ceil(total / limit) || 0,
    });
  } catch (error) {
    console.error("getSowingCompletions:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to load completions",
      error: error.message,
    });
  }
};
