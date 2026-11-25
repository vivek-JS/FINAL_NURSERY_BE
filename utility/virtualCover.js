import moment from "moment";

const intQty = (value) => Math.max(0, Math.floor(Number(value) || 0));

export function coverYmd(value) {
  const parsed = moment(String(value || ""), ["DD-MM-YYYY", "YYYY-MM-DD"], true);
  return parsed.isValid() ? parsed.format("YYYY-MM-DD") : "";
}

function isFreshSowing(sowing) {
  return String(sowing?.sowingName || "").trim().toLowerCase() === "fresh";
}

function dayDistance(aYmd, bYmd) {
  if (!aYmd || !bYmd) return Number.POSITIVE_INFINITY;
  const a = Date.parse(`${aYmd}T00:00:00Z`);
  const b = Date.parse(`${bYmd}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.POSITIVE_INFINITY;
  return Math.abs(a - b) / 86400000;
}

function sortPool(rows) {
  return rows.sort(
    (a, b) =>
      a.sowingDate.localeCompare(b.sowingDate) ||
      a.plantReadyDate.localeCompare(b.plantReadyDate) ||
      a.requestNumber.localeCompare(b.requestNumber)
  );
}

function sortOrders(rows) {
  return rows.sort(
    (a, b) =>
      a.deliveryDate.localeCompare(b.deliveryDate) ||
      a.bookingDate.localeCompare(b.bookingDate) ||
      String(a.orderNumber).localeCompare(String(b.orderNumber), undefined, { numeric: true })
  );
}

function pushTake(takes, sowing, take) {
  const existing = takes.find(
    (item) =>
      item.requestNumber === sowing.requestNumber &&
      item.sowingDate === sowing.sowingDate &&
      item.plantReadyDate === sowing.plantReadyDate
  );
  if (existing) {
    existing.plants += take;
  } else {
    takes.push({
      batchId: sowing.batchId || "",
      requestNumber: sowing.requestNumber,
      sowingDate: sowing.sowingDate,
      plantReadyDate: sowing.plantReadyDate,
      shedName: sowing.shedName,
      ...(sowing.sowingName ? { sowingName: sowing.sowingName } : {}),
      plants: take,
    });
  }
}

/**
 * Shared 4-step deduction across a sorted order queue from a sowing pool:
 * Pass 1 (per order, oldest first):
 *   1. Fresh first (even if the order is covered from another sowing).
 *   2. Own linked sowing (if still has remaining > 0) — claimed before unlinked FIFO spills.
 * Pass 2 (per order still needing plants, oldest first):
 *   3. FIFO (oldest sowing ready on or before targetDate).
 *   4. Nearest sowing (closest plantReadyDate to targetDate).
 */
function deductQueueFromPool(pool, queue, onTake) {
  const applyTake = (sowing, state, amount) => {
    const take = Math.min(state.left, amount, sowing.remaining);
    if (take < 1) return;
    sowing.remaining -= take;
    state.left -= take;
    pushTake(state.takes, sowing, take);
    if (onTake) onTake(sowing, state.order, take);
  };

  // Pass 1: Fresh first, then own linked sowing(s)
  const states = queue.map((order) => {
    const state = { order, takes: [], left: order.plants };
    for (const sowing of pool) {
      if (state.left < 1) break;
      if (sowing.remaining < 1 || !isFreshSowing(sowing)) continue;
      applyTake(sowing, state, state.left);
    }
    if (state.left > 0 && order.linkedCovers.length) {
      for (const src of order.linkedCovers) {
        if (state.left < 1) break;
        const srcBatchId = String(src?.batchId || "");
        const srcReq = String(src?.requestNumber || "");
        if (!srcBatchId && !srcReq) continue;
        const match = pool.find(
          (sowing) =>
            sowing.remaining > 0 &&
            ((srcBatchId && sowing.batchId === srcBatchId) || (srcReq && sowing.requestNumber === srcReq))
        );
        if (!match) continue;
        applyTake(match, state, intQty(src?.plants) || state.left);
      }
    }
    return state;
  });

  // Pass 2: FIFO (ready <= deliveryDate), then nearest sowing
  for (const state of states) {
    const targetDate = state.order.deliveryDate;
    if (state.left > 0) {
      for (const sowing of pool) {
        if (state.left < 1) break;
        if (sowing.remaining < 1) continue;
        if (sowing.plantReadyDate && targetDate && sowing.plantReadyDate > targetDate) continue;
        applyTake(sowing, state, state.left);
      }
    }
    if (state.left > 0) {
      const nearest = pool
        .filter((sowing) => sowing.remaining > 0)
        .sort(
          (a, b) =>
            dayDistance(a.plantReadyDate, targetDate) - dayDistance(b.plantReadyDate, targetDate) ||
            a.sowingDate.localeCompare(b.sowingDate) ||
            a.plantReadyDate.localeCompare(b.plantReadyDate) ||
            a.requestNumber.localeCompare(b.requestNumber)
        );
      for (const sowing of nearest) {
        if (state.left < 1) break;
        applyTake(sowing, state, state.left);
      }
    }
  }

  return states;
}

function normalizeSowing(row) {
  const remaining = intQty(row.virtualRemaining ?? row.remaining);
  return {
    entryId: String(row.entryId || row._id || ""),
    batchId: String(row.batchId || row.sourceBatchId || ""),
    requestNumber: row.requestNumber || "",
    sowingDate: coverYmd(row.sowingDate || row.sowDay),
    plantReadyDate: coverYmd(row.plantReadyDate),
    shedName: row.shedName || "",
    sowingName: String(row.sowingName || "").trim(),
    startRemaining: remaining,
    remaining,
    virtualOut: intQty(row.virtualOut),
    virtualOutOrders: Array.isArray(row.virtualOutOrders) ? [...row.virtualOutOrders] : [],
    virtualCover: 0,
    virtualCoverOrders: [],
  };
}

function normalizeOrder(row) {
  return {
    orderId: String(row.orderId || ""),
    orderNumber: row.orderNumber ?? "",
    farmerName: row.farmerName || "",
    deliveryDate: coverYmd(row.deliveryDate),
    bookingDate: coverYmd(row.bookingDate),
    plants: intQty(row.plants ?? row.total ?? row.booked),
    linkedCovers: Array.isArray(row.covers) ? row.covers : [],
  };
}

/**
 * Step 1: Virtual Out for DISPATCHED orders (independent of physical dispatchedPlants).
 * Priority: Fresh -> own sowing -> FIFO -> nearest sowing.
 */
export function applyVirtualOut(dispatchedOrders, sowings) {
  const pool = sortPool((sowings || []).map(normalizeSowing));
  const queue = sortOrders((dispatchedOrders || []).map(normalizeOrder).filter((o) => o.plants > 0));

  const states = deductQueueFromPool(pool, queue, (sowing, order, take) => {
    sowing.virtualOut += take;
    sowing.virtualOutOrders.push({
      orderId: order.orderId,
      orderNumber: order.orderNumber,
      farmerName: order.farmerName,
      deliveryDate: order.deliveryDate,
      plants: take,
    });
  });

  const outOrders = states.map(({ order, takes, left }) => {
    const { linkedCovers: _ignored, ...cleanOrder } = order;
    return { ...cleanOrder, short: left, outs: takes };
  });

  return {
    sowings: pool.map((row) => ({
      ...row,
      remaining: row.remaining,
      virtualRemaining: row.remaining,
    })),
    orders: outOrders,
    totalOut: pool.reduce((sum, row) => sum + row.virtualOut, 0),
  };
}

/**
 * Step 2: Cover open orders from sowings (after Virtual Out).
 * Priority: Fresh -> own sowing -> FIFO -> nearest sowing.
 */
export function allocateVirtualCover(orders, sowings) {
  const pool = sortPool((sowings || []).map(normalizeSowing));
  const queue = sortOrders((orders || []).map(normalizeOrder).filter((o) => o.plants > 0));

  const states = deductQueueFromPool(pool, queue, (sowing, order, take) => {
    sowing.virtualCover += take;
    sowing.virtualCoverOrders.push({
      orderId: order.orderId,
      orderNumber: order.orderNumber,
      farmerName: order.farmerName,
      deliveryDate: order.deliveryDate,
      plants: take,
    });
  });

  const covered = states.map(({ order, takes, left }) => {
    const { linkedCovers: _ignored, ...cleanOrder } = order;
    return { ...cleanOrder, short: left, covers: takes };
  });

  const perSowing = pool.map((row) => ({
    entryId: row.entryId,
    batchId: row.batchId,
    requestNumber: row.requestNumber,
    sowingDate: row.sowingDate,
    plantReadyDate: row.plantReadyDate,
    shedName: row.shedName,
    ...(row.sowingName ? { sowingName: row.sowingName } : {}),
    virtualOut: row.virtualOut,
    virtualRemaining: row.startRemaining,
    virtualCover: row.virtualCover,
    virtualExcess: row.remaining,
    virtualOutOrders: row.virtualOutOrders,
    virtualCoverOrders: row.virtualCoverOrders,
  }));

  return {
    orders: covered,
    left: pool.reduce((sum, row) => sum + row.remaining, 0),
    perSowing,
    balance: pool
      .filter((row) => row.remaining > 0)
      .map((row) => ({
        requestNumber: row.requestNumber,
        sowingDate: row.sowingDate,
        plantReadyDate: row.plantReadyDate,
        shedName: row.shedName,
        ...(row.sowingName ? { sowingName: row.sowingName } : {}),
        virtualOut: row.virtualOut,
        virtualRemaining: row.startRemaining,
        plants: row.remaining,
      })),
  };
}
