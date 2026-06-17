import catchAsync from "../utility/catchAsync.js";
import generateResponse from "../utility/responseFormat.js";
import {
  buildCounterPatchSet,
  ensureSecondaryDispatchLedgerIndexes,
  querySecondaryDispatchLedgerLines,
  recordSecondaryDispatchLedger,
  summarizeSecondaryDispatchLedger,
} from "../services/secondaryDispatchLedgerWorkflow.service.js";
import { SECONDARY_DISPATCH_LEDGER_ACTIONS } from "../utils/secondaryDispatchLedger.js";

const LOAD = SECONDARY_DISPATCH_LEDGER_ACTIONS.LOAD;
const UNLOAD = SECONDARY_DISPATCH_LEDGER_ACTIONS.UNLOAD;

function pickAction(raw) {
  const s = String(raw || "").trim().toUpperCase();
  if (s === LOAD) return LOAD;
  if (s === UNLOAD) return UNLOAD;
  return null;
}

/**
 * Admin utility: ensure indexes once after deploy.
 */
export const bootstrapSecondaryDispatchLedgerController = catchAsync(
  async (req, res) => {
    await ensureSecondaryDispatchLedgerIndexes();
    return res.status(200).json(
      generateResponse(true, "Secondary dispatch ledger indexes ensured", {
        ok: true,
      }),
    );
  },
);

/**
 * Generic ledger write endpoint.
 * This can be called from existing load/unload handlers, or directly during migration/testing.
 */
export const writeSecondaryDispatchLedgerController = catchAsync(
  async (req, res) => {
    const { dispatchId } = req.params;
    const action = pickAction(req.body?.action);
    if (!dispatchId) {
      return res
        .status(400)
        .json(generateResponse(false, "dispatchId required", null));
    }
    if (!action) {
      return res
        .status(400)
        .json(generateResponse(false, "action must be LOAD or UNLOAD", null));
    }

    const result = await recordSecondaryDispatchLedger({
      action,
      dispatchId,
      requestPayload: req.body?.requestPayload || {},
      resolvedAllocations: Array.isArray(req.body?.resolvedAllocations)
        ? req.body.resolvedAllocations
        : [],
      linkedOrderId: req.body?.linkedOrderId || null,
      plantRowIndex: req.body?.plantRowIndex,
      remarks: req.body?.remarks || null,
      createdBy: req.user?._id || null,
      traceId: req.body?.traceId || null,
    });

    return res.status(200).json(
      generateResponse(true, "Secondary dispatch ledger recorded", {
        reused: result.reused,
        event: result.event,
        lineCount: result.lines.length,
        deltas: result.deltas,
        counterPatch: buildCounterPatchSet(result.deltas),
      }),
    );
  },
);

/**
 * List ledger lines with filters.
 */
export const listSecondaryDispatchLedgerController = catchAsync(
  async (req, res) => {
    const data = await querySecondaryDispatchLedgerLines({
      dispatchId: req.query.dispatchId,
      linkedOrderId: req.query.linkedOrderId,
      batchId: req.query.batchId,
      secondaryInwardId: req.query.secondaryInwardId,
      secondaryOutwardId: req.query.secondaryOutwardId,
      linkedBookingSlotId: req.query.linkedBookingSlotId,
      action: pickAction(req.query.action),
      from: req.query.from,
      to: req.query.to,
      page: req.query.page,
      limit: req.query.limit,
    });
    return res
      .status(200)
      .json(generateResponse(true, "Secondary dispatch ledger lines", data));
  },
);

/**
 * Summarize ledger lines with same filters.
 */
export const summarySecondaryDispatchLedgerController = catchAsync(
  async (req, res) => {
    const summary = await summarizeSecondaryDispatchLedger({
      dispatchId: req.query.dispatchId,
      linkedOrderId: req.query.linkedOrderId,
      batchId: req.query.batchId,
      secondaryInwardId: req.query.secondaryInwardId,
      secondaryOutwardId: req.query.secondaryOutwardId,
      linkedBookingSlotId: req.query.linkedBookingSlotId,
      action: pickAction(req.query.action),
      from: req.query.from,
      to: req.query.to,
    });
    return res
      .status(200)
      .json(generateResponse(true, "Secondary dispatch ledger summary", summary));
  },
);

