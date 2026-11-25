import moment from "moment";

const intQty = (value) => Math.max(0, Math.floor(Number(value) || 0));

export function coverYmd(value) {
  const parsed = moment(String(value || ""), ["DD-MM-YYYY", "YYYY-MM-DD"], true);
  return parsed.isValid() ? parsed.format("YYYY-MM-DD") : "";
}

/**
 * Cover open orders from sowings that still have plants.
 * Pass 1: if an order already has a linked sowing with remaining plants, take from that sowing first.
 * Pass 2: if that sowing is old/empty or the order has none, take on a FIFO basis — oldest sowing
 * ready on or before delivery first, then next oldest sowing.
 */
export function allocateVirtualCover(orders, sowings) {
  const pool = (sowings || [])
    .map((row) => ({
      batchId: String(row.batchId || row.sourceBatchId || ""),
      requestNumber: row.requestNumber || "",
      sowingDate: coverYmd(row.sowingDate || row.sowDay),
      plantReadyDate: coverYmd(row.plantReadyDate),
      shedName: row.shedName || "",
      sowingName: String(row.sowingName || "").trim(),
      remaining: intQty(row.remaining),
    }))
    .filter((row) => row.remaining > 0)
    .sort(
      (a, b) =>
        a.sowingDate.localeCompare(b.sowingDate) ||
        a.plantReadyDate.localeCompare(b.plantReadyDate) ||
        a.requestNumber.localeCompare(b.requestNumber)
    );

  const queue = (orders || [])
    .map((row) => ({
      orderId: String(row.orderId || ""),
      orderNumber: row.orderNumber ?? "",
      farmerName: row.farmerName || "",
      deliveryDate: coverYmd(row.deliveryDate),
      bookingDate: coverYmd(row.bookingDate),
      plants: intQty(row.plants ?? row.total ?? row.booked),
      linkedCovers: Array.isArray(row.covers) ? row.covers : [],
    }))
    .filter((row) => row.plants > 0)
    .sort(
      (a, b) =>
        a.deliveryDate.localeCompare(b.deliveryDate) ||
        a.bookingDate.localeCompare(b.bookingDate) ||
        String(a.orderNumber).localeCompare(String(b.orderNumber), undefined, { numeric: true })
    );

  const pushTake = (takes, sowing, take) => {
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
        requestNumber: sowing.requestNumber,
        sowingDate: sowing.sowingDate,
        plantReadyDate: sowing.plantReadyDate,
        shedName: sowing.shedName,
        ...(sowing.sowingName ? { sowingName: sowing.sowingName } : {}),
        plants: take,
      });
    }
  };

  const takeFrom = (need, allow, takes) => {
    let left = need;
    for (const sowing of pool) {
      if (left < 1) break;
      if (sowing.remaining < 1) continue;
      if (!allow(sowing)) continue;
      const take = Math.min(left, sowing.remaining);
      sowing.remaining -= take;
      left -= take;
      pushTake(takes, sowing, take);
    }
    return left;
  };

  // Pass 1: take from each order's own linked sowing(s) if still remaining in pool.
  const state = queue.map((order) => {
    const takes = [];
    let left = order.plants;
    for (const src of order.linkedCovers) {
      if (left < 1) break;
      const srcBatchId = String(src?.batchId || "");
      const srcReq = String(src?.requestNumber || "");
      if (!srcBatchId && !srcReq) continue;
      const match = pool.find(
        (sowing) =>
          sowing.remaining > 0 &&
          ((srcBatchId && sowing.batchId === srcBatchId) || (srcReq && sowing.requestNumber === srcReq))
      );
      if (!match) continue;
      const cap = intQty(src?.plants) || left;
      const take = Math.min(left, cap, match.remaining);
      if (take < 1) continue;
      match.remaining -= take;
      left -= take;
      pushTake(takes, match, take);
    }
    return { order, takes, left };
  });

  // Pass 2: cover remaining need on a FIFO basis (ready in time first, then next oldest).
  const covered = state.map(({ order, takes, left }) => {
    let rem = left;
    if (rem > 0) {
      rem = takeFrom(
        rem,
        (sowing) => !sowing.plantReadyDate || !order.deliveryDate || sowing.plantReadyDate <= order.deliveryDate,
        takes
      );
    }
    if (rem > 0) {
      rem = takeFrom(rem, () => true, takes);
    }
    const { linkedCovers: _ignored, ...cleanOrder } = order;
    return {
      ...cleanOrder,
      short: rem,
      covers: takes,
    };
  });

  return {
    orders: covered,
    left: pool.reduce((sum, row) => sum + row.remaining, 0),
    balance: pool
      .filter((row) => row.remaining > 0)
      .map((row) => ({
        requestNumber: row.requestNumber,
        sowingDate: row.sowingDate,
        plantReadyDate: row.plantReadyDate,
        shedName: row.shedName,
        ...(row.sowingName ? { sowingName: row.sowingName } : {}),
        plants: row.remaining,
      })),
  };
}
