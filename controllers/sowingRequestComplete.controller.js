import multer from "multer";
import mongoose from "mongoose";
import SowingRequest from "../models/sowingRequest.model.js";
import Order from "../models/order.model.js";
import InventoryOutward from "../models/inventoryOutward.model.js";
import {
  parseNum,
  pushEvent,
  applyPlantsToLinkedSlots,
  settleOutwardAndReturns,
  markOrdersSowed,
  uploadCompleteSowPhotos,
  editSowEntryOnSlots,
} from "./sowingCompleteHelpers.js";
import {
  resolveCmsReadyDays,
  parseLocalDate,
} from "./sowingSlotReadyHelpers.js";

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
      const cf = Number(locked.conversionFactor) || 1;
      const expected = Number(
        ((Number(locked.packetsRequested) || 0) * cf).toFixed(0)
      );

      let packetsUsed = parseNum(req.body.packetsUsed, NaN);
      let packetsToReturn = hasReturnInput ? Math.max(0, packetsToReturnRaw) : NaN;
      const companyPkts =
        Number(locked.packetsFromCompany) ||
        (locked.seedSource === "RAISING" ? 0 : Number(locked.packetsRequested) || 0);
      const packetsIssued =
        Number(locked.packetsRequested) || companyPkts || 0;

      if (Number.isFinite(packetsToReturn)) {
        packetsToReturn = Math.min(companyPkts, packetsToReturn);
        if (!Number.isFinite(packetsUsed)) {
          packetsUsed = Math.max(0, companyPkts - packetsToReturn);
        }
      }

      if (!Number.isFinite(packetsUsed)) {
        const fromPlants = cf > 0 ? plantsSowed / cf : 0;
        packetsUsed = Math.min(
          companyPkts || Number(locked.packetsRequested) || 0,
          fromPlants
        );
        if (completeSowing) {
          packetsUsed =
            companyPkts || Number(locked.packetsRequested) || packetsUsed;
        }
      }
      if (!Number.isFinite(packetsToReturn)) {
        packetsToReturn = completeSowing
          ? Math.max(0, companyPkts - packetsUsed)
          : 0;
      }
      if (packetsUsed + packetsToReturn > companyPkts && companyPkts > 0) {
        packetsToReturn = Math.max(0, companyPkts - packetsUsed);
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

      if (completeSowing) {
        locked.remainingSowingNeeded = 0;
        locked.sowingCompleted = true;
        locked.sowingCompletedDate = sowedAt;
        locked.sowingInProgress = false;
      } else {
        locked.remainingSowingNeeded = Math.max(
          0,
          expected - locked.sowedQuantity
        );
        locked.sowingCompleted = locked.remainingSowingNeeded <= 0;
        if (locked.sowingCompleted) {
          locked.sowingCompletedDate = sowedAt;
          locked.sowingInProgress = false;
        }
      }

      const orderResult = locked.sowingCompleted
        ? await markOrdersSowed(locked, { sowedAt })
        : { marked: 0 };

      pushEvent(locked, {
        type: "SOW_COMPLETED",
        by: userId,
        quantity: plantsSowed,
        unit: "plants",
        message: "Sowing completed for the day",
        meta: {
          packetsIssued: locked.packetsIssued,
          packetsUsed: locked.packetsUsed,
          packetsReturned: locked.packetsReturned,
          sowedQuantity: locked.sowedQuantity,
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
          photoCount: photos.length,
          shedName,
          notes: notes || undefined,
        },
      });
      for (const evt of inv.events || []) pushEvent(locked, evt);

      await locked.save();
      bustLiteCacheAsync();

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
        "requestNumber plantId plantName subtypeId subtypeName productId packetsNeeded packetsRequested conversionFactor seedSource packetsFromCompany packetsFromRaising linkedOrderIds linkedSlotIds isExcessiveSowing sowedQuantity remainingSowingNeeded issuedDate sowingStartedDate sowingInProgress"
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

    const data = rows.map((r) => {
      const cf = Number(r.conversionFactor) || 1;
      const expectedPlants = Number(
        ((Number(r.packetsRequested) || 0) * cf).toFixed(0)
      );
      const already = Number(r.sowedQuantity) || 0;
      const remainingPlants = Math.max(
        0,
        Number(r.remainingSowingNeeded) || expectedPlants - already
      );
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
        expectedPlants,
        remainingPlants,
        plantReadyDays:
          readyMap.get(`${r.plantId}-${r.subtypeId}`) || 0,
        linkedOrderCount: linked.length,
        linkedOrders: linked,
        isExcess: Boolean(r.isExcessiveSowing),
      };
    });

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
          "requestNumber plantId plantName subtypeId subtypeName packetsRequested conversionFactor sowedQuantity laboursLadies laboursGents completionPhotos completionNotes shedName sowingCompletedDate isExcessiveSowing linkedOrderIds seedSource packetsFromCompany packetsFromRaising packetsIssued packetsUsed packetsReturned returnRequestIds completionEvents completedBy outwardId"
        )
        .populate("completedBy", "name")
        .sort({ sowingCompletedDate: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
    ]);

    const allOrderIds = [
      ...new Set(
        rows.flatMap((r) => (r.linkedOrderIds || []).map((id) => String(id)))
      ),
    ];
    const outwardIds = [
      ...new Set(
        rows.map((r) => r.outwardId).filter(Boolean).map((id) => String(id))
      ),
    ];

    const [orders, outwards] = await Promise.all([
      allOrderIds.length
        ? Order.find({ _id: { $in: allOrderIds } })
            .select(
              "orderId name farmer numberOfPlants additionalPlants sowingDone sowingDoneAt deliveryDate"
            )
            .populate("farmer", "name mobileNumber")
            .lean()
        : Promise.resolve([]),
      outwardIds.length
        ? InventoryOutward.find({ _id: { $in: outwardIds } })
            .select("outwardNumber outwardDate items.batch")
            .populate("items.batch", "batchNumber")
            .lean()
        : Promise.resolve([]),
    ]);

    const orderMap = new Map(orders.map((o) => [String(o._id), o]));
    const outwardMap = new Map(outwards.map((o) => [String(o._id), o]));

    const items = rows.map((r) => {
      const cf = Number(r.conversionFactor) || 1;
      const outward = r.outwardId ? outwardMap.get(String(r.outwardId)) : null;
      const batchNumbers = [
        ...new Set(
          (outward?.items || [])
            .map((it) => it?.batch?.batchNumber || it?.batchNumber || "")
            .filter(Boolean)
        ),
      ];
      const linkedOrders = (r.linkedOrderIds || []).map((id) => {
        const o = orderMap.get(String(id));
        if (!o) return { orderId: id };
        return {
          orderId: o._id,
          orderNumber: o.orderId,
          farmerName: o.farmer?.name || o.name || "",
          farmerMobile: o.farmer?.mobileNumber || "",
          plants:
            (Number(o.numberOfPlants) || 0) + (Number(o.additionalPlants) || 0),
          sowingDone: Boolean(o.sowingDone),
          sowingDoneAt: o.sowingDoneAt,
          deliveryDate: o.deliveryDate || null,
        };
      });
      const sowingDate =
        r.sowingCompletedDate ||
        (Array.isArray(r.completionEvents)
          ? r.completionEvents.find((e) => e?.type === "SOW_COMPLETED")?.at
          : null) ||
        null;
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
