import {
  safeMongooseNumber,
  safeNonNegativeInt,
  safeSubtractNonNegative,
} from "./safeMongooseNumber.js";

/** Lab line is usable for primary inward: accepted (or legacy missing status), not rejected */
export const isLabLineAcceptedForPrimary = (lab) => {
  const st = lab.primaryReviewStatus;
  if (st === "pending" || st === "rejected") return false;
  return true;
};

/** Same numeric rules as labToPrimaryInward for lab line totals and transfer sums */
export const computeLabLineStock = (lab) => {
  const labBottlesTotal = safeMongooseNumber(lab.bottles);
  const labPlantsTotal = safeMongooseNumber(lab.plants);
  const transferredBottlesSoFar = (lab.transferHistory || []).reduce(
    (sum, t) => sum + safeNonNegativeInt(t?.bottlesTransferred, 0),
    0
  );
  const transferredPlantsSoFar = (lab.transferHistory || []).reduce(
    (sum, t) => sum + safeNonNegativeInt(t?.plantsTransferred, 0),
    0
  );
  const bottlesTotal = safeNonNegativeInt(labBottlesTotal, 0);
  const plantsTotal = safeNonNegativeInt(labPlantsTotal, 0);
  let bottlesRemaining = safeSubtractNonNegative(bottlesTotal, transferredBottlesSoFar);
  let plantsRemaining = safeSubtractNonNegative(plantsTotal, transferredPlantsSoFar);
  if (lab.availableBottles != null) {
    bottlesRemaining = Math.max(0, safeNonNegativeInt(lab.availableBottles, 0));
  }
  if (lab.availablePlants != null) {
    plantsRemaining = Math.max(0, safeNonNegativeInt(lab.availablePlants, 0));
  }
  return {
    bottlesTotal,
    plantsTotal,
    bottlesTransferred: transferredBottlesSoFar,
    plantsTransferred: transferredPlantsSoFar,
    bottlesRemaining,
    plantsRemaining,
  };
};

/**
 * Accepted lab lines with remaining plants, oldest outwardDate first (same batch).
 */
export const collectAcceptedLabPool = (plantOutward) => {
  const pool = [];
  for (const lab of plantOutward.outward || []) {
    if (!isLabLineAcceptedForPrimary(lab)) continue;
    const stock = computeLabLineStock(lab);
    if (stock.plantsRemaining < 1) continue;
    pool.push({
      lab,
      labEntryId: lab._id,
      ...stock,
    });
  }

  return sortLabPoolFifo(pool);
};

const sortLabPoolFifo = (pool) => {
  pool.sort((a, b) => {
    const da = new Date(a.lab.outwardDate || 0).getTime();
    const db = new Date(b.lab.outwardDate || 0).getTime();
    if (da !== db) return da - db;
    const aa = new Date(a.lab.acceptedAt || 0).getTime();
    const ab = new Date(b.lab.acceptedAt || 0).getTime();
    return aa - ab;
  });
  return pool;
};

/**
 * All accepted lab lines across plant outward docs, oldest outwardDate first globally.
 */
export const collectGlobalAcceptedLabPool = (plantOutwards) => {
  const pool = [];
  for (const plantOutward of plantOutwards || []) {
    const rawRef = plantOutward.batchId;
    const batchId = String(rawRef?._id ?? rawRef ?? "");
    const plantOutwardId = String(plantOutward._id ?? "");
    if (!batchId || !plantOutwardId) continue;

    for (const lab of plantOutward.outward || []) {
      if (!isLabLineAcceptedForPrimary(lab)) continue;
      const stock = computeLabLineStock(lab);
      if (stock.bottlesRemaining < 1 && stock.plantsRemaining < 1) continue;
      pool.push({
        lab,
        labEntryId: lab._id,
        plantOutwardId,
        batchId,
        ...stock,
      });
    }
  }
  return sortLabPoolFifo(pool);
};

const plantsForBottlesTaken = (bottlesTaken, entry) => {
  const { plantsTotal, bottlesTotal, plantsRemaining } = entry;
  const take = safeNonNegativeInt(bottlesTaken, 0);
  if (take <= 0) return 0;
  if (take >= entry.bottlesRemaining && plantsRemaining > 0) {
    return plantsRemaining;
  }
  if (bottlesTotal <= 0) return Math.min(1, plantsRemaining);
  const ratio = plantsTotal / bottlesTotal;
  const raw = Math.ceil(take * ratio);
  return Math.min(Math.max(1, raw), plantsRemaining);
};

/**
 * Bottle-first FIFO across global pool; plants derived proportionally per line.
 */
