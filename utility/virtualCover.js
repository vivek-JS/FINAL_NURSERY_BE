import moment from "moment";

const intQty = (value) => Math.max(0, Math.floor(Number(value) || 0));

export function coverYmd(value) {
  const parsed = moment(String(value || ""), ["DD-MM-YYYY", "YYYY-MM-DD"], true);
  return parsed.isValid() ? parsed.format("YYYY-MM-DD") : "";
}

/**
 * Cover open orders from sowings that still have plants.
 * Oldest delivery first. Each order takes the oldest sowing that is already
 * ready on or before that delivery. Plants still needed after that come from
 * the next oldest sowing, because the order still has to be given.
 */
export function allocateVirtualCover(orders, sowings) {
  const pool = (sowings || [])
    .map((row) => ({
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
    }))
    .filter((row) => row.plants > 0)
    .sort(
      (a, b) =>
        a.deliveryDate.localeCompare(b.deliveryDate) ||
        a.bookingDate.localeCompare(b.bookingDate) ||
        String(a.orderNumber).localeCompare(String(b.orderNumber), undefined, { numeric: true })
    );

  const takeFrom = (need, allow) => {
    const takes = [];
    let left = need;
    for (const sowing of pool) {
      if (left < 1) break;
      if (sowing.remaining < 1) continue;
      if (!allow(sowing)) continue;
      const take = Math.min(left, sowing.remaining);
      sowing.remaining -= take;
      left -= take;
      const last = takes[takes.length - 1];
      if (
        last &&
        last.requestNumber === sowing.requestNumber &&
        last.sowingDate === sowing.sowingDate &&
        last.plantReadyDate === sowing.plantReadyDate
      ) {
        last.plants += take;
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
    }
    return { takes, left };
  };

  const covered = queue.map((order) => {
    const readyInTime = takeFrom(
      order.plants,
      (sowing) => !sowing.plantReadyDate || !order.deliveryDate || sowing.plantReadyDate <= order.deliveryDate
    );
    const spill = readyInTime.left > 0 ? takeFrom(readyInTime.left, () => true) : { takes: [], left: readyInTime.left };
    return {
      ...order,
      short: spill.left,
      covers: [...readyInTime.takes, ...spill.takes],
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
