const ACTIONS = new Set(["book", "wait", "sow_first"]);

const CROP_ALIASES = [
  { key: "watermelon", words: ["watermelon", "water melon"] },
  { key: "muskmelon", words: ["muskmelon", "musk melon", "kharbuja"] },
  { key: "papaya", words: ["papaya"] },
  { key: "chili", words: ["chili", "chilli", "chilly"] },
];

export function cropsOnSheet(plants) {
  const names = (plants || []).map((plant) => String(plant.plantName || "").toLowerCase());
  return CROP_ALIASES.filter((crop) =>
    names.some((name) => crop.words.some((word) => name.includes(word)))
  ).map((crop) => crop.key);
}

export function commodityMatchesCrops(commodity, crops) {
  const text = String(commodity || "").toLowerCase();
  return (crops || []).some((key) => {
    const crop = CROP_ALIASES.find((row) => row.key === key);
    return crop?.words.some((word) => text.includes(word));
  });
}

export function slimCapacityForAnalyst(payload) {
  const plants = (payload?.plants || []).map((plant) => ({
    plant: plant.plantName,
    canBook: Number(plant.canBook) || 0,
    gap: Number(plant.gap) || 0,
    booked: Number(plant.booked) || 0,
    sowed: Number(plant.sowed) || 0,
    excess: Number(plant.excess) || 0,
    status: plant.status,
    subtypes: (plant.subtypes || [])
      .filter(
        (row) =>
          Number(row.canBook) !== 0 ||
          Number(row.gap) > 0 ||
          Number(row.booked) > 0 ||
          Number(row.sowed) > 0 ||
          Number(row.excess) > 0
      )
      .map((row) => ({
        name: row.subtypeName,
        canBook: Number(row.canBook) || 0,
        gap: Number(row.gap) || 0,
        booked: Number(row.booked) || 0,
        sowed: Number(row.sowed) || 0,
        excess: Number(row.excess) || 0,
        status: row.status,
      })),
  }));
  return {
    from: payload?.from,
    to: payload?.to,
    totals: payload?.totals || {},
    seedSources: payload?.seedSources || {},
    plants,
  };
}

export function parseAnalystJson(text) {
  const raw = String(text || "").trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  const action = ACTIONS.has(parsed.action) ? parsed.action : null;
  if (!action) return null;
  const confidence = Math.max(0, Math.min(100, Math.round(Number(parsed.confidence) || 0)));
  return {
    action,
    confidence,
    summary: String(parsed.summary || "").slice(0, 900),
    downside: String(parsed.downside || "").slice(0, 900),
    weatherNote: String(parsed.weatherNote || "").slice(0, 600),
    mandiNote: String(parsed.mandiNote || "").slice(0, 600),
  };
}

/** Used when the free model does not return usable JSON. Same inputs, no invented prices. */
export function rulesAnalyst({ capacity, weather, mandi, district }) {
  const totals = capacity?.totals || {};
  const canBook = Number(totals.canBook) || 0;
  const gap = Number(totals.gap) || 0;
  const rain = Number(weather?.rainTotalMm) || 0;
  const hasMandi = Boolean(mandi?.available && mandi?.prices?.length);
  let action = "wait";
  if (canBook < 0 || (gap > 0 && canBook <= 0)) action = "sow_first";
  else if (canBook > 0 && rain < 40) action = "book";
  else if (canBook > 0) action = "wait";

  let confidence = 55;
  if (weather?.available) confidence += 10;
  if (hasMandi) confidence += 10;
  if (canBook < 0) confidence += 10;
  if (!weather?.available) confidence -= 15;
  if (!hasMandi) confidence -= 10;
  confidence = Math.max(20, Math.min(85, confidence));

  const summary =
    action === "sow_first"
      ? `Gap is ahead of sowed excess in ${district}. Can book is ${canBook.toLocaleString("en-IN")}. Sow before taking more bookings.`
      : action === "book"
        ? `Can book is ${canBook.toLocaleString("en-IN")} plants and the 14-day rain total is ${rain} mm. Booking can go ahead on the varieties that are already green.`
        : `Can book is ${canBook.toLocaleString("en-IN")} but rain or missing prices make a full booking push risky. Book only the clear surplus.`;

  const downside =
    gap > 0
      ? `Uncovered gap is ${gap.toLocaleString("en-IN")} plants. Booking into that gap without sowing leaves delivery short.`
      : canBook > 0
        ? "Surplus can still fail if weather delays readiness or mandi prices fall after the booking."
        : "No spare sowed plants and no gap. There is nothing extra to sell in this window.";

  return {
    action,
    confidence,
    summary,
    downside,
    weatherNote: weather?.available
      ? `${district}: ${weather.tempMin}–${weather.tempMax}°C, ${rain} mm rain over 14 days.`
      : "Weather for this district was not available.",
    mandiNote: hasMandi
      ? mandi.prices
          .slice(0, 4)
          .map((row) => `${row.commodity} ${row.market}: modal ${row.modalPrice}`)
          .join("; ")
      : "Mandi prices were not available, so the price call is missing.",
  };
}
