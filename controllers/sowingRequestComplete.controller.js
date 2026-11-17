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
  publicCompleteSowError,
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
import {
  istHalfOpenRange,
  istTodayYmd,
  needsComputedEntryFilter,
  entryMatchesFilters,
  sortEntryItems,
  pageEntryItems,
  sowDayStringRange,
} from "../utility/sowingEntriesQuery.js";
import { mortalityLeftOnBatch } from "../services/sowBatchMortalityRelease.service.js";
import { paintSowingEntryNumbers, storedShownExcess } from "../utility/sowingBatchExcessStamp.js";
import { listBatchChangeLog } from "../utility/sowingBatchChangeLog.js";
import { buildOrderSowingCoverBreakdown } from "../utility/orderSowingCoverBreakdown.js";
import { coverFromEnrichedOrders } from "../utility/sowingBatchCoverAttribution.js";

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

      // Sowing entry first (fail before creating return requests), then inventory + photos in parallel
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
              out: req.body.out || req.body.outDate || "",
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

      // Mark only orders linked / included on this sowing request (no ±4d auto-cover).
      // markOrdersSowed covers from saleable pool only; sowingDone only if enough cover.
      const orderResult =
        plantsSowed > 0
          ? await markOrdersSowed(locked, {
              sowedAt,
              plantsSowed,
              plantReadyDays,
              orderIds: locked.linkedOrderIds || [],
            })
          : { marked: 0, remainingUncovered: 0, orderPlantsCovered: 0 };

      // Covered = attributed from saleable; leftover saleable is bookable excess.
      const orderCoveredPlants = Math.max(
        0,
        Number(orderResult.orderPlantsCovered) || 0
      );
      const excessPlants = Math.max(
        0,
        Number(orderResult.remainingUncovered) || 0
      );
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
      message: publicCompleteSowError(error),
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
/** Completions UI may send composite id `ObjectId-entryIndex` — strip to real request id. */
function normalizeSowingRequestId(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  if (mongoose.Types.ObjectId.isValid(s) && String(new mongoose.Types.ObjectId(s)) === s) {
    return s;
  }
  const m = s.match(/^([a-f\d]{24})(?:-\d+)?$/i);
  if (m && mongoose.Types.ObjectId.isValid(m[1])) return m[1];
  return null;
}

