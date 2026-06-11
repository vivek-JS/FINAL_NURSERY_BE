import SecondaryDispatchAvailability from "../models/secondaryDispatchAvailability.model.js";
import PlantOutward from "../models/plantOutward.model.js";
import AppError from "../utility/appError.js";

function sortFifoByDateAsc(lines) {
  return [...lines].sort(
    (a, b) =>
      new Date(a.secondaryInwardDate).getTime() -
      new Date(b.secondaryInwardDate).getTime()
  );
}

/**
 * When the ledger row is missing (pre-migration DB) but PlantOutward already has secondary inwards,
 * build FIFO from current subdocs so outward + ledger stay in sync.
 */
export async function bootstrapLedgerFromPlantOutward(session, batchId, performedBy) {
  const po = await PlantOutward.findOne({ batchId }).session(session).exec();
  if (!po) {
    throw new AppError("Plant outward not found for ledger bootstrap", 404);
  }

  const fifoLines = (po.secondaryInward || []).map((si) => {
    const rem = Math.max(0, Number(si.availableQuantity) || 0);
    const tot = Math.max(
      rem,
      Number(si.totalQuantity) || 0,
      1
    );
    return {
      secondaryInwardId: si._id,
      plantOutwardId: po._id,
      secondaryInwardDate: si.secondaryInwardDate,
      remainingPlants: rem,
      initialPlants: tot,
      size: si.size,
    };
  });

  const doc = new SecondaryDispatchAvailability({
    dispatchBatchId: batchId,
    plantOutwardId: po._id,
    fifoLines: sortFifoByDateAsc(fifoLines),
    availabilityTrail: [],
  });
  doc.recalcTotal();
  const t = doc.totalAvailablePlants;
  doc.availabilityTrail.unshift({
    action: "ADJUST",
    activityName: "Ledger bootstrap",
    quantity: t,
    previousTotalAvailable: 0,
    newTotalAvailable: t,
    reason: "Backfilled FIFO from existing PlantOutward secondary inward lines",
    plantOutwardId: po._id,
    performedBy: performedBy || undefined,
  });
  await doc.save({ session });
  return doc;
}

/**
 * After secondary inward (plantation): add plants to batch ledger + FIFO (ordered by planting date).
 */
export async function recordSecondaryInwardOnLedger(session, payload) {
  const {
    dispatchBatchId,
    plantOutwardId,
    secondaryInwardId,
    secondaryInwardDate,
    plants,
    size,
    performedBy,
  } = payload;

  if (!dispatchBatchId || !plantOutwardId || !secondaryInwardId || plants == null) {
    throw new AppError("Ledger inward: missing required ids or quantity", 400);
  }
  const qty = Number(plants);
  if (!Number.isFinite(qty) || qty < 1 || !Number.isInteger(qty)) {
    throw new AppError("Ledger inward: invalid plant quantity", 400);
  }

  let doc = await SecondaryDispatchAvailability.findOne({ dispatchBatchId })
    .session(session)
    .exec();

  const prevTotal = doc ? doc.totalAvailablePlants : 0;

  if (!doc) {
    doc = new SecondaryDispatchAvailability({
      dispatchBatchId,
      plantOutwardId,
      totalAvailablePlants: 0,
      fifoLines: [],
      availabilityTrail: [],
    });
  }

  const line = {
    secondaryInwardId,
    plantOutwardId,
    secondaryInwardDate: new Date(secondaryInwardDate),
    remainingPlants: qty,
    initialPlants: qty,
    size: size || undefined,
  };

  doc.fifoLines = sortFifoByDateAsc([...(doc.fifoLines || []), line]);
  doc.recalcTotal();

  doc.availabilityTrail.unshift({
    action: "ADD_SECONDARY_INWARD",
    activityName: "Secondary inward (plantation)",
    quantity: qty,
    previousTotalAvailable: prevTotal,
    newTotalAvailable: doc.totalAvailablePlants,
    reason: "Plants added after secondary inward from primary",
    plantOutwardId,
    secondaryInwardId,
    performedBy: performedBy || undefined,
    metadata: { size: size || null },
  });

  await doc.save({ session });
  return doc;
}

/**
 * After secondary outward (dispatch): subtract from the FIFO line for that secondary inward
 * (same line as validateTransfer uses). totalAvailable and fifo stay aligned with PlantOutward.
 */
