import AppError from "../utility/appError.js";

/** Tier 1: unique 4-digit (1000–9999). Tier 2: unique 5-digit (10000–99999) when tier 1 full. */
const TIERS = [
  { min: 1000, max: 9999 },
  { min: 10000, max: 99999 },
];

export const ORDER_ID_MIN = 1000;
export const ORDER_ID_MAX = 99999;

/**
 * Returns the next globally unique numeric orderId for nursery orders.
 * Fills gaps in 1000–9999 first; only uses 10000–99999 when tier 1 has no free IDs.
 *
 * @param {import('mongoose').Model} OrderModel
 * @param {{ session?: import('mongoose').ClientSession | null, reserved?: Set<number> }} options
 * @returns {Promise<number>}
 */
export async function allocateNextOrderId(
  OrderModel,
  { session = null, reserved = new Set() } = {}
) {
  for (const { min, max } of TIERS) {
    let query = OrderModel.find({ orderId: { $gte: min, $lte: max } }).select(
      "orderId"
    );
    if (session) query = query.session(session);
    const usedInTier = await query.lean();
    const used = new Set([
      ...usedInTier.map((o) => Number(o.orderId)),
      ...reserved,
    ]);
    for (let id = min; id <= max; id++) {
      if (!used.has(id)) return id;
    }
  }
  throw new AppError(
    "No unique order IDs left (4-digit and 5-digit pools exhausted)",
    503
  );
}

/**
 * Reserve an allocated id in a batch import set (call after allocateNextOrderId).
 */
export function reserveOrderId(reserved, orderId) {
  if (reserved) reserved.add(Number(orderId));
}
