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

function n(value) {
  return (Number(value) || 0).toLocaleString("en-IN");
}

export function actionForRow(row, rain = 0) {
  const canBook = Number(row?.canBook) || 0;
  const gap = Number(row?.gap) || 0;
  if (canBook < 0 || (gap > 0 && canBook <= 0)) return "sow_first";
  if (canBook > 0 && rain < 40) return "book";
  if (canBook > 0) return "wait";
  return "wait";
}

function rowNote(row, action, rain) {
  const canBook = Number(row?.canBook) || 0;
  const gap = Number(row?.gap) || 0;
  const booked = Number(row?.booked) || 0;
  const sowed = Number(row?.sowed) || 0;
  if (action === "sow_first") {
    return `Can book ${n(canBook)}. Gap ${n(gap)} is ahead of sowed excess. Booked ${n(booked)}, sowed ${n(sowed)}. Sow this before more bookings.`;
  }
  if (action === "book") {
    return `Can book ${n(canBook)}. Booked ${n(booked)}, sowed ${n(sowed)}, gap ${n(gap)}.`;
  }
  if (canBook > 0) {
    return `Can book ${n(canBook)}, but 14-day rain is ${rain} mm, so hold a full push. Gap ${n(gap)}.`;
  }
  return `Nothing spare. Booked ${n(booked)}, sowed ${n(sowed)}, gap ${n(gap)}.`;
}

export function plantBreakdown(capacity, rain = 0) {
  return (capacity?.plants || []).map((plant) => {
    const action = actionForRow(plant, rain);
    return {
      plant: plant.plant,
      action,
      canBook: Number(plant.canBook) || 0,
      gap: Number(plant.gap) || 0,
      booked: Number(plant.booked) || 0,
      sowed: Number(plant.sowed) || 0,
      note: rowNote(plant, action, rain),
      subtypes: (plant.subtypes || []).map((row) => {
        const subAction = actionForRow(row, rain);
        return {
          name: row.name,
          action: subAction,
          canBook: Number(row.canBook) || 0,
          gap: Number(row.gap) || 0,
          booked: Number(row.booked) || 0,
          sowed: Number(row.sowed) || 0,
          note: rowNote(row, subAction, rain),
        };
      }),
    };
  });
}

function countActions(plants) {
  return {
    sow_first: plants.filter((row) => row.action === "sow_first").length,
    book: plants.filter((row) => row.action === "book").length,
    wait: plants.filter((row) => row.action === "wait").length,
  };
}

function plantSummary(plants, scope) {
  const names = (action) =>
    plants
      .filter((row) => row.action === action)
      .map((row) => row.plant)
      .filter(Boolean);
  const sow = names("sow_first");
  const book = names("book");
  const hold = names("wait");
  const lines = [];
  if (sow.length) lines.push(`Sow first: ${sow.join(", ")}.`);
  if (book.length) lines.push(`Can book: ${book.join(", ")}.`);
  if (hold.length) lines.push(`Hold: ${hold.join(", ")}.`);
  if (!lines.length) lines.push("No plants with bookings or sowing in this date range.");
  lines.push(`This is our full ${scope} sheet, plant by plant. One call for the whole nursery hides the split.`);
  return lines.join(" ");
}

export function groundAdvice(advice, { capacity, weather, district }) {
  const rain = Number(weather?.rainTotalMm) || 0;
  const plants = plantBreakdown(capacity, rain);
  const scope = district || "Maharashtra";
  const totals = capacity?.totals || {};
  const gap = Number(totals.gap) || 0;
  const canBook = Number(totals.canBook) || 0;
  const downside =
    gap > 0
      ? `Uncovered gap on our sheet is ${n(gap)} plants. Booking a subtype whose can book is negative leaves that delivery short.`
      : canBook > 0
        ? "A subtype with spare plants can still slip if rain delays readiness."
        : "No spare sowed plants and no gap on our sheet for this window.";
  return {
    ...advice,
    summary: plantSummary(plants, scope),
    downside,
    plants,
    counts: countActions(plants),
  };
}

/** Used when the free model does not return usable JSON. Same inputs, no invented prices. */
export function rulesAnalyst({ capacity, weather, mandi, district }) {
  const totals = capacity?.totals || {};
  const canBook = Number(totals.canBook) || 0;
  const gap = Number(totals.gap) || 0;
  const rain = Number(weather?.rainTotalMm) || 0;
  const scope = district || "Maharashtra";
  const hasMandi = Boolean(mandi?.available && mandi?.prices?.length);
  const plants = plantBreakdown(capacity, rain);
  const counts = countActions(plants);
  let action = "wait";
  if (canBook < 0 || counts.sow_first > counts.book) action = "sow_first";
  else if (canBook > 0 && rain < 40 && counts.book > 0) action = "book";
  else if (canBook > 0) action = "wait";

  let confidence = 55;
  if (weather?.available) confidence += 10;
  if (hasMandi) confidence += 10;
  if (canBook < 0) confidence += 10;
  if (!weather?.available) confidence -= 15;
  if (!hasMandi) confidence -= 10;
  confidence = Math.max(20, Math.min(85, confidence));

  const downside =
    gap > 0
      ? `Uncovered gap on our sheet is ${n(gap)} plants. Booking a subtype whose can book is negative leaves that delivery short.`
      : canBook > 0
        ? "A subtype with spare plants can still slip if rain delays readiness."
        : "No spare sowed plants and no gap on our sheet for this window.";

  return {
    action,
    confidence,
    summary: plantSummary(plants, scope),
    downside,
    weatherNote: weather?.available
      ? `${weather.place || scope}: ${weather.tempMin}–${weather.tempMax}°C, ${rain} mm rain over 14 days. Weather is context only. The plant calls use our sheet.`
      : `Weather for ${scope} was not available. Plant calls still use our sheet.`,
    mandiNote: hasMandi
      ? mandi.prices
          .slice(0, 4)
          .map((row) => `${row.commodity} ${row.market}: modal ${row.modalPrice}`)
          .join("; ")
      : "Mandi prices were not available, so the price call is missing.",
    plants,
    counts,
  };
}
