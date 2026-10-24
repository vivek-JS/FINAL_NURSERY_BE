import multer from "multer";
import mongoose from "mongoose";
import SowingRequest from "../models/sowingRequest.model.js";
import Order from "../models/order.model.js";
import User from "../models/user.model.js";
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
  raisingPacketShare,
  getRemainingRaisingPackets,
} from "./sowingCompleteHelpers.js";
import {
  resolveCmsReadyDays,
  parseLocalDate,
  findSlotByPlantReadyDate,
  addDays,
  fmtDDMMYYYY,
  istTodayNoon,
  toSowYmd,
} from "./sowingSlotReadyHelpers.js";
import { resolveSowingPlantsPerPacket } from "../utility/sowingPlantsPerPacket.js";
import {
  settleSowPackets,
  isSowingRequestClosed,
  wantsSowingClosed,
} from "../utility/sowPacketSettlement.js";
import { readMachineTimes } from "../utility/sowMachineTime.js";
import { reportedExcess } from "../utility/lagwadSlotPlantsSplit.js";
import { sowingBufferPctByPlantId } from "../utility/plantSowingBuffer.js";
import { mortalityLeftOnBatch } from "../services/sowBatchMortalityRelease.service.js";
import { paintSowingEntryNumbers, storedShownExcess } from "../utility/sowingBatchExcessStamp.js";

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

/** Photos are optional — JSON complete-sow (no multipart) skips multer. */
export function optionalCompleteSowUpload(req, res, next) {
  const ct = String(req.headers["content-type"] || "");
  if (!ct.includes("multipart/form-data")) return next();
  return completeSowUpload.array("photos", 5)(req, res, (err) => {
    if (err) return next(err);
    next();
  });
}

/** Date -> "YYYY-MM-DD" in IST. */
function istYmd(d) {
  return new Date(d).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

const SOW_ENTRY_EVENT_TYPES = ["PLANTS_SOWED", "SOW_COMPLETED"];

export const DEFAULT_TRAY_SIZE = 126;

/** A part-filled tray is still a tray. */
export function traysFor(plants, traySize = DEFAULT_TRAY_SIZE) {
  const size = Number(traySize) > 0 ? Number(traySize) : DEFAULT_TRAY_SIZE;
  const p = Number(plants) || 0;
  return p > 0 ? Math.ceil(p / size) : 0;
}

/** Packet events saved with an entry land in the same save, milliseconds apart. */
function packetsNearEntry(events, at, type) {
  if (!at) return 0;
  const t = new Date(at).getTime();
  return (events || [])
    .filter(
      (e) => e?.type === type && e.at && Math.abs(new Date(e.at).getTime() - t) < 60 * 1000
    )
    .reduce((s, e) => s + (Number(e.quantity) || 0), 0);
}

/**
 * GET /sowing/day-summary?date=YYYY-MM-DD
 * One row per sow entry on that day (entry sowDate, else the IST day it was saved).
 */
export const getSowingDaySummary = async (req, res) => {
  try {
    const date = String(req.query.date || "").trim() || istYmd(new Date());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ success: false, message: "date must be YYYY-MM-DD" });
    }
    const dayStart = new Date(`${date}T00:00:00+05:30`);
    const dayEnd = new Date(dayStart.getTime() + 24 * 3600 * 1000);

    const rows = await SowingRequest.find({
      $or: [
        { "completionEvents.meta.sowDate": date },
        { "completionEvents.at": { $gte: dayStart, $lt: dayEnd } },
      ],
    })
      .select("requestNumber plantName subtypeName shedName completionEvents")
      .lean();

    const entries = [];
    for (const r of rows) {
      const events = r.completionEvents || [];
      for (const ev of events) {
        if (!SOW_ENTRY_EVENT_TYPES.includes(ev?.type)) continue;
        const plants = Number(ev.quantity) || 0;
        if (plants < 1) continue;
        const meta = ev.meta || {};
        const at = ev.at ? new Date(ev.at) : null;
        const entryDay = meta.sowDate || (at ? istYmd(at) : "");
        if (entryDay !== date) continue;

        let packetsUsed = Number(meta.packetsUsedNow);
        if (!Number.isFinite(packetsUsed)) {
          packetsUsed = packetsNearEntry(events, at, "PACKETS_USED");
        }

        entries.push({
          requestId: r._id,
          requestNumber: r.requestNumber || "",
          plantName: r.plantName || "",
          subtypeName: r.subtypeName || "",
          shedName: meta.shedName || r.shedName || "",
          plants,
          packetsUsed: Math.round(packetsUsed * 100) / 100,
          ladies: Number(meta.laboursLadies) || 0,
          gents: Number(meta.laboursGents) || 0,
          machineStartTime: meta.machineStartTime || "",
          machineEndTime: meta.machineEndTime || "",
          at,
        });
      }
    }
    entries.sort((a, b) => (a.at?.getTime() || 0) - (b.at?.getTime() || 0));

    return res.json({ success: true, date, entries });
  } catch (error) {
    console.error("getSowingDaySummary:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to load sowing day summary",
    });
  }
};

function bustLiteCacheAsync() {
  setImmediate(() => {
    import("./sowingCardsLite.controller.js")
      .then((m) => m.bustTodaySowingCardsLiteCache?.())
      .catch(() => {});
  });
}

/**
 * GET /sowing/request/:requestId/slot-preview?sowDate=&plantReadyDays=
 * Preview which calendar slot will receive plants (no DB writes).
 */
