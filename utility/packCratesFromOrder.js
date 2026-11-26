/**
 * Pack crates from original order qty with free plants on FULL crates only.
 * DC / invoices must keep using orderQty — never packQty.
 *
 * Pass 1: breakdown(orderQty) → full crates
 * Bonus: fullCrates * freePlantsPerCrate
 * Pass 2: breakdown(orderQty + bonus) → final crateDetails
 */

export function breakdownCrates(qty, traySize, traysPerCrate) {
  const quantity = Math.max(0, Number(qty) || 0);
  const cavity = Math.max(0, Number(traySize) || 0);
  const perCrate = Math.max(0, Number(traysPerCrate) || 0);
  if (quantity < 1 || cavity < 1 || perCrate < 1) {
    return {
      fullCrates: 0,
      plantsInFullCrates: 0,
      remainingPlants: 0,
      plantsPerCrate: 0,
      crateDetails: [],
    };
  }
  const plantsPerCrate = cavity * perCrate;
  const numberOfTrays = Math.floor(quantity / cavity);
  const fullCrates = Math.floor(numberOfTrays / perCrate);
  const plantsInFullCrates = fullCrates * plantsPerCrate;
  const remainingPlants = Math.max(0, quantity - plantsInFullCrates);
  const crateDetails = [];
  if (fullCrates > 0) {
    crateDetails.push({
      crateCount: fullCrates,
      plantCount: plantsInFullCrates,
    });
  }
  if (remainingPlants > 0) {
    crateDetails.push({
      crateCount: 1,
      plantCount: remainingPlants,
    });
  }
  return {
    fullCrates,
    plantsInFullCrates,
    remainingPlants,
    plantsPerCrate,
    crateDetails,
  };
}

/**
 * @returns {{
 *   orderQty: number,
 *   bonus: number,
 *   packQty: number,
 *   fullCratesPass1: number,
 *   crateDetails: Array<{crateCount:number, plantCount:number}>,
 *   crateCount: number,
 *   plantCount: number,
 * }}
 */
export function packFromOrder({
  orderQty,
  cavitySize,
  numberPerCrate,
  freePlantsPerCrate = 0,
}) {
  const qty = Math.max(0, Number(orderQty) || 0);
  const free = Math.max(0, Number(freePlantsPerCrate) || 0);
  const traySize = Number(cavitySize) || 0;
  const traysPerCrate = Number(numberPerCrate) || 0;

  const pass1 = breakdownCrates(qty, traySize, traysPerCrate);
  const bonus = pass1.fullCrates * free;
  const packQty = qty + bonus;
  const pass2 = breakdownCrates(packQty, traySize, traysPerCrate);
  const crateDetails = pass2.crateDetails;
  const crateCount = crateDetails.reduce(
    (s, r) => s + Number(r.crateCount || 0),
    0
  );
  const plantCount = crateDetails.reduce(
    (s, r) => s + Number(r.plantCount || 0),
    0
  );

  return {
    orderQty: qty,
    bonus,
    packQty,
    fullCratesPass1: pass1.fullCrates,
    crateDetails,
    crateCount,
    plantCount,
  };
}

const plantsPerFullCrate = (crateDetails) => {
  let per = 0;
  for (const row of Array.isArray(crateDetails) ? crateDetails : []) {
    const crateCount = Number(row?.crateCount) || 0;
    const plantCount = Number(row?.plantCount) || 0;
    if (crateCount > 1 && plantCount > 0 && plantCount % crateCount === 0) {
      per = Math.max(per, plantCount / crateCount);
    }
  }
  return per;
};

/**
 * plant.quantity is billed order qty. Crate plantCount is pack qty
 * (billed + free plants on full crates). Those totals match when they are
 * equal, when orderPlantCount sums to the billed qty, or when the pack
 * total is exactly packFromOrder(billed) for a small free-per-crate rate.
 */
export function crateTotalsMatchBilledQuantity(plantQty, crates) {
  const qty = Number(plantQty) || 0;
  const rows = Array.isArray(crates) ? crates : [];
  if (qty <= 0) return true;

  const hasOrderQty =
    rows.length > 0 &&
    rows.every((row) => row?.orderPlantCount != null && row.orderPlantCount !== "");
  if (hasOrderQty) {
    const billed = rows.reduce((sum, row) => sum + (Number(row.orderPlantCount) || 0), 0);
    return billed === qty;
  }

  const packed = rows.reduce(
    (sum, row) => sum + (Number(row?.plantCount ?? row?.quantity) || 0),
    0
  );
  if (packed === qty) return true;

  if (rows.length === 1) {
    const perCrate = plantsPerFullCrate(rows[0]?.crateDetails);
    if (perCrate > 0) {
      for (let free = 1; free <= 20; free += 1) {
        const pack = packFromOrder({
          orderQty: qty,
          cavitySize: perCrate,
          numberPerCrate: 1,
          freePlantsPerCrate: free,
        });
        if (pack.plantCount === packed) return true;
      }
    }
  }

  const hasBonus =
    rows.length > 0 &&
    rows.every((row) => row?.freePlantBonus != null && row.freePlantBonus !== "");
  if (hasBonus) {
    const billed = rows.reduce((sum, row) => {
      const plantCount = Number(row.plantCount ?? row.quantity) || 0;
      const bonus = Math.max(0, Number(row.freePlantBonus) || 0);
      return sum + Math.max(0, plantCount - bonus);
    }, 0);
    return billed === qty;
  }

  return false;
}

/** Pack / load target from stored orderDispatchDetails row (crates plantCount preferred). */
export function packQtyFromOrderDispatchRow(row) {
  const crates = Array.isArray(row?.crates) ? row.crates : [];
  let fromCrates = 0;
  for (const c of crates) {
    const details = Array.isArray(c?.crateDetails) ? c.crateDetails : [];
    if (details.length) {
      fromCrates += details.reduce(
        (s, d) => s + (Number(d.plantCount) || 0),
        0
      );
    } else {
      fromCrates += Number(c?.plantCount) || 0;
    }
  }
  if (fromCrates > 0) return fromCrates;
  return Math.max(0, Number(row?.dispatchQuantity) || 0);
}

export default packFromOrder;