export const allocateFifoByBottles = (pool, totalBottlesNeeded) => {
  const needTotal = safeNonNegativeInt(totalBottlesNeeded, 0);
  if (needTotal < 1) {
    return { ok: false, error: "totalBottlesSown must be at least 1", allocations: [] };
  }

  let need = needTotal;
  const allocations = [];

  for (const entry of pool) {
    if (need <= 0) break;
    if (entry.bottlesRemaining < 1) continue;

    const bottlesTaken = Math.min(entry.bottlesRemaining, need);
    if (bottlesTaken <= 0) continue;

    const plantsTaken = plantsForBottlesTaken(bottlesTaken, entry);
    allocations.push({
      labEntryId: String(entry.labEntryId),
      plantOutwardId: String(entry.plantOutwardId),
      batchId: String(entry.batchId),
      labSize: entry.lab.size ?? null,
      outwardDate: entry.lab.outwardDate ?? null,
      bottlesTaken,
      plantsTaken,
      plantsRemainingBefore: entry.plantsRemaining,
      bottlesRemainingBefore: entry.bottlesRemaining,
    });
    need -= bottlesTaken;
  }

  if (need > 0) {
    const available = pool.reduce((s, e) => s + e.bottlesRemaining, 0);
    return {
      ok: false,
      error: `Insufficient bottles across all batches. Requested ${needTotal}, available ${available}`,
      allocations,
    };
  }

  return { ok: true, allocations };
};

export const getAvailableLabStock = (pool) => ({
  bottles: pool.reduce((s, e) => s + e.bottlesRemaining, 0),
  plants: pool.reduce((s, e) => s + e.plantsRemaining, 0),
});

/**
 * Direct lagwad entry — record user-entered bottles/plants on anchor batch
 * without enforcing global lab stock availability.
 */
export const buildDirectEntryFifoAllocations = (
  plantOutwards,
  anchorBatchId,
  totalBottles,
  totalPlants,
) => {
  const bid = String(anchorBatchId ?? "");
  const bottles = safeNonNegativeInt(totalBottles, 0);
  const plants = safeNonNegativeInt(totalPlants, 0);
  if (!bid) {
    return { ok: false, error: "anchorBatchId is required for direct entry" };
  }
  if (bottles < 1 || plants < 1) {
    return {
      ok: false,
      error: "totalBottlesSown and totalPlantsSown must be at least 1",
    };
  }

  const po = (plantOutwards || []).find(
    (p) => String(p.batchId?._id ?? p.batchId) === bid
  );
  if (!po) {
    return { ok: false, error: `No plant outward found for batch ${bid}` };
  }

  let lab = null;
  for (const l of po.outward || []) {
    if (!isLabLineAcceptedForPrimary(l)) continue;
    lab = l;
    break;
  }

  const stock = lab ? computeLabLineStock(lab) : null;

  return {
    ok: true,
    allocations: [
      {
        labEntryId: lab ? String(lab._id) : "",
        plantOutwardId: String(po._id),
        batchId: bid,
        labSize: lab?.size ?? null,
        outwardDate: lab?.outwardDate ?? null,
        bottlesTaken: bottles,
        plantsTaken: plants,
        plantsRemainingBefore: stock?.plantsRemaining ?? plants,
        bottlesRemainingBefore: stock?.bottlesRemaining ?? bottles,
      },
    ],
  };
};

export const validateBottlesForInward = (pool, bottlesNeeded) => {
  const { bottles: available } = getAvailableLabStock(pool);
  const need = safeNonNegativeInt(bottlesNeeded, 0);
  if (need < 1) {
    return { ok: false, available, error: "At least 1 bottle is required" };
  }
  if (need > available) {
    return {
      ok: false,
      available,
      error: `Insufficient bottles in batch. Available ${available}, requested ${need}`,
    };
  }
  return { ok: true, available };
};

const bottlesForPlantsTaken = (plantsTaken, entry) => {
  const { plantsTotal, bottlesTotal, bottlesRemaining } = entry;
  if (plantsTaken >= entry.plantsRemaining && bottlesRemaining > 0) {
    return bottlesRemaining;
  }
  if (plantsTotal <= 0) return Math.min(1, bottlesRemaining);
  const ratio = bottlesTotal / plantsTotal;
  const raw = Math.ceil(plantsTaken * ratio);
  return Math.min(Math.max(1, raw), bottlesRemaining);
};

/**
 * FIFO allocate plants (and proportional bottles) across accepted lab pool.
 */