export const getSowSlotPreview = async (req, res) => {
  try {
    const { requestId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(requestId)) {
      return res.status(400).json({ success: false, message: "Invalid requestId" });
    }

    const request = await SowingRequest.findById(requestId)
      .select("plantId subtypeId linkedSlotIds isExcessiveSowing")
      .lean();
    if (!request) {
      return res.status(404).json({ success: false, message: "Request not found" });
    }

    const cmsReady = await resolveCmsReadyDays(request.plantId, request.subtypeId);
    const bodyReady = parseNum(req.query.plantReadyDays, NaN);
    const plantReadyDays =
      Number.isFinite(bodyReady) && bodyReady > 0 ? bodyReady : cmsReady;

    const sowedAt =
      parseLocalDate(req.query.sowDate || req.query.sowingDate) || istTodayNoon();
    const plantReadyDateStr = fmtDDMMYYYY(addDays(sowedAt, plantReadyDays || 0));

    let resolved = null;
    if (request.plantId && request.subtypeId && plantReadyDays > 0) {
      resolved = await findSlotByPlantReadyDate(
        request.plantId,
        request.subtypeId,
        plantReadyDateStr
      );
    }

    const slotId = resolved?.slotId || request.linkedSlotIds?.[0] || null;
    if (!slotId) {
      return res.json({
        success: true,
        data: {
          found: false,
          plantReadyDays,
          plantReadyDate: plantReadyDateStr,
          sowDate: fmtDDMMYYYY(sowedAt),
          resolvedByReadyDate: Boolean(resolved),
          message: "No calendar slot found for this ready date",
        },
      });
    }

    const slotRows = await PlantSlot.aggregate([
      { $match: { "subtypeSlots.slots._id": new mongoose.Types.ObjectId(slotId) } },
      { $unwind: "$subtypeSlots" },
      { $unwind: "$subtypeSlots.slots" },
      { $match: { "subtypeSlots.slots._id": new mongoose.Types.ObjectId(slotId) } },
      {
        $project: {
          slotId: "$subtypeSlots.slots._id",
          startDay: "$subtypeSlots.slots.startDay",
          endDay: "$subtypeSlots.slots.endDay",
          month: "$subtypeSlots.slots.month",
          year: { $ifNull: ["$subtypeSlots.slots.year", "$year"] },
          actualPlants: { $ifNull: ["$subtypeSlots.slots.actualPlants", 0] },
          primarySowed: { $ifNull: ["$subtypeSlots.slots.primarySowed", 0] },
          availablePlants: { $ifNull: ["$subtypeSlots.slots.availablePlants", 0] },
          plantsSowed: { $ifNull: ["$subtypeSlots.slots.plantsSowed", 0] },
        },
      },
    ]);

    const slot = slotRows[0] || null;
    const label =
      slot?.startDay && slot?.endDay
        ? slot.startDay === slot.endDay
          ? slot.startDay
          : `${slot.startDay} → ${slot.endDay}`
        : null;

    return res.json({
      success: true,
      data: {
        found: true,
        slotId: String(slotId),
        startDay: slot?.startDay || resolved?.startDay || null,
        endDay: slot?.endDay || resolved?.endDay || null,
        month: slot?.month || null,
        year: slot?.year || null,
        label,
        plantReadyDays,
        plantReadyDate: plantReadyDateStr,
        sowDate: fmtDDMMYYYY(sowedAt),
        actualPlants: Number(slot?.actualPlants) || 0,
        primarySowed: Number(slot?.primarySowed) || 0,
        availablePlants: Number(slot?.availablePlants) || 0,
        plantsSowed: Number(slot?.plantsSowed) || 0,
        resolvedByReadyDate: Boolean(resolved),
      },
    });
  } catch (error) {
    console.error("getSowSlotPreview:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to preview slot",
    });
  }
};

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
    const bodyTraySize = parseNum(req.body.traySize, NaN);
    const traySize =
      Number.isFinite(bodyTraySize) && bodyTraySize > 0 ? bodyTraySize : DEFAULT_TRAY_SIZE;
    const laboursLadies = Math.max(0, parseNum(req.body.laboursLadies));
    const laboursGents = Math.max(0, parseNum(req.body.laboursGents));
    const notes = String(req.body.notes || req.body.completionNotes || "").trim();
    const shedName = String(
      req.body.shedName || req.body.pollyhouse || req.body.shed || ""
    ).trim();
    const packetsToReturnRaw = parseNum(req.body.packetsToReturn, NaN);
    const hasReturnInput = Number.isFinite(packetsToReturnRaw);
    const raisingUsedRaw = parseNum(req.body.raisingPacketsUsed, NaN);
    const raisingReturnRaw = parseNum(
      req.body.raisingPacketsToReturn ?? req.body.raisingPacketsReturned,
      NaN
    );
    const completeSowing = wantsSowingClosed({
      completeSowing: String(req.body.completeSowing ?? "true").toLowerCase() !== "false",
      packetsToReturn: packetsToReturnRaw,
      raisingPacketsToReturn: raisingReturnRaw,
    });
    const hasRaisingUsedInput = Number.isFinite(raisingUsedRaw);
    const hasRaisingReturnInput = Number.isFinite(raisingReturnRaw);
    const raisingTouched = hasRaisingUsedInput || hasRaisingReturnInput;

    if (
      !(plantsSowed > 0) &&
      !(hasReturnInput && packetsToReturnRaw > 0) &&
      !(hasRaisingUsedInput && raisingUsedRaw > 0) &&
      !(hasRaisingReturnInput && raisingReturnRaw > 0)
    ) {
      return res.status(400).json({
        success: false,
        message: "Enter plantsSowed > 0 and/or company/raising packets used or returned",
      });
    }
    if (!shedName) {
      return res.status(400).json({
        success: false,
        message: "shedName is required (where sowing was done)",
      });
    }
    const machine = readMachineTimes(req.body);
    if (machine.error) {
      return res.status(400).json({ success: false, message: machine.error });
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
      const raisingPkts = raisingPacketShare(locked);
      const packetsIssued =
        Number(locked.packetsIssued) ||
        Number(locked.packetsRequested) ||
        companyPkts ||
        0;
      const remainingPkt = await getRemainingCompanyPackets(locked);
      const remainingRaising = getRemainingRaisingPackets(locked);

      // Prefer explicit packetsUsed. Honor explicit packetsToReturn even when
      // plant/cf used-hint would consume every remaining bag.
      let packetsUsedHint = parseNum(req.body.packetsUsed, NaN);
      if (!Number.isFinite(packetsUsedHint)) {
        const fromPlants = cf > 0 ? plantsSowed / cf : 0;
        packetsUsedHint = Math.min(remainingPkt, Math.max(0, fromPlants));
      }

      const settled = settleSowPackets({
        remaining: remainingPkt,
        usedHint: packetsUsedHint,
        packetsToReturn: hasReturnInput ? packetsToReturnRaw : 0,
        completeSowing,
      });
      const packetsUsed = settled.packetsUsed;
      const packetsToReturn = settled.packetsToReturn;

      // Complete with no raising input (shed app): nothing is in hand, so open raising bags were sowed.
      const raisingSettled = raisingTouched
        ? settleSowPackets({
            remaining: remainingRaising,
            usedHint: hasRaisingUsedInput ? raisingUsedRaw : 0,
            packetsToReturn: hasRaisingReturnInput ? raisingReturnRaw : 0,
            completeSowing,
          })
        : { packetsUsed: completeSowing ? remainingRaising : 0, packetsToReturn: 0 };
      const raisingPacketsUsedNow = raisingSettled.packetsUsed;
      const raisingPacketsToReturnNow = raisingSettled.packetsToReturn;

      const userId = req.user._id;
      const cmsReady = await resolveCmsReadyDays(locked.plantId, locked.subtypeId);
      const bodyReady = parseNum(req.body.plantReadyDays, NaN);
      const plantReadyDays =
        Number.isFinite(bodyReady) && bodyReady > 0 ? bodyReady : cmsReady;
      const sowedAt =
        parseLocalDate(req.body.sowDate || req.body.sowingDate) || istTodayNoon();

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

      const [inv, photos, raisingRestore] = await Promise.all([
        settleOutwardAndReturns(locked, packetsUsed, packetsToReturn, userId),
        uploadCompleteSowPhotos(req.files),
        raisingPacketsToReturnNow > 0
          ? import("./raisingSeed.controller.js").then(({ restoreRaisingPackets }) =>
              restoreRaisingPackets({
                intakeIds: locked.raisingIntakeIds || [],
                packetsToRestore: raisingPacketsToReturnNow,
              })
            )
          : Promise.resolve({ restored: 0 }),
      ]);

      const prevSowed = Number(locked.sowedQuantity) || 0;
      locked.sowedQuantity = prevSowed + plantsSowed;
      locked.laboursLadies = laboursLadies;
      locked.laboursGents = laboursGents;
      if (machine.start) {
        locked.machineStartTime = machine.start;
        locked.machineEndTime = machine.end;
        locked.machineMinutes = Number(locked.machineMinutes || 0) + machine.minutes;
      }
      locked.packetsIssued = packetsIssued;
      locked.packetsUsed = Number(locked.packetsUsed || 0) + (inv.used || 0);
      locked.packetsReturned =
        Number(locked.packetsReturned || 0) + (inv.returned || 0);
      locked.raisingPacketsUsed =
        Number(locked.raisingPacketsUsed || 0) + raisingPacketsUsedNow;
      locked.raisingPacketsReturned =
        Number(locked.raisingPacketsReturned || 0) + raisingPacketsToReturnNow;
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
      const remainingCompanyAfter = Math.max(
        0,
        remainingPkt - (inv.used || 0) - (inv.returned || 0)
      );
      const remainingRaisingAfter = Math.max(
        0,
        remainingRaising - raisingPacketsUsedNow - raisingPacketsToReturnNow
      );
      const remainingAfter = remainingCompanyAfter + remainingRaisingAfter;
      locked.remainingSowingNeeded = Math.max(
        0,
        expected - locked.sowedQuantity
      );

      locked.sowingCompleted = isSowingRequestClosed({
        completeSowing,
        remainingAfter,
        companyPackets: companyPkts,
        raisingPackets: raisingPkts,
        remainingSowingNeeded: locked.remainingSowingNeeded,
      });
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
            orderResult.batchLinkedIds || orderResult.markedIds || locked.linkedOrderIds || []
          );
        }
      }

      pushEvent(locked, {
        type: locked.sowingCompleted ? "SOW_COMPLETED" : "PLANTS_SOWED",
        by: userId,
        quantity: plantsSowed,
        unit: "plants",
        message: locked.sowingIncomplete
          ? "Sowing marked incomplete — leftover orders go to a later request"
          : locked.sowingCompleted
            ? "Sowing completed"
            : "Sowing progress saved (bags still open)",
        meta: {
          packetsIssued: locked.packetsIssued,
          packetsUsed: locked.packetsUsed,
          packetsReturned: locked.packetsReturned,
          packetsRemaining: remainingAfter,
          remainingCompany: remainingCompanyAfter,
          remainingRaising: remainingRaisingAfter,
          raisingPacketsUsed: locked.raisingPacketsUsed,
          raisingPacketsReturned: locked.raisingPacketsReturned,
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
          machineStartTime: machine.start || undefined,
          machineEndTime: machine.end || undefined,
          machineMinutes: machine.start ? machine.minutes : undefined,
          sowDate: istYmd(sowedAt),
          traySize,
          trays: traysFor(plantsSowed, traySize),
          packetsUsedNow: (inv.used || 0) + raisingPacketsUsedNow,
          ordersMarked: orderResult.marked,
          remainingUncovered: orderResult.remainingUncovered ?? 0,
          sowingIncomplete: Boolean(orderResult.incomplete),
          waitingOrders: (orderResult.waiting || []).length,
          partialPlants: orderResult.partial?.addPlants || 0,
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
      if (raisingPacketsUsedNow > 0) {
        pushEvent(locked, {
          type: "PACKETS_USED",
          by: userId,
          quantity: raisingPacketsUsedNow,
          unit: "packets",
          message: "Raising packets used",
          meta: { source: "RAISING" },
        });
      }
      if (raisingPacketsToReturnNow > 0) {
        pushEvent(locked, {
          type: "PACKETS_RETURNED",
          by: userId,
          quantity: raisingPacketsToReturnNow,
          unit: "packets",
          message: "Raising packets returned to intake",
          meta: {
            source: "RAISING",
            restored: raisingRestore?.restored || 0,
          },
        });
      }

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
        message: locked.sowingIncomplete
          ? "Sowing marked incomplete — leftover orders can go on a new request"
          : locked.sowingCompleted
            ? "Sowing completed successfully"
            : "Sowing progress saved",
        data: {
          requestId: locked._id,
          requestNumber: locked.requestNumber,
          sowingCompleted: locked.sowingCompleted,
          sowingIncomplete: Boolean(locked.sowingIncomplete),
          expectedPlants: expected,
          plantsSowed,
          shedName,
          packetsIssued: locked.packetsIssued,
          packetsUsed: locked.packetsUsed,
          packetsReturned: locked.packetsReturned,
          packetsRemaining: remainingAfter,
          remainingCompany: remainingCompanyAfter,
          remainingRaising: remainingRaisingAfter,
          raisingPacketsUsed: locked.raisingPacketsUsed,
          raisingPacketsReturned: locked.raisingPacketsReturned,
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
          waitingOrders: (orderResult.waiting || []).length,
          partialPlants: orderResult.partial?.addPlants || 0,
          orderCoveredPlants,
          excessPlants: reportedExcess({
            plantsSowed,
            orderCoveredPlants,
            sowingBufferPct: (
              await sowingBufferPctByPlantId([locked.plantId])
            ).get(String(locked.plantId)),
          }),
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
        "requestNumber plantId plantName subtypeId subtypeName productId packetsNeeded packetsRequested packetsIssued packetsUsed packetsReturned raisingPacketsUsed raisingPacketsReturned conversionFactor tentativePlantsPerPacket seedSource packetsFromCompany packetsFromRaising linkedOrderIds linkedSlotIds isExcessiveSowing sowedQuantity remainingSowingNeeded issuedDate sowingStartedDate sowingInProgress outwardId"
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
        raisingPacketsRemaining: getRemainingRaisingPackets(r),
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
function utcDayBound(ymd, end) {
  const m = String(ymd || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);
  return end
    ? new Date(Date.UTC(y, mo, d, 23, 59, 59, 999))
    : new Date(Date.UTC(y, mo, d, 0, 0, 0, 0));
}

function dateRangeQuery(from, to) {
  const range = {};
  const start = utcDayBound(from, false);
  const end = utcDayBound(to, true);
  if (start) range.$gte = start;
  if (end) range.$lte = end;
  return Object.keys(range).length ? range : null;
}

export const getSowingCompletions = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 40));
    const skip = (page - 1) * limit;
    const q = String(req.query.q || "").trim();
    const sortKey = String(req.query.sort || "sowDate");
    const sortDir = String(req.query.dir || "desc").toLowerCase() === "asc" ? 1 : -1;
    const sortField = {
      sowDate: "sowingCompletedDate",
      added: "createdAt",
      request: "requestNumber",
      plant: "plantName",
      plants: "sowedQuantity",
      packets: "packetsUsed",
      labour: "laboursLadies",
    }[sortKey] || "sowingCompletedDate";

    const match = {};
    if (req.query.plantId && mongoose.Types.ObjectId.isValid(req.query.plantId)) {
      match.plantId = new mongoose.Types.ObjectId(req.query.plantId);
    }
    if (
      req.query.subtypeId &&
      mongoose.Types.ObjectId.isValid(req.query.subtypeId)
    ) {
      match.subtypeId = new mongoose.Types.ObjectId(req.query.subtypeId);
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

    if (String(req.query.view || "") === "entries") {
      return await sendSowingEntries(req, res, { match, page, limit, skip, sortKey, sortDir });
    }

    match.sowingCompleted = true;
    const sowRange = dateRangeQuery(
      req.query.sowFrom || req.query.from,
      req.query.sowTo || req.query.to
    );
    if (sowRange) match.sowingCompletedDate = sowRange;
    const addedRange = dateRangeQuery(req.query.addedFrom, req.query.addedTo);
    if (addedRange) match.createdAt = addedRange;

    const [total, rows] = await Promise.all([
      SowingRequest.countDocuments(match),
      SowingRequest.find(match)
        .select(COMPLETION_SELECT)
        .populate("completedBy", "name")
        .sort({ [sortField]: sortDir, _id: sortDir })
        .skip(skip)
        .limit(limit)
        .lean(),
    ]);

    const { ordersByReqMap, outwardMap, slotMap } = await loadCompletionLookups(rows);
    const bufferByPlant = await sowingBufferPctByPlantId(rows.map((r) => r.plantId));

    const items = rows.map((r) => {
      const cf = resolveSowingPlantsPerPacket(r);
      const batchNumbers = outwardBatchNumbers(r, outwardMap);
      const outward = r.outwardId ? outwardMap.get(String(r.outwardId)) : null;
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
      const linkedOrders = covered.map((o) =>
        mapCoveredOrder(o, readyDateMeta, coverWindowDays)
      );

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
      const bufferPct = bufferByPlant.get(String(r.plantId)) || 0;
      const affectedSlot = buildAffectedSlot(slotRaw, reqBatch, r.shedName, bufferPct);
      const figures = paintSowingEntryNumbers(affectedSlot, {
        batch: reqBatch,
        linkedOrders,
        bufferPct,
        sowed: Number(reqBatch?.plantsSowed) || Number(r.sowedQuantity) || 0,
        mortalityReserve: reqBatch ? mortalityLeftOnBatch(reqBatch) : 0,
      });

      return {
        ...r,
        expectedPlants: Number(((Number(r.packetsRequested) || 0) * cf).toFixed(0)),
        isExcess: Boolean(r.isExcessiveSowing),
        excessPlants: figures.excess,
        bookedPlants: Number(reqBatch?.orderCoveredPlants) || 0,
        shedName: reqBatch?.shedName || r.shedName || "",
        linkedOrders,
        labourTotal:
          (Number(r.laboursLadies) || 0) + (Number(r.laboursGents) || 0),
        batchNumber: batchNumbers.join(", ") || "",
        batchNumbers,
        outwardNumber: outward?.outwardNumber || "",
        sowingDate,
        createdAt: r.createdAt || null,
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

const COMPLETION_SELECT =
  "requestNumber plantId plantName subtypeId subtypeName packetsRequested conversionFactor sowedQuantity laboursLadies laboursGents machineStartTime machineEndTime machineMinutes completionPhotos completionNotes shedName sowingCompleted sowingIncomplete uncoveredOrderIds sowingCompletedDate createdAt isExcessiveSowing linkedOrderIds linkedSlotIds seedSource packetsFromCompany packetsFromRaising packetsIssued packetsUsed packetsReturned raisingPacketsUsed raisingPacketsReturned returnRequestIds completionEvents completedBy outwardId";

function outwardBatchNumbers(r, outwardMap) {
  const outward = r.outwardId ? outwardMap.get(String(r.outwardId)) : null;
  return [
    ...new Set(
      (outward?.items || [])
        .map((it) => it?.batch?.batchNumber || it?.batchNumber || "")
        .filter(Boolean)
    ),
  ];
}

/** Covered orders, outwards and slots for a page of sowing requests. */
async function loadCompletionLookups(rows) {
  const requestIds = rows.map((r) => r._id).filter(Boolean);
  const outwardIds = [
    ...new Set(
      rows.map((r) => r.outwardId).filter(Boolean).map((id) => String(id))
    ),
  ];
  const allSlotIds = [
    ...new Set(rows.flatMap((r) => collectSlotIdsFromRequest(r))),
  ].map((id) => new mongoose.Types.ObjectId(id));

  const uncoveredIds = [
    ...new Set(
      rows.flatMap((r) => (r.uncoveredOrderIds || []).map((id) => String(id))).filter(Boolean)
    ),
  ].map((id) => new mongoose.Types.ObjectId(id));

  const [ordersByRequest, outwards, slotRows] = await Promise.all([
      requestIds.length
        ? Order.find({
            $or: [
              { sowingDoneRequestId: { $in: requestIds } },
              { "sowingPartialCover.requestId": { $in: requestIds } },
              ...(uncoveredIds.length ? [{ _id: { $in: uncoveredIds } }] : []),
            ],
          })
            .select(
              "orderId name farmer numberOfPlants additionalPlants sowingDone sowingDoneAt sowingDoneRequestId sowingPartialCover deliveryDate orderBookingDate createdAt"
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
  const put = (key, o) => {
    if (!key) return;
    if (!ordersByReqMap.has(key)) ordersByReqMap.set(key, []);
    const list = ordersByReqMap.get(key);
    if (!list.some((x) => String(x._id) === String(o._id))) list.push(o);
  };
  for (const o of ordersByRequest) {
    put(String(o.sowingDoneRequestId || ""), o);
    for (const p of o.sowingPartialCover || []) put(String(p.requestId || ""), o);
  }
  for (const r of rows) {
    for (const id of r.uncoveredOrderIds || []) {
      const o = ordersByRequest.find((x) => String(x._id) === String(id));
      if (o) put(String(r._id), o);
    }
  }
  return {
    ordersByReqMap,
    outwardMap: new Map(outwards.map((o) => [String(o._id), o])),
    slotMap: new Map(slotRows.map((s) => [String(s.slotId), s])),
  };
}

function mapCoveredOrder(o, readyDateMeta, coverWindowDays) {
  let coverOffsetDays = null;
  if (o.deliveryDate && readyDateMeta) {
    try {
      const del = new Date(o.deliveryDate);
      let ready = null;
      const dmy = String(readyDateMeta).match(/^(\d{2})-(\d{2})-(\d{4})$/);
      if (dmy) {
        ready = new Date(Number(dmy[3]), Number(dmy[2]) - 1, Number(dmy[1]), 12, 0, 0);
      } else {
        ready = new Date(readyDateMeta);
      }
      if (!Number.isNaN(del.getTime()) && ready && !Number.isNaN(ready.getTime())) {
        const d0 = Date.UTC(del.getFullYear(), del.getMonth(), del.getDate());
        const r0 = Date.UTC(ready.getFullYear(), ready.getMonth(), ready.getDate());
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
    plants: (Number(o.numberOfPlants) || 0) + (Number(o.additionalPlants) || 0),
    sowingDone: Boolean(o.sowingDone),
    coveredPlants: (() => {
      const total = (Number(o.numberOfPlants) || 0) + (Number(o.additionalPlants) || 0);
      const held = (Array.isArray(o.sowingPartialCover) ? o.sowingPartialCover : []).reduce(
        (s, row) => s + (Number(row.plants) || 0),
        0
      );
      return o.sowingDone ? total : held;
    })(),
    partiallyCovered:
      !o.sowingDone &&
      (Array.isArray(o.sowingPartialCover) ? o.sowingPartialCover : []).some((r) => Number(r.plants) > 0),
    sowingDoneAt: o.sowingDoneAt,
    bookingDate: o.orderBookingDate || o.createdAt || null,
    deliveryDate: o.deliveryDate || null,
    coverOffsetDays,
    inCoverWindow:
      coverOffsetDays == null ? true : Math.abs(coverOffsetDays) <= coverWindowDays,
  };
}

function buildAffectedSlot(slotRaw, reqBatch, shedName, sowingBufferPct = 0) {
  if (!slotRaw) return null;
  return {
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
    plantReadyDate: reqBatch?.plantReadyDate || slotRaw.plantReadyDate || null,
    plantReadyDays: reqBatch?.plantReadyDays ?? slotRaw.plantReadyDays ?? null,
    batchPlantsSowed: Number(reqBatch?.plantsSowed) || 0,
    batchPacketsUsed: Number(reqBatch?.packetsUsed) || 0,
    batchId: reqBatch?._id ? String(reqBatch._id) : null,
    batchDestroyedPlants: Number(reqBatch?.destroyedPlants) || 0,
    batchExpectedMortality: reqBatch ? mortalityLeftOnBatch(reqBatch) : 0,
    bufferPlants:
      !reqBatch || reqBatch.isIrrelevant
        ? 0
        : reqBatch.bufferPlants == null
          ? null
          : Math.max(0, Math.round(Number(reqBatch.bufferPlants) || 0)),
    mortalityMovedToExcess: Math.max(0, Math.floor(Number(reqBatch?.mortalityMovedToExcess) || 0)),
    requestDestroyedPlants: (slotRaw.sowingBatches || [])
      .filter((b) => reqBatch && String(b.sowingRequestId) === String(reqBatch.sowingRequestId))
      .reduce((s, b) => s + (Number(b.destroyedPlants) || 0), 0),
    shedName: reqBatch?.shedName || shedName || "",
    excessPlants: storedShownExcess(reqBatch, sowingBufferPct),
    bookedPlants: Number(reqBatch?.orderCoveredPlants) || 0,
  };
}

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

function ymdRange(from, to) {
  const range = {};
  if (YMD_RE.test(String(from || ""))) range.$gte = String(from);
  if (YMD_RE.test(String(to || ""))) range.$lte = String(to);
  return Object.keys(range).length ? range : null;
}

/** Orders don't record which entry covered them; pick the entry saved closest to sowingDoneAt. */
export function ordersForEntry(orders, entryTimes, entryTime) {
  if (entryTimes.length <= 1) return orders;
  const last = entryTimes[entryTimes.length - 1];
  return orders.filter((o) => {
    const t = o.sowingDoneAt ? new Date(o.sowingDoneAt).getTime() : NaN;
    if (!Number.isFinite(t)) return entryTime === last;
    let nearest = entryTimes[0];
    for (const x of entryTimes) {
      if (Math.abs(x - t) < Math.abs(nearest - t)) nearest = x;
    }
    return nearest === entryTime;
  });
}

/**
 * view=entries: one row per sow entry (partial or final), open requests included.
 * Sow / added date filters use the entry's IST day; slotId keeps entries applied to that slot.
 */
function actorId(value) {
  if (!value) return "";
  if (typeof value === "object") return String(value._id || "");
  return String(value);
}

async function sowingEntryAuthorNames(pageRows, reqMap) {
  const ids = [];
  for (const row of pageRows) {
    const request = reqMap.get(String(row._id));
    const event = request?.completionEvents?.[row.entryIndex];
    ids.push(actorId(event?.by), actorId(request?.completedBy), actorId(request?.requestedBy));
  }
  const unique = [...new Set(ids.filter((id) => mongoose.Types.ObjectId.isValid(id)))];
  const users = unique.length
    ? await User.find({ _id: { $in: unique } }).select("name").lean()
    : [];
  const names = new Map(users.map((user) => [String(user._id), user.name || ""]));
  const byEntry = new Map();
  for (const row of pageRows) {
    const request = reqMap.get(String(row._id));
    const event = request?.completionEvents?.[row.entryIndex];
    const name =
      names.get(actorId(event?.by)) ||
      names.get(actorId(request?.completedBy)) ||
      request?.completedBy?.name ||
      names.get(actorId(request?.requestedBy)) ||
      "";
    byEntry.set(`${row._id}-${row.entryIndex}`, name);
  }
  return byEntry;
}

async function sendSowingEntries(req, res, { match, page, limit, skip, sortKey, sortDir }) {
  const sortField = {
    sowDate: "entrySowDay",
    added: "entryAt",
    request: "requestNumber",
    plant: "plantName",
    plants: "entryPlants",
    trays: "entryPlants",
    mortality: "entryPlants",
    packets: "entryPackets",
    labour: "entryLabour",
  }[sortKey] || "entrySowDay";

  const istDay = (expr) => ({
    $dateToString: { format: "%Y-%m-%d", date: expr, timezone: "Asia/Kolkata" },
  });
  const dayMatch = {};
  const sowRange = ymdRange(req.query.sowFrom || req.query.from, req.query.sowTo || req.query.to);
  if (sowRange) dayMatch.entrySowDay = sowRange;
  const addedRange = ymdRange(req.query.addedFrom, req.query.addedTo);
  if (addedRange) dayMatch.entryAddedDay = addedRange;
  const slotId = String(req.query.slotId || "").trim();
  const slotFilter = mongoose.Types.ObjectId.isValid(slotId)
    ? { $or: [{ "ev.meta.appliedSlotId": slotId }, { "ev.meta.toSlotId": slotId }] }
    : null;

  const [facet] = await SowingRequest.aggregate([
    {
      $match: {
        ...match,
        "completionEvents.type": { $in: SOW_ENTRY_EVENT_TYPES },
        ...(slotFilter
          ? {
              $and: [
                {
                  $or: [
                    { "completionEvents.meta.appliedSlotId": slotId },
                    { "completionEvents.meta.toSlotId": slotId },
                  ],
                },
              ],
            }
          : {}),
      },
    },
    {
      $project: {
        requestNumber: 1,
        plantName: 1,
        sowingCompletedDate: 1,
        ev: "$completionEvents",
      },
    },
    { $unwind: { path: "$ev", includeArrayIndex: "entryIndex" } },
    {
      $match: {
        "ev.type": { $in: SOW_ENTRY_EVENT_TYPES },
        "ev.quantity": { $gt: 0 },
        ...(slotFilter || {}),
      },
    },
    {
      $addFields: {
        entryAt: "$ev.at",
        entrySowDay: {
          $ifNull: [
            {
              $let: {
                vars: { s: { $ifNull: ["$ev.meta.sowDate", ""] } },
                in: {
                  $switch: {
                    branches: [
                      {
                        case: { $regexMatch: { input: "$$s", regex: /^\d{4}-\d{2}-\d{2}/ } },
                        then: { $substrCP: ["$$s", 0, 10] },
                      },
                      {
                        case: { $regexMatch: { input: "$$s", regex: /^\d{2}-\d{2}-\d{4}/ } },
                        then: {
                          $concat: [
                            { $substrCP: ["$$s", 6, 4] },
                            "-",
                            { $substrCP: ["$$s", 3, 2] },
                            "-",
                            { $substrCP: ["$$s", 0, 2] },
                          ],
                        },
                      },
                    ],
                    default: null,
                  },
                },
              },
            },
            istDay({
              $cond: [
                { $and: [{ $eq: ["$ev.type", "SOW_COMPLETED"] }, "$sowingCompletedDate"] },
                "$sowingCompletedDate",
                "$ev.at",
              ],
            }),
          ],
        },
        entryAddedDay: istDay("$ev.at"),
        entryPlants: "$ev.quantity",
        entryPackets: { $ifNull: ["$ev.meta.packetsUsedNow", 0] },
        entryLabour: {
          $add: [
            { $ifNull: ["$ev.meta.laboursLadies", 0] },
            { $ifNull: ["$ev.meta.laboursGents", 0] },
          ],
        },
      },
    },
    ...(Object.keys(dayMatch).length ? [{ $match: dayMatch }] : []),
    {
      $facet: {
        total: [{ $count: "n" }],
        rows: [
          { $sort: { [sortField]: sortDir, entryAt: sortDir, _id: sortDir } },
          { $skip: skip },
          { $limit: limit },
          { $project: { _id: 1, entryIndex: 1 } },
        ],
      },
    },
  ]);
  const total = facet?.total?.[0]?.n || 0;
  const pageRows = facet?.rows || [];

  const requestIds = [...new Set(pageRows.map((p) => String(p._id)))];
  const requests = requestIds.length
    ? await SowingRequest.find({ _id: { $in: requestIds } })
        .select(COMPLETION_SELECT)
        .populate("completedBy", "name")
        .lean()
    : [];
  const reqMap = new Map(requests.map((r) => [String(r._id), r]));
  const { ordersByReqMap, outwardMap, slotMap } = await loadCompletionLookups(requests);
  const bufferByPlant = await sowingBufferPctByPlantId(requests.map((r) => r.plantId));
  const addedByNames = await sowingEntryAuthorNames(pageRows, reqMap);

  const items = [];
  for (const p of pageRows) {
    const r = reqMap.get(String(p._id));
    const events = r?.completionEvents || [];
    const ev = events[p.entryIndex];
    if (!r || !ev) continue;
    const meta = ev.meta || {};
    const at = ev.at ? new Date(ev.at) : null;
    const entryTimes = events
      .filter((e) => SOW_ENTRY_EVENT_TYPES.includes(e?.type) && Number(e.quantity) > 0)
      .map((e) => (e.at ? new Date(e.at).getTime() : 0));
    const entryTime = at ? at.getTime() : 0;
    const entryNo = entryTimes.indexOf(entryTime) + 1;
    const onlyEntry = entryTimes.length <= 1;

    let packetsUsed = Number(meta.packetsUsedNow);
    if (!Number.isFinite(packetsUsed)) packetsUsed = packetsNearEntry(events, at, "PACKETS_USED");
    const packetsReturned = packetsNearEntry(events, at, "PACKETS_RETURNED");

    const readyDateMeta = meta.orderReadyDate || meta.plantReadyDate || null;
    const coverWindowDays = Number(meta.orderCoverWindowDays ?? 4);
    const linkedOrders = ordersForEntry(
      ordersByReqMap.get(String(r._id)) || [],
      entryTimes,
      entryTime
    ).map((o) => mapCoveredOrder(o, readyDateMeta, coverWindowDays));

    const slotId = meta.appliedSlotId || meta.toSlotId || collectSlotIdsFromRequest(r)[0] || null;
    const slotRaw = slotId ? slotMap.get(String(slotId)) : null;
    const batches = (slotRaw?.sowingBatches || []).filter(
      (b) => String(b.sowingRequestId) === String(r._id)
    );
    const reqBatch =
      batches.find((b) => Number(b.plantsSowed) === Number(ev.quantity)) || batches[0];
    const shedName = meta.shedName || r.shedName || "";
    const bufferPct = bufferByPlant.get(String(r.plantId)) || 0;
    const entrySowed = Number(ev.quantity) || 0;
    const affectedSlot = buildAffectedSlot(slotRaw, reqBatch, shedName, bufferPct);
    const figures = paintSowingEntryNumbers(affectedSlot, {
      batch: reqBatch,
      linkedOrders,
      bufferPct,
      sowed: Number(reqBatch?.plantsSowed) || entrySowed,
      mortalityReserve: reqBatch ? mortalityLeftOnBatch(reqBatch) : 0,
    });
    const storedExcess = Number(meta.excessPlants) || 0;

    const batchNumbers = meta.batchNumber ? [meta.batchNumber] : outwardBatchNumbers(r, outwardMap);
    const outward = r.outwardId ? outwardMap.get(String(r.outwardId)) : null;
    const pick = (entryVal, reqVal) => (entryVal != null ? entryVal : onlyEntry ? reqVal : null);
    const ladies = Number(pick(meta.laboursLadies, r.laboursLadies)) || 0;
    const gents = Number(pick(meta.laboursGents, r.laboursGents)) || 0;

    items.push({
      ...r,
      _id: `${r._id}-${p.entryIndex}`,
      requestId: r._id,
      entryIndex: p.entryIndex,
      entryNo,
      entryCount: entryTimes.length,
      entryType: ev.type,
      isFinalEntry: ev.type === "SOW_COMPLETED",
      requestCompleted: Boolean(r.sowingCompleted),
      requestPlants: Number(r.sowedQuantity) || 0,
      requestPacketsUsed: Number(r.packetsUsed) || 0,
      requestPacketsReturned: Number(r.packetsReturned) || 0,
      sowedQuantity: Number(ev.quantity) || 0,
      traySize: Number(meta.traySize) > 0 ? Number(meta.traySize) : DEFAULT_TRAY_SIZE,
      trays: Number.isFinite(Number(meta.trays)) && meta.trays != null
        ? Number(meta.trays)
        : traysFor(ev.quantity, meta.traySize),
      packetsUsed: Math.round(packetsUsed * 100) / 100,
      packetsReturned: Math.round(packetsReturned * 100) / 100,
      laboursLadies: ladies,
      laboursGents: gents,
      labourTotal: ladies + gents,
      machineStartTime: pick(meta.machineStartTime, r.machineStartTime) || "",
      machineEndTime: pick(meta.machineEndTime, r.machineEndTime) || "",
      machineMinutes: Number(pick(meta.machineMinutes, r.machineMinutes)) || 0,
      completionNotes: pick(meta.notes, r.completionNotes) || "",
      shedName: reqBatch?.shedName || shedName,
      isExcess: Boolean(r.isExcessiveSowing) || storedExcess >= entrySowed,
      excessPlants: figures.excess,
      bookedPlants: Number(reqBatch?.orderCoveredPlants) || 0,
      linkedOrders,
      batchNumber: batchNumbers.join(", ") || "",
      batchNumbers,
      outwardNumber: outward?.outwardNumber || "",
      sowingDate:
        toSowYmd(meta.sowDate) ||
        toSowYmd(ev.type === "SOW_COMPLETED" ? r.sowingCompletedDate : null) ||
        toSowYmd(at) ||
        null,
      addedByName: addedByNames.get(`${r._id}-${p.entryIndex}`) || "",
      createdAt: at,
      requestCreatedAt: r.createdAt || null,
      affectedSlot,
    });
  }

  return res.json({
    success: true,
    view: "entries",
    items,
    total,
    page,
    limit,
    pages: Math.ceil(total / limit) || 0,
  });
}
