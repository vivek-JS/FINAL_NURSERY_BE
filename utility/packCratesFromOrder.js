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