export const allocateFifo = (pool, totalPlantsNeeded) => {
  const needTotal = safeNonNegativeInt(totalPlantsNeeded, 0);
  if (needTotal < 1) {
    return { ok: false, error: "totalPlantsSown must be at least 1" };
  }

  let need = needTotal;
  const allocations = [];

  for (const entry of pool) {
    if (need <= 0) break;
    const take = Math.min(entry.plantsRemaining, need);
    if (take <= 0) continue;

    const bottlesTaken = bottlesForPlantsTaken(take, entry);
    allocations.push({
      labEntryId: String(entry.labEntryId),
      labSize: entry.lab.size ?? null,
      outwardDate: entry.lab.outwardDate ?? null,
      plantsTaken: take,
      bottlesTaken,
      plantsRemainingBefore: entry.plantsRemaining,
      bottlesRemainingBefore: entry.bottlesRemaining,
    });
    need -= take;
  }

  if (need > 0) {
    const available = pool.reduce((s, e) => s + e.plantsRemaining, 0);
    return {
      ok: false,
      error: `Insufficient lab stock in this batch. Requested ${needTotal}, available ${available}`,
      allocations,
    };
  }

  return { ok: true, allocations };
};

/** Compare client-supplied FIFO rows with server allocation (order-insensitive). */
export const fifoAllocationsMatch = (clientRows, serverRows) => {
  const norm = (rows) => {
    const m = new Map();
    for (const r of rows || []) {
      const id = String(r.labEntryId);
      const prev = m.get(id) ?? { plantsTaken: 0, bottlesTaken: 0 };
      m.set(id, {
        plantsTaken: prev.plantsTaken + safeNonNegativeInt(r.plantsTaken, 0),
        bottlesTaken: prev.bottlesTaken + safeNonNegativeInt(r.bottlesTaken, 0),
      });
    }
    return m;
  };
  const a = norm(clientRows);
  const b = norm(serverRows);
  if (a.size !== b.size) return false;
  for (const [id, va] of a) {
    const vb = b.get(id);
    if (!vb) return false;
    if (va.plantsTaken !== vb.plantsTaken || va.bottlesTaken !== vb.bottlesTaken) {
      return false;
    }
  }
  return true;
};

/** FIFO-derived plants vs entered sown plants may differ by up to ±20%. */
export const FIFO_PLANTS_SOWN_TOLERANCE = 0.2;

/**
 * Lab FIFO plant totals (from bottle ratios on each line) vs user-entered sowing plants.
 * Independent splits — allow ±tolerance margin before rejecting.
 */
export const validateFifoPlantsVsSown = (
  sownPlants,
  fifoPlants,
  tolerance = FIFO_PLANTS_SOWN_TOLERANCE
) => {
  const sown = safeNonNegativeInt(sownPlants, 0);
  const fifo = safeNonNegativeInt(fifoPlants, 0);
  if (sown < 1 || fifo < 1) return { ok: true };
  const lo = Math.min(sown, fifo);
  const hi = Math.max(sown, fifo);
  const ratio = hi / lo;
  if (ratio <= 1 + tolerance) return { ok: true };
  const pct = Math.round(tolerance * 100);
  return {
    ok: false,
    error:
      fifo > sown
        ? `FIFO derives ${fifo} plants from bottles but you entered ${sown} plants sown (allowed ±${pct}% margin). Increase plants or reduce bottles.`
        : `You entered ${sown} plants sown but FIFO derives ${fifo} plants from bottles (allowed ±${pct}% margin).`,
  };
};

/** Suggest trays per size from split and cavity. */
export const suggestSizeRows = (sizeSplit, cavity) => {
  const cav = Math.max(1, safeNonNegativeInt(cavity, 126));
  const sizes = ["R1", "R2", "R3"];
  return sizes.flatMap((size) => {
    const plants = safeNonNegativeInt(sizeSplit?.[size], 0);
    if (plants < 1) return [];
    return [
      {
        size,
        plants,
        numberOfTrays: Math.max(1, Math.ceil(plants / cav)),
        numberOfBottles: 1,
      },
    ];
  });
};

/** Distribute total bottles from FIFO across size rows by plant proportion. */
export const distributeBottlesToSizeRows = (sizeRows, totalBottles) => {
  const totalPlants = sizeRows.reduce((s, r) => s + safeNonNegativeInt(r.plants, 0), 0);
  if (totalPlants < 1) return sizeRows;

  let assigned = 0;
  const out = sizeRows.map((row, idx) => {
    const plants = safeNonNegativeInt(row.plants, 0);
    let bottles =
      idx === sizeRows.length - 1
        ? Math.max(1, totalBottles - assigned)
        : Math.max(1, Math.round((plants / totalPlants) * totalBottles));
    assigned += bottles;
    return { ...row, numberOfBottles: bottles };
  });
  return out;
};