export const editSowEntry = async (req, res) => {
  try {
    if (!isOfficeOrSuper(req.user)) {
      return res.status(403).json({
        success: false,
        message: "Only Office Admin or Super Admin can edit sow entry",
      });
    }
    const requestId = normalizeSowingRequestId(req.params.requestId);
    if (!requestId) {
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
      plantReadyDays:
        Number.isFinite(bodyReady) && bodyReady >= 0 ? bodyReady : undefined,
      plantReadyDate: req.body.plantReadyDate || req.body.readyDate,
      plantsSowed: Number.isFinite(bodyPlants) && bodyPlants > 0 ? bodyPlants : undefined,
      reason: req.body.reason,
    });

    // Keep original sow-entry event meta in sync so list/detail don't show stale ready/slot.
    const sowEv = [...(request.completionEvents || [])]
      .reverse()
      .find((e) => e?.type === "SOW_COMPLETED" || e?.type === "PLANTS_SOWED");
    if (sowEv) {
      sowEv.meta = {
        ...(sowEv.meta || {}),
        sowDate: result.sowingDate,
        plantReadyDate: result.toReadyDate,
        plantReadyDays: result.toPlantReadyDays,
        appliedSlotId: result.toSlotId,
        toSlotId: result.toSlotId,
        plantsSowed: result.plantsSowed,
        orderCoveredPlants: result.orderCoveredPlants,
        excessPlants: result.excessPlants,
        ordersMarked: result.ordersMarked,
        partialPlants: result.partialPlants,
      };
      if (Number(result.plantsSowed) > 0) sowEv.quantity = result.plantsSowed;
      request.markModified("completionEvents");
    }

    const movedN = Number(result?.ordersMoved?.moved) || 0;
    pushEvent(request, {
      type: "SOW_ENTRY_EDITED",
      by: req.user._id,
      quantity: result.plantsSowed,
      unit: "plants",
      message: result.slotChanged
        ? `Sow entry edited — moved slot (${result.fromReadyDate} → ${result.toReadyDate})${
            movedN ? ` · ${movedN} linked order(s) rebooked` : ""
          }`
        : `Sow entry edited — ready ${result.toReadyDate}${
            movedN ? ` · ${movedN} linked order(s) rebooked` : ""
          }`,
      meta: result,
    });
    await request.save();
    bustLiteCacheAsync();

    return res.json({
      success: true,
      message: result.slotChanged
        ? movedN
          ? `Sow entry updated · slot moved · ${movedN} linked order(s) updated`
          : "Sow entry updated and plants moved to ready-date slot"
        : movedN
          ? `Sow entry updated · ${movedN} linked order(s) updated`
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
async function pendingReceiveRequestIds() {
  const rows = await PlantSlot.aggregate([
    { $match: { "subtypeSlots.slots.sowingBatches.readyPlantsReceived": false } },
    { $unwind: "$subtypeSlots" },
    { $unwind: "$subtypeSlots.slots" },
    { $unwind: "$subtypeSlots.slots.sowingBatches" },
    {
      $match: {
        "subtypeSlots.slots.sowingBatches.readyPlantsReceived": false,
        "subtypeSlots.slots.sowingBatches.sowingRequestId": { $ne: null },
      },
    },
    { $group: { _id: "$subtypeSlots.slots.sowingBatches.sowingRequestId" } },
  ]);
  return rows.map((row) => row._id).filter((id) => id && mongoose.Types.ObjectId.isValid(String(id)));
}

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
    const lite = String(req.query.lite || "") === "1";
    const limit = Math.min(lite ? 2000 : 100, Math.max(1, parseInt(req.query.limit, 10) || 40));
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
    const recvFilter = String(req.query.readyPlantsReceived || "").trim().toLowerCase();
    if (recvFilter === "false" || recvFilter === "0" || recvFilter === "true" || recvFilter === "1") {
      const pendingIds = await pendingReceiveRequestIds();
      const wantPending = recvFilter === "false" || recvFilter === "0";
      match._id = wantPending ? { $in: pendingIds } : { $nin: pendingIds };
    }
    const sowRange = istHalfOpenRange(
      req.query.sowFrom || req.query.from,
      req.query.sowTo || req.query.to
    );
    if (sowRange) match.sowingCompletedDate = sowRange;
    const addedRange = dateRangeQuery(req.query.addedFrom, req.query.addedTo);
    if (addedRange) match.createdAt = addedRange;

    const computed = needsComputedEntryFilter(req.query);
    const listQuery = SowingRequest.find(match)
      .select(COMPLETION_SELECT)
      .populate("completedBy", "name")
      .sort({ [sortField]: sortDir, _id: sortDir });
    if (!computed) listQuery.skip(skip).limit(limit);
    const [total, rows] = await Promise.all([
      SowingRequest.countDocuments(match),
      listQuery.lean(),
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
      const preferredSlotId =
        sowCompletedEv?.meta?.appliedSlotId ||
        collectSlotIdsFromRequest(r)[0] ||
        null;
      const live = resolveLiveSlotBatch(
        slotMap,
        r._id,
        preferredSlotId,
        readyDateMeta
      );
      const slotRaw = live?.slotRaw || null;
      const reqBatches = slotRaw
        ? batchesForRequest(slotRaw, r._id)
        : live?.batch
          ? [live.batch]
          : [];
      const bufferPct = bufferByPlant.get(String(r.plantId)) || 0;
      const reqBatch =
        live?.batch || primaryBatchForRequest(reqBatches, bufferPct);
      const linkedOrders = enrichLinkedOrdersWithBatchCover(
        covered.map((o) => mapCoveredOrder(o, readyDateMeta, coverWindowDays)),
        {
          requestId: r._id,
          requestNumber: r.requestNumber,
          batch: reqBatch,
          rawOrders: covered,
        }
      );
      // Cover = sum of order refs (same as drawer). Batch stamp is cache only.
      const fromOrders = coverFromEnrichedOrders(linkedOrders);
      const stampedCover = reqBatches.reduce(
        (sum, b) => sum + (Number(b.orderCoveredPlants) || 0),
        0
      );
      const bookedPlants = fromOrders > 0 ? fromOrders : stampedCover;
      const sowedQty = Number(reqBatch?.plantsSowed) || Number(r.sowedQuantity) || 0;
      const batchForPaint =
        reqBatch && fromOrders > 0 && fromOrders !== Number(reqBatch.orderCoveredPlants || 0)
          ? { ...reqBatch, orderCoveredPlants: fromOrders }
          : reqBatch;
      const bookableExcess = batchForPaint
        ? storedShownExcess(batchForPaint, bufferPct)
        : reqBatches.reduce((sum, b) => sum + storedShownExcess(b, bufferPct), 0);
      const affectedSlot = buildAffectedSlot(
        slotRaw,
        batchForPaint,
        r.shedName,
        bufferPct,
        readyDateMeta
      );
      const figures = paintSowingEntryNumbers(affectedSlot, {
        batch: batchForPaint,
        linkedOrders,
        bufferPct,
        sowed: sowedQty,
        mortalityReserve: batchForPaint ? mortalityLeftOnBatch(batchForPaint) : 0,
      });
      if (affectedSlot) {
        affectedSlot.excessPlants = bookableExcess;
        affectedSlot.bookedPlants = bookedPlants;
        if (!affectedSlot.plantReadyDate && readyDateMeta) {
          affectedSlot.plantReadyDate = readyDateMeta;
        }
      }

      const readyPlantsReceived = reqBatch
        ? reqBatch.readyPlantsReceived !== false
        : true;
      const batchNumFromSlot = String(reqBatch?.batchNumber || "").trim();

      return {
        ...r,
        expectedPlants: Number(((Number(r.packetsRequested) || 0) * cf).toFixed(0)),
        isExcess: Boolean(r.isExcessiveSowing),
        excessPlants: bookableExcess,
        bookedPlants,
        shedName: reqBatch?.shedName || r.shedName || "",
        linkedOrders,
        labourTotal:
          (Number(r.laboursLadies) || 0) + (Number(r.laboursGents) || 0),
        batchNumber:
          batchNumFromSlot && !/^PENDING-/i.test(batchNumFromSlot)
            ? batchNumFromSlot
            : batchNumbers.join(", ") || batchNumFromSlot || "",
        batchNumbers,
        outwardNumber: outward?.outwardNumber || "",
        sowingDate,
        createdAt: r.createdAt || null,
        affectedSlot,
        readyPlantsReceived,
        readyPlantsPending: readyPlantsReceived === false,
      };
    });

    let outItems = items;
    let outTotal = total;
    if (recvFilter === "false" || recvFilter === "0") {
      outItems = outItems.filter((it) => it.readyPlantsReceived === false);
    } else if (recvFilter === "true" || recvFilter === "1") {
      outItems = outItems.filter((it) => it.readyPlantsReceived !== false);
    }
    if (computed) {
      const today = istTodayYmd();
      outItems = sortEntryItems(
        outItems.filter((it) => entryMatchesFilters(it, req.query, today)),
        req.query.sort,
        req.query.dir
      );
      const paged = pageEntryItems(outItems, page, limit);
      outItems = paged.items;
      outTotal = paged.total;
    }

    return res.json({
      success: true,
      items: outItems,
      total: outTotal,
      page,
      limit,
      pages: Math.ceil(outTotal / limit) || 0,
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

  const linkedOrderIds = [
    ...new Set(
      rows.flatMap((r) => (r.linkedOrderIds || []).map((id) => String(id))).filter(Boolean)
    ),
  ]
    .filter((id) => mongoose.Types.ObjectId.isValid(id))
    .map((id) => new mongoose.Types.ObjectId(id));

  const ORDER_COVER_SELECT =
    "orderId name farmer numberOfPlants additionalPlants sowingDone sowingDoneAt sowingDoneRequestId sowingPartialCover sowingCoverSources deliveryDate orderBookingDate createdAt orderStatus";

  const [ordersByRequestInitial, outwards, slotRows] = await Promise.all([
      requestIds.length
        ? Order.find({
            $or: [
              { sowingDoneRequestId: { $in: requestIds } },
              { "sowingPartialCover.requestId": { $in: requestIds } },
              // Multi-SR cover: order finished on one SR but still covered on others.
              { "sowingCoverSources.sowingRequestId": { $in: requestIds } },
              ...(uncoveredIds.length ? [{ _id: { $in: uncoveredIds } }] : []),
              ...(linkedOrderIds.length ? [{ _id: { $in: linkedOrderIds } }] : []),
            ],
          })
            .select(ORDER_COVER_SELECT)
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
      requestIds.length || allSlotIds.length
        ? PlantSlot.aggregate([
            {
              $match: {
                $or: [
                  ...(allSlotIds.length
                    ? [{ "subtypeSlots.slots._id": { $in: allSlotIds } }]
                    : []),
                  ...(requestIds.length
                    ? [
                        {
                          "subtypeSlots.slots.sowingBatches.sowingRequestId": {
                            $in: requestIds,
                          },
                        },
                      ]
                    : []),
                ],
              },
            },
            { $unwind: "$subtypeSlots" },
            { $unwind: "$subtypeSlots.slots" },
            {
              $match: {
                $or: [
                  ...(allSlotIds.length
                    ? [{ "subtypeSlots.slots._id": { $in: allSlotIds } }]
                    : []),
                  ...(requestIds.length
                    ? [
                        {
                          "subtypeSlots.slots.sowingBatches.sowingRequestId": {
                            $in: requestIds,
                          },
                        },
                      ]
                    : []),
                ],
              },
            },
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
                sowingBatches: { $ifNull: ["$subtypeSlots.slots.sowingBatches", []] },
              },
            },
          ])
        : Promise.resolve([]),
    ]);

  // Also load orders that took excess from these batches (may not be on request.linkedOrderIds)
  const knownOrderIds = new Set(ordersByRequestInitial.map((o) => String(o._id)));
  const excessOrderIds = [];
  for (const slot of slotRows) {
    for (const b of slot.sowingBatches || []) {
      for (const a of b.excessAllocations || []) {
        const id = String(a?.orderId || "");
        if (id && mongoose.Types.ObjectId.isValid(id) && !knownOrderIds.has(id)) {
          knownOrderIds.add(id);
          excessOrderIds.push(new mongoose.Types.ObjectId(id));
        }
      }
    }
  }
  const extraOrders = excessOrderIds.length
    ? await Order.find({ _id: { $in: excessOrderIds } })
        .select(ORDER_COVER_SELECT)
        .populate("farmer", "name mobileNumber")
        .lean()
    : [];
  const ordersByRequest = [...ordersByRequestInitial, ...extraOrders];

  const ordersByReqMap = new Map();
  const reqIdByNumber = new Map(
    rows
      .filter((r) => r?.requestNumber)
      .map((r) => [String(r.requestNumber), String(r._id)])
  );
  const put = (key, o) => {
    if (!key) return;
    if (!ordersByReqMap.has(key)) ordersByReqMap.set(key, []);
    const list = ordersByReqMap.get(key);
    if (!list.some((x) => String(x._id) === String(o._id))) list.push(o);
  };
  for (const o of ordersByRequest) {
    put(String(o.sowingDoneRequestId || ""), o);
    for (const p of o.sowingPartialCover || []) put(String(p.requestId || ""), o);
    // Sources = single truth across slots — attach order to every SR it took from.
    for (const s of o.sowingCoverSources || []) {
      const byId = String(s?.sowingRequestId || "");
      if (byId) put(byId, o);
      const byRn = reqIdByNumber.get(String(s?.requestNumber || ""));
      if (byRn) put(byRn, o);
    }
  }
  for (const r of rows) {
    for (const id of r.uncoveredOrderIds || []) {
      const o = ordersByRequest.find((x) => String(x._id) === String(id));
      if (o) put(String(r._id), o);
    }
    for (const id of r.linkedOrderIds || []) {
      const o = ordersByRequest.find((x) => String(x._id) === String(id));
      if (o) put(String(r._id), o);
    }
  }
  // Map excess-alloc orders onto the sowing request that owns the batch
  for (const slot of slotRows) {
    for (const b of slot.sowingBatches || []) {
      const reqKey =
        String(b.sowingRequestId || "") ||
        reqIdByNumber.get(String(b.requestNumber || "")) ||
        "";
      if (!reqKey) continue;
      for (const a of b.excessAllocations || []) {
        const o = ordersByRequest.find((x) => String(x._id) === String(a?.orderId));
        if (o) put(reqKey, o);
      }
    }
  }
  return {
    ordersByReqMap,
    outwardMap: new Map(outwards.map((o) => [String(o._id), o])),
    slotMap: new Map(slotRows.map((s) => [String(s.slotId), s])),
  };
}

/** Plants already on this order that are not a finished sow flag. Sources win over the same request's partial hold. */
function openCoverPlants(order) {
  const sources = Array.isArray(order?.sowingCoverSources) ? order.sowingCoverSources : [];
  const sourceKeys = new Set(
    sources.map((row) => String(row?.sowingRequestId || row?.requestNumber || "")).filter(Boolean)
  );
  let plants = sources.reduce(
    (sum, row) => sum + Math.max(0, Math.floor(Number(row?.plants) || 0)),
    0
  );
  const partials = Array.isArray(order?.sowingPartialCover) ? order.sowingPartialCover : [];
  for (const row of partials) {
    const key = String(row?.requestId || row?.sowingRequestId || "");
    if (key && sourceKeys.has(key)) continue;
    plants += Math.max(0, Math.floor(Number(row?.plants) || 0));
  }
  return plants;
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
  const orderStatus = String(o.orderStatus || "").toUpperCase();
  const dispatched = ["DISPATCHED", "DISPATCH_PROCESS", "COMPLETED", "PARTIALLY_COMPLETED"].includes(
    orderStatus
  );
  return {
    orderId: o._id,
    orderNumber: o.orderId,
    farmerName: o.farmer?.name || o.name || "",
    farmerMobile: o.farmer?.mobileNumber || "",
    plants: (Number(o.numberOfPlants) || 0) + (Number(o.additionalPlants) || 0),
    sowingDone: (() => {
      const total = (Number(o.numberOfPlants) || 0) + (Number(o.additionalPlants) || 0);
      const held = openCoverPlants(o);
      return total > 0 && held >= total;
    })(),
    orderStatus,
    dispatched,
    coveredPlants: (() => {
      const total = (Number(o.numberOfPlants) || 0) + (Number(o.additionalPlants) || 0);
      const held = openCoverPlants(o);
      return total > 0 ? Math.min(total, held) : held;
    })(),
    partiallyCovered: (() => {
      const total = (Number(o.numberOfPlants) || 0) + (Number(o.additionalPlants) || 0);
      const held = openCoverPlants(o);
      return held > 0 && held < total;
    })(),
    sowingDoneAt: o.sowingDoneAt,
    bookingDate: o.orderBookingDate || o.createdAt || null,
    deliveryDate: o.deliveryDate || null,
    coverOffsetDays,
    inCoverWindow:
      coverOffsetDays == null ? true : Math.abs(coverOffsetDays) <= coverWindowDays,
  };
}

/**
 * Attach how much this sowing covered (FIFO vs excess) + other sowings' excess.
 * Prefer batch.excessAllocations + order.sowingCoverSources over full order size.
 */
export function enrichLinkedOrdersWithBatchCover(
  linkedOrders,
  { requestId, requestNumber, batch, rawOrders = [] } = {}
) {
  const rawById = new Map((rawOrders || []).map((o) => [String(o._id), o]));
  const allocByOrder = new Map();
  for (const a of batch?.excessAllocations || []) {
    const id = String(a?.orderId || "");
    if (!id) continue;
    allocByOrder.set(id, (allocByOrder.get(id) || 0) + Math.max(0, Math.floor(Number(a.plants) || 0)));
  }

  const sameRequest = (src) =>
    (requestId && String(src?.sowingRequestId || "") === String(requestId)) ||
    (requestNumber && String(src?.requestNumber || "") === String(requestNumber));

  const enrichOne = (lo, raw) => {
    const sources = Array.isArray(raw?.sowingCoverSources) ? raw.sowingCoverSources : [];
    const fromThisSrc = sources
      .filter(sameRequest)
      .reduce((s, x) => s + Math.max(0, Math.floor(Number(x.plants) || 0)), 0);
    const otherCoverSources = sources
      .filter((s) => !sameRequest(s) && Math.max(0, Math.floor(Number(s.plants) || 0)) > 0)
      .map((s) => ({
        requestNumber: s.requestNumber || "",
        sowingRequestId: s.sowingRequestId ? String(s.sowingRequestId) : "",
        plants: Math.max(0, Math.floor(Number(s.plants) || 0)),
        offsetDays: s.offsetDays ?? null,
      }));
    const excessAlloc = allocByOrder.get(String(lo.orderId)) || 0;

    let fromThisRaw = fromThisSrc;
    if (fromThisRaw < 1 && excessAlloc > 0) fromThisRaw = excessAlloc;
    if (fromThisRaw < 1) {
      const heldHere = (Array.isArray(raw?.sowingPartialCover) ? raw.sowingPartialCover : [])
        .filter(
          (p) =>
            String(p?.requestId || "") === String(requestId) ||
            String(p?.sowingRequestId || "") === String(requestId)
        )
        .reduce((s, p) => s + Math.max(0, Math.floor(Number(p.plants) || 0)), 0);
      if (heldHere > 0) fromThisRaw = heldHere;
    }

    let coverKind = "fifo";
    if (excessAlloc > 0 && fromThisRaw <= excessAlloc) coverKind = "excess";
    else if (excessAlloc > 0) coverKind = "mixed";

    const fromOthers = otherCoverSources.reduce((s, x) => s + x.plants, 0);
    const breakdown = buildOrderSowingCoverBreakdown({
      orderPlants: lo.plants,
      fromThisRaw,
      fromOthers,
      excessFromThisRaw: excessAlloc,
      sowingDone: Boolean(raw?.sowingDone ?? lo.sowingDone),
      coverKind,
      otherCoverSources,
    });

    return {
      ...lo,
      ...breakdown,
      /** @deprecated use sownHere — kept for older FE */
      fromThisSowing: breakdown.sownHere,
      coverFromRequestNumber: requestNumber || "",
      coverFromRequestId: requestId ? String(requestId) : "",
    };
  };

  const seen = new Set();
  const out = [];
  for (const lo of linkedOrders || []) {
    const id = String(lo.orderId || "");
    seen.add(id);
    out.push(enrichOne(lo, rawById.get(id)));
  }

  // Excess-only covers: ensure they appear even if not on sowingRequest.linkedOrderIds
  for (const [orderId, plants] of allocByOrder) {
    if (seen.has(orderId) || plants < 1) continue;
    const raw = rawById.get(orderId);
    if (!raw) continue;
    const readyMeta =
      batch?.plantReadyDate ||
      null;
    const mapped = mapCoveredOrder(raw, readyMeta, 4);
    out.push(enrichOne(mapped, raw));
    seen.add(orderId);
  }

  // Drawer = orders this sowing actually covered (not bare linked / uncovered stubs).
  return out.filter((o) => Number(o?.sownHere) > 0 || Number(o?.excessFromThisSowing) > 0);
}

/**
 * Prefer live batch by request (ready day), not a hard appliedSlotId.
 * Falls back to ready-day match, then preferred slot id.
 */
function resolveLiveSlotBatch(slotMap, requestId, preferredSlotId, readyDateMeta) {
  const live = findLiveBatchInSlotMap(slotMap, requestId);
  if (live?.batch) return live;

  const ready = String(readyDateMeta || "").trim();
  if (ready) {
    for (const slotRaw of slotMap.values()) {
      const dayHit =
        slotRaw.startDay === ready ||
        slotRaw.endDay === ready ||
        slotRaw.plantReadyDate === ready ||
        (slotRaw.sowingBatches || []).some((b) => b?.plantReadyDate === ready);
      if (!dayHit) continue;
      const batches = batchesForRequest(slotRaw, requestId);
      if (!batches.length) continue;
      return {
        batch: primaryBatchForRequest(batches),
        slotRaw,
      };
    }
  }

  if (preferredSlotId) {
    const slotRaw = slotMap.get(String(preferredSlotId));
    if (slotRaw) {
      const batches = batchesForRequest(slotRaw, requestId);
      return {
        batch: primaryBatchForRequest(batches, 0),
        slotRaw,
      };
    }
  }
  return null;
}

function buildAffectedSlot(slotRaw, reqBatch, shedName, sowingBufferPct = 0, readyDateFallback = null) {
  // Ready day alone is enough for Ready / Exp. ready — slot stamp is optional.
  if (!slotRaw && !reqBatch && !readyDateFallback) return null;
  const ready =
    reqBatch?.plantReadyDate ||
    slotRaw?.plantReadyDate ||
    readyDateFallback ||
    null;
  const startDay = slotRaw?.startDay || ready || null;
  const endDay = slotRaw?.endDay || ready || null;
  return {
    slotId: slotRaw?.slotId ? String(slotRaw.slotId) : null,
    label:
      startDay && endDay && startDay !== endDay
        ? `${startDay} → ${endDay}`
        : startDay || ready || "—",
    startDay,
    endDay,
    month: slotRaw?.month || null,
    year: slotRaw?.year || null,
    primarySowed: Number(slotRaw?.primarySowed) || 0,
    officeSowed: Number(slotRaw?.officeSowed) || 0,
    plantsSowed: Number(slotRaw?.plantsSowed) || Number(reqBatch?.plantsSowed) || 0,
    availablePlants: Number(slotRaw?.availablePlants) || 0,
    orderReservedPlants: Number(slotRaw?.orderReservedPlants) || 0,
    totalBookedPlants: Number(slotRaw?.totalBookedPlants) || 0,
    totalPlants: Number(slotRaw?.totalPlants) || 0,
    excessivePlants: Number(slotRaw?.excessivePlants) || 0,
    sowingDate: reqBatch?.sowingDate || slotRaw?.sowingDate || null,
    plantReadyDate: ready,
    plantReadyDays: reqBatch?.plantReadyDays ?? slotRaw?.plantReadyDays ?? null,
    batchPlantsSowed: Number(reqBatch?.plantsSowed) || 0,
    batchPacketsUsed: Number(reqBatch?.packetsUsed) || 0,
    batchId: reqBatch?._id ? String(reqBatch._id) : null,
    batchNumber: String(reqBatch?.batchNumber || "").trim() || null,
    readyPlantsReceived: reqBatch ? reqBatch.readyPlantsReceived !== false : true,
    batchDestroyedPlants: Number(reqBatch?.destroyedPlants) || 0,
    batchExpectedMortality: reqBatch ? mortalityLeftOnBatch(reqBatch) : 0,
    bufferPlants:
      !reqBatch || reqBatch.isIrrelevant || reqBatch.noMortalityReserve
        ? 0
        : reqBatch.bufferPlants == null
          ? null
          : Math.max(0, Math.round(Number(reqBatch.bufferPlants) || 0)),
    mortalityMovedToExcess: Math.max(0, Math.floor(Number(reqBatch?.mortalityMovedToExcess) || 0)),
    excessMovedToMortality: Math.max(0, Math.floor(Number(reqBatch?.excessMovedToMortality) || 0)),
    noMortalityReserve: Boolean(reqBatch?.noMortalityReserve),
    requestDestroyedPlants: (slotRaw?.sowingBatches || [])
      .filter((b) => reqBatch && String(b.sowingRequestId) === String(reqBatch.sowingRequestId))
      .reduce((s, b) => s + (Number(b.destroyedPlants) || 0), 0),
    shedName: reqBatch?.shedName || shedName || "",
    excessPlants: storedShownExcess(reqBatch, sowingBufferPct),
    bookedPlants: Number(reqBatch?.orderCoveredPlants) || 0,
    changeLog: listBatchChangeLog(reqBatch),
    isIrrelevant: Boolean(reqBatch?.isIrrelevant),
  };
}

function ymdRange(from, to) {
  return sowDayStringRange(from, to);
}


/** Batches on a slot that belong to one sowing request. */
function batchesForRequest(slotRaw, requestId) {
  return (slotRaw?.sowingBatches || []).filter(
    (b) => String(b.sowingRequestId) === String(requestId)
  );
}

/**
 * After sow-entry edits, event.meta.appliedSlotId can be stale.
 * Prefer the live batch still on plant slots for this request.
 */
function findLiveBatchInSlotMap(slotMap, requestId) {
  let best = null;
  let bestSlot = null;
  let bestPending = false;
  for (const slotRaw of slotMap.values()) {
    for (const b of slotRaw.sowingBatches || []) {
      if (String(b.sowingRequestId) !== String(requestId)) continue;
      const pending = b.readyPlantsReceived === false;
      const plants = Number(b.plantsSowed) || 0;
      const bestPlants = Number(best?.plantsSowed) || 0;
      if (
        !best ||
        (pending && !bestPending) ||
        (pending === bestPending && plants > bestPlants)
      ) {
        best = b;
        bestSlot = slotRaw;
        bestPending = pending;
      }
    }
  }
  return best && bestSlot ? { batch: best, slotRaw: bestSlot } : null;
}

/** Request-level list: use the batch with the most leftover (not the first insert). */
function primaryBatchForRequest(batches, sowingBufferPct = 0) {
  if (!batches?.length) return null;
  return [...batches].sort((a, b) => {
    const ea = storedShownExcess(a, sowingBufferPct);
    const eb = storedShownExcess(b, sowingBufferPct);
    if (eb !== ea) return eb - ea;
    return (Number(b.plantsSowed) || 0) - (Number(a.plantsSowed) || 0);
  })[0];
}

/**
 * Map a completion entry to a slot batch. Entry qty often differs from plantsSowed
 * after office edits — claim unused batches by closest sowed count.
 */
export function pickSowingBatchForEntry(batches, entryQty, claimedIds = null) {
  const all = batches || [];
  const pool = claimedIds
    ? all.filter((b) => {
        const id = b?._id != null ? String(b._id) : "";
        return id && !claimedIds.has(id);
      })
    : all;
  // Do not reuse a batch already claimed by another entry — that duplicated full cover/excess.
  if (!pool.length) return null;
  const qty = Math.max(0, Math.floor(Number(entryQty) || 0));
  const exact = pool.find((b) => Number(b.plantsSowed) === qty);
  if (exact) return exact;
  return [...pool].sort((a, b) => {
    const da = Math.abs((Number(a.plantsSowed) || 0) - qty);
    const db = Math.abs((Number(b.plantsSowed) || 0) - qty);
    if (da !== db) return da - db;
    return storedShownExcess(b) - storedShownExcess(a);
  })[0];
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

async function applyPendingReceiveMatch(match, query) {
  const recvFilter = String(query?.readyPlantsReceived || "").trim().toLowerCase();
  if (!["false", "0", "true", "1"].includes(recvFilter)) return;
  const pendingIds = await pendingReceiveRequestIds();
  const wantPending = recvFilter === "false" || recvFilter === "0";
  match._id = wantPending ? { $in: pendingIds } : { $nin: pendingIds };
}

async function sendSowingEntries(req, res, { match, page, limit, skip, sortKey, sortDir }) {
  await applyPendingReceiveMatch(match, req.query);
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
        rows: needsComputedEntryFilter(req.query)
          ? [{ $project: { _id: 1, entryIndex: 1 } }]
          : [
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
  const claimedBatchByRequest = new Map();
  const excessShownForBatch = new Set();
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
    const rawEntryOrders = ordersForEntry(
      ordersByReqMap.get(String(r._id)) || [],
      entryTimes,
      entryTime
    );

    const claimKey = String(r._id);
    if (!claimedBatchByRequest.has(claimKey)) claimedBatchByRequest.set(claimKey, new Set());
    const claimedIds = claimedBatchByRequest.get(claimKey);
    const entrySowed = Number(ev.quantity) || 0;
    // Ready day / live batch first — do not hard-require appliedSlotId.
    const preferredSlotId =
      meta.toSlotId || meta.appliedSlotId || collectSlotIdsFromRequest(r)[0] || null;
    const live = resolveLiveSlotBatch(slotMap, r._id, preferredSlotId, readyDateMeta);
    let slotRaw = live?.slotRaw || null;
    let reqBatch = null;
    if (live?.batch && !claimedIds.has(String(live.batch._id))) {
      reqBatch = live.batch;
    } else {
      const batches = batchesForRequest(slotRaw, r._id);
      reqBatch = pickSowingBatchForEntry(batches, entrySowed, claimedIds);
    }
    if (reqBatch?._id) claimedIds.add(String(reqBatch._id));
    const shedName = reqBatch?.shedName || meta.shedName || r.shedName || "";
    const bufferPct = bufferByPlant.get(String(r.plantId)) || 0;
    const batchKey = reqBatch?._id ? String(reqBatch._id) : "";
    // Entry qty can differ from plantsSowed after edits — show each batch leftover once.
    const ownsBatch = Boolean(reqBatch) && (!batchKey || !excessShownForBatch.has(batchKey));
    if (ownsBatch && batchKey) excessShownForBatch.add(batchKey);
    const entryOrdersForAttr = [
      ...rawEntryOrders,
      ...(ordersByReqMap.get(String(r._id)) || []),
    ];
    const linkedOrders = enrichLinkedOrdersWithBatchCover(
      rawEntryOrders.map((o) => mapCoveredOrder(o, readyDateMeta, coverWindowDays)),
      {
        requestId: r._id,
        requestNumber: r.requestNumber,
        batch: ownsBatch || onlyEntry ? reqBatch : null,
        rawOrders: entryOrdersForAttr,
      }
    );
    const fromOrders =
      ownsBatch || (onlyEntry && reqBatch) ? coverFromEnrichedOrders(linkedOrders) : 0;
    const batchForPaint =
      reqBatch && fromOrders > 0 && fromOrders !== Number(reqBatch.orderCoveredPlants || 0)
        ? { ...reqBatch, orderCoveredPlants: fromOrders }
        : reqBatch;
    const affectedSlot = buildAffectedSlot(
      slotRaw,
      batchForPaint,
      shedName,
      bufferPct,
      readyDateMeta
    );
    if (affectedSlot && !affectedSlot.plantReadyDate && readyDateMeta) {
      affectedSlot.plantReadyDate = readyDateMeta;
    }
    const figures = paintSowingEntryNumbers(affectedSlot, {
      batch: ownsBatch || onlyEntry ? batchForPaint : null,
      linkedOrders: ownsBatch || onlyEntry ? linkedOrders : [],
      bufferPct,
      sowed:
        ownsBatch || onlyEntry
          ? Number(batchForPaint?.plantsSowed) || entrySowed
          : entrySowed,
      mortalityReserve:
        ownsBatch || onlyEntry
          ? batchForPaint
            ? mortalityLeftOnBatch(batchForPaint)
            : 0
          : 0,
      showBookableExcess: ownsBatch || onlyEntry,
    });
    const storedExcess = Number(meta.excessPlants) || 0;
    const batchCover = Number(reqBatch?.orderCoveredPlants) || 0;
    // Partial rows must not re-sum the full linked order list (fake cover after add-plants).
    const metaCover =
      meta.orderCoveredPlants != null && meta.orderCoveredPlants !== ""
        ? Math.max(0, Number(meta.orderCoveredPlants) || 0)
        : null;
    let bookedPlants = 0;
    if (ownsBatch || (onlyEntry && reqBatch)) {
      bookedPlants = fromOrders > 0 ? fromOrders : batchCover;
    } else if (metaCover != null) bookedPlants = metaCover;
    else if (onlyEntry) {
      bookedPlants = linkedOrders.reduce(
        (sum, o) => sum + (Number(o.coveredPlants) || 0),
        0
      );
    }
    if (affectedSlot) affectedSlot.bookedPlants = bookedPlants;

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
      sowedQuantity:
        ownsBatch || onlyEntry
          ? Number(reqBatch?.plantsSowed) || Number(ev.quantity) || 0
          : Number(ev.quantity) || 0,
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
      bookedPlants,
      linkedOrders,
      batchNumber: batchNumbers.join(", ") || "",
      batchNumbers,
      outwardNumber: outward?.outwardNumber || "",
      sowingDate:
        toSowYmd(reqBatch?.sowingDate) ||
        toSowYmd(meta.sowDate) ||
        toSowYmd(ev.type === "SOW_COMPLETED" ? r.sowingCompletedDate : null) ||
        toSowYmd(at) ||
        null,
      addedByName: addedByNames.get(`${r._id}-${p.entryIndex}`) || "",
      createdAt: at,
      requestCreatedAt: r.createdAt || null,
      affectedSlot,
      readyPlantsReceived: reqBatch ? reqBatch.readyPlantsReceived !== false : true,
      readyPlantsPending: reqBatch ? reqBatch.readyPlantsReceived === false : false,
    });
  }

  let outItems = items;
  let outTotal = total;
  if (needsComputedEntryFilter(req.query)) {
    const today = istTodayYmd();
    outItems = sortEntryItems(
      items.filter((it) => entryMatchesFilters(it, req.query, today)),
      req.query.sort || sortKey,
      req.query.dir
    );
    const paged = pageEntryItems(outItems, page, limit);
    outItems = paged.items;
    outTotal = paged.total;
  }

  return res.json({
    success: true,
    view: "entries",
    items: String(req.query.lite || "") === "1" ? outItems.map(liteSowingEntry) : outItems,
    total: outTotal,
    page,
    limit,
    pages: Math.ceil(outTotal / limit) || 0,
  });
}

/** Mobile sowing tab: sowed, spare plants, and expected mortality. No request payload. */
function liteSowingEntry(item) {
  const sowed = Math.max(0, Math.round(Number(item.sowedQuantity) || 0));
  const spare = Math.min(
    sowed,
    Math.max(0, Math.round(Number(item.excessPlants) || Number(item.affectedSlot?.excessPlants) || 0)),
  );
  const slot = item.affectedSlot || {};
  const mortalityRaw =
    slot.batchExpectedMortality != null
      ? Number(slot.batchExpectedMortality)
      : slot.bufferPlants != null
        ? Math.max(0, Number(slot.bufferPlants) - (Number(slot.mortalityMovedToExcess) || 0))
        : 0;
  return {
    id: String(item._id || ""),
    plantName: item.plantName || "Plant",
    subtypeName: item.subtypeName || "",
    sowingDate: item.sowingDate || "",
    shedName: item.shedName || "",
    sowed,
    primary: Math.max(0, sowed - spare),
    buffer: spare,
    mortality: Math.max(0, Math.round(mortalityRaw) || 0),
    addedByName: item.addedByName || "",
  };
}
