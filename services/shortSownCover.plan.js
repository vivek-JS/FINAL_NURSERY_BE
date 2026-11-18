/** Share of plants sowed that a short sown order may take from mortality. */
export const SHORT_SOWN_MORTALITY_RATE = 0.02;

const qty = (value) => Math.max(0, Math.floor(Number(value) || 0));

/** DD-MM-YYYY or YYYY-MM-DD → YYYY-MM-DD so ready dates sort in calendar order. */
export function readyDateKey(value) {
  const text = String(value || "");
  const dmy = text.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return iso ? `${iso[1]}-${iso[2]}-${iso[3]}` : "";
}

export function mortalityCoverCap(plantsSowed) {
  return Math.floor(qty(plantsSowed) * SHORT_SOWN_MORTALITY_RATE);
}

function takeFrom(sowing, left, { useExcess, useMortality }) {
  const fromStamp = Math.min(left, qty(sowing?.unassigned));
  left -= fromStamp;
  const fromExcess = useExcess ? Math.min(left, qty(sowing?.excess)) : 0;
  left -= fromExcess;
  const mortCap = useMortality
    ? Math.min(mortalityCoverCap(sowing?.plantsSowed), qty(sowing?.buffer))
    : 0;
  const fromMortality = Math.min(left, mortCap);
  left -= fromMortality;
  const plants = fromStamp + fromExcess + fromMortality;
  return {
    left,
    take: plants
      ? {
          id: sowing.id,
          fromStamp,
          fromExcess,
          fromMortality,
          plants,
        }
      : null,
  };
}

/**
 * Cover a sown order that is still short.
 * Own sowing first: plants already covered but not on an order, then excess,
 * then up to 2% of plants sowed from mortality.
 * Then later sowings, same three pools.
 * Then earlier sowings, but only plants already covered and not on an order.
 * Returns null when the order would still be short — nothing is written then.
 */
export function planShortSownCover({ gap, own, sowings = [] }) {
  let left = qty(gap);
  if (left < 1 || !own?.id) return null;
  const takes = [];
  const consume = (sowing, flags) => {
    if (!sowing?.id || left < 1) return;
    const result = takeFrom(sowing, left, flags);
    left = result.left;
    if (result.take) takes.push(result.take);
  };

  consume(own, { useExcess: true, useMortality: true });
  const ownKey = readyDateKey(own.ready);
  const others = sowings.filter((sowing) => sowing?.id && sowing.id !== own.id);
  const later = others
    .filter((sowing) => ownKey && readyDateKey(sowing.ready) > ownKey)
    .sort((a, b) => readyDateKey(a.ready).localeCompare(readyDateKey(b.ready)));
  const earlier = others
    .filter((sowing) => ownKey && readyDateKey(sowing.ready) < ownKey)
    .sort((a, b) => readyDateKey(b.ready).localeCompare(readyDateKey(a.ready)));
  for (const sowing of later) consume(sowing, { useExcess: true, useMortality: true });
  for (const sowing of earlier) consume(sowing, { useExcess: false, useMortality: false });
  if (left > 0) return null;
  return takes;
}