export async function recordSecondaryOutwardOnLedger(session, payload) {
  const {
    dispatchBatchId,
    plantOutwardId,
    secondaryInwardId,
    secondaryOutwardId,
    quantity,
    performedBy,
    metadata,
  } = payload;

  if (!dispatchBatchId || !secondaryInwardId || quantity == null) {
    throw new AppError("Ledger outward: missing required ids or quantity", 400);
  }
  const qty = Number(quantity);
  if (!Number.isFinite(qty) || qty < 1 || !Number.isInteger(qty)) {
    throw new AppError("Ledger outward: invalid plant quantity", 400);
  }

  let doc = await SecondaryDispatchAvailability.findOne({ dispatchBatchId })
    .session(session)
    .exec();

  if (!doc) {
    await bootstrapLedgerFromPlantOutward(session, dispatchBatchId, performedBy);
    doc = await SecondaryDispatchAvailability.findOne({ dispatchBatchId })
      .session(session)
      .exec();
  }

  if (!doc) {
    throw new AppError(
      "Secondary availability ledger missing for this batch",
      400
    );
  }

  const prevTotal = doc.totalAvailablePlants;
  const line = (doc.fifoLines || []).find(
    (l) => String(l.secondaryInwardId) === String(secondaryInwardId)
  );

  if (!line) {
    throw new AppError(
      "FIFO line not found for this secondary inward — ledger may need backfill",
      400
    );
  }

  if (line.remainingPlants < qty) {
    throw new AppError(
      `Ledger outward: insufficient remaining on FIFO line (${line.remainingPlants} < ${qty})`,
      400
    );
  }

  line.remainingPlants -= qty;
  doc.recalcTotal();

  const trailEntry = {
    action: "SUBTRACT_SECONDARY_OUTWARD",
    activityName: "Secondary outward (dispatch)",
    quantity: qty,
    previousTotalAvailable: prevTotal,
    newTotalAvailable: doc.totalAvailablePlants,
    reason: "Plants dispatched from secondary shed",
    plantOutwardId,
    secondaryInwardId,
    secondaryOutwardId,
    performedBy: performedBy || undefined,
  };
  if (metadata != null && typeof metadata === "object") {
    trailEntry.metadata = metadata;
  }
  doc.availabilityTrail.unshift(trailEntry);

  await doc.save({ session });
  return doc;
}

/**
 * Reverse a vehicle unload: add plants back to the FIFO line for the source secondary inward.
 */
export async function recordSecondaryUnloadOnLedger(session, payload) {
  const {
    dispatchBatchId,
    plantOutwardId,
    secondaryInwardId,
    secondaryOutwardId,
    quantity,
    performedBy,
    metadata,
  } = payload;

  if (!dispatchBatchId || !secondaryInwardId || quantity == null) {
    throw new AppError("Ledger unload: missing required ids or quantity", 400);
  }
  const qty = Number(quantity);
  if (!Number.isFinite(qty) || qty < 1 || !Number.isInteger(qty)) {
    throw new AppError("Ledger unload: invalid plant quantity", 400);
  }

  let doc = await SecondaryDispatchAvailability.findOne({ dispatchBatchId })
    .session(session)
    .exec();

  if (!doc) {
    await bootstrapLedgerFromPlantOutward(session, dispatchBatchId, performedBy);
    doc = await SecondaryDispatchAvailability.findOne({ dispatchBatchId })
      .session(session)
      .exec();
  }

  if (!doc) {
    throw new AppError("Secondary availability ledger missing for this batch", 400);
  }

  const prevTotal = doc.totalAvailablePlants;
  let line = (doc.fifoLines || []).find(
    (l) => String(l.secondaryInwardId) === String(secondaryInwardId)
  );

  if (!line) {
    line = {
      secondaryInwardId,
      plantOutwardId,
      secondaryInwardDate: new Date(),
      remainingPlants: 0,
      initialPlants: qty,
      size: undefined,
    };
    doc.fifoLines = sortFifoByDateAsc([...(doc.fifoLines || []), line]);
  }

  line.remainingPlants = Math.max(0, Number(line.remainingPlants) || 0) + qty;
  doc.recalcTotal();

  const trailEntry = {
    action: "ADD_SECONDARY_UNLOAD",
    activityName: "Secondary unload (return to shed)",
    quantity: qty,
    previousTotalAvailable: prevTotal,
    newTotalAvailable: doc.totalAvailablePlants,
    reason: "Plants returned to secondary shed from vehicle",
    plantOutwardId,
    secondaryInwardId,
    secondaryOutwardId,
    performedBy: performedBy || undefined,
  };
  if (metadata != null && typeof metadata === "object") {
    trailEntry.metadata = metadata;
  }
  doc.availabilityTrail.unshift(trailEntry);

  await doc.save({ session });
  return doc;
}

/**
 * Optional: true FIFO allocation across lines (oldest planting first) — not used by default API.
 * Exported for future bulk dispatch or admin tools.
 */
export async function allocateFifoFromOldest(session, dispatchBatchId, quantity) {
  const qty = Number(quantity);
  if (!Number.isFinite(qty) || qty < 1 || !Number.isInteger(qty)) {
    throw new AppError("allocateFifo: invalid quantity", 400);
  }

  const doc = await SecondaryDispatchAvailability.findOne({ dispatchBatchId })
    .session(session)
    .exec();
  if (!doc) throw new AppError("Ledger not found", 404);

  const sorted = sortFifoByDateAsc(doc.fifoLines || []);
  let remaining = qty;
  const allocations = [];

  for (const line of sorted) {
    if (remaining <= 0) break;
    const take = Math.min(line.remainingPlants, remaining);
    if (take <= 0) continue;
    allocations.push({ secondaryInwardId: line.secondaryInwardId, quantity: take });
    line.remainingPlants -= take;
    remaining -= take;
  }

  if (remaining > 0) {
    throw new AppError(
      `FIFO allocation: only ${qty - remaining} of ${qty} plants available`,
      400
    );
  }

  doc.fifoLines = sortFifoByDateAsc(doc.fifoLines);
  doc.recalcTotal();
  await doc.save({ session });
  return { doc, allocations };
}
