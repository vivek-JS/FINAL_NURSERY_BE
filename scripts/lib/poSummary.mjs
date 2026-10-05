/**
 * Re-computes ONLY the secondary inward/outward totals of PlantOutward.summary
 * (same arithmetic as the model's pre-save hook: cavity x trays per line, grouped by size),
 * WITHOUT calling save() - save() would recompute availableQuantity of every line from history.
 */
export async function refreshSecondarySummary(PlantOutward, poId, session) {
  const po = await PlantOutward.collection.findOne({ _id: poId }, { session });
  if (!po || !po.summary) return null;
  const mk = () => ({ R1: { b: 0, p: 0 }, R2: { b: 0, p: 0 }, R3: { b: 0, p: 0 }, total: { b: 0, p: 0 } });
  const inw = mk();
  const out = mk();
  const add = (acc, x) => {
    const p = (Number(x.cavity) || 0) * (Number(x.numberOfTrays) || 0);
    const b = Number(x.numberOfBottles) || 0;
    if (acc[x.size]) {
      acc[x.size].b += b;
      acc[x.size].p += p;
    }
    acc.total.b += b;
    acc.total.p += p;
  };
  (po.secondaryInward || []).forEach((x) => add(inw, x));
  (po.secondaryOutward || []).forEach((x) => add(out, x));
  const $set = {};
  for (const size of ["R1", "R2", "R3", "total"]) {
    $set[`summary.${size}.secondaryInwardBottles`] = inw[size].b;
    $set[`summary.${size}.secondaryInwardPlants`] = inw[size].p;
    $set[`summary.${size}.secondaryOutwardBottles`] = out[size].b;
    $set[`summary.${size}.secondaryOutwardPlants`] = out[size].p;
  }
  await PlantOutward.collection.updateOne({ _id: poId }, { $set }, { session });
  return $set;
}
