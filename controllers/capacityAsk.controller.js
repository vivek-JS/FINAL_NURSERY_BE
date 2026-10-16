import {
  answerFocus,
  boardForAnalyst,
  bookingDirection,
  commodityMatchesCrops,
  contextBrief,
  cropsOnSheet,
  groundAdvice,
  parseAnalystJson,
  rowsMentioned,
  rulesAnalyst,
  rulesAnswer,
  slimCapacityForAnalyst,
} from "../utility/capacityAsk.js";
import { loadCapacityBoardPayload, loadCapacitySheetPayload } from "./capacitySheet.controller.js";
import { defaultCapacityRange, parseRangeBound } from "../utility/capacitySheetMetrics.js";
import Order from "../models/order.model.js";
import PlantCms from "../models/plantCms.model.js";

const MANDI_RESOURCE = "9ef84268-d588-465a-a308-a864a43d0070";
const ANSWER_CARDS = 8;

async function fetchJson(url, ms = 12000) {
  const response = await fetch(url, { signal: AbortSignal.timeout(ms) });
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

export async function fetchDistrictWeather(district) {
  const name = String(district || "").trim();
  const empty = { available: false, district: name, rainTotalMm: 0, days: [] };
  if (!name) return empty;
  try {
    const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=5&language=en&format=json`;
    const geo = await fetchJson(geoUrl);
    const hit = (geo?.results || []).find((row) => String(row.country_code || "").toUpperCase() === "IN") || geo?.results?.[0];
    if (!hit) return empty;
    const forecastUrl =
      `https://api.open-meteo.com/v1/forecast?latitude=${hit.latitude}&longitude=${hit.longitude}` +
      `&daily=temperature_2m_max,temperature_2m_min,precipitation_sum&forecast_days=14&timezone=Asia%2FKolkata`;
    const forecast = await fetchJson(forecastUrl);
    const daily = forecast?.daily || {};
    const dates = daily.time || [];
    const days = dates.map((date, index) => ({
      date,
      tempMax: daily.temperature_2m_max?.[index] ?? null,
      tempMin: daily.temperature_2m_min?.[index] ?? null,
      rainMm: daily.precipitation_sum?.[index] ?? 0,
    }));
    const rainTotalMm = Math.round(days.reduce((sum, day) => sum + (Number(day.rainMm) || 0), 0) * 10) / 10;
    const maxes = days.map((day) => Number(day.tempMax)).filter((n) => Number.isFinite(n));
    const mins = days.map((day) => Number(day.tempMin)).filter((n) => Number.isFinite(n));
    return {
      available: true,
      district: name,
      place: hit.name,
      admin1: hit.admin1 || "",
      latitude: hit.latitude,
      longitude: hit.longitude,
      rainTotalMm,
      tempMax: maxes.length ? Math.max(...maxes) : null,
      tempMin: mins.length ? Math.min(...mins) : null,
      days,
    };
  } catch (error) {
    console.error("fetchDistrictWeather:", error?.message || error);
    return empty;
  }
}

export async function fetchMandiPrices({ district, crops }) {
  const key = String(process.env.DATA_GOV_IN_API_KEY || "").trim();
  if (!key) {
    return { available: false, reason: "DATA_GOV_IN_API_KEY is not set", prices: [] };
  }
  if (!crops?.length) {
    return { available: false, reason: "No mapped crops on this sheet", prices: [] };
  }
  try {
    const districtFilter = district
      ? `&filters[district]=${encodeURIComponent(district)}`
      : "";
    const url =
      `https://api.data.gov.in/resource/${MANDI_RESOURCE}?api-key=${encodeURIComponent(key)}` +
      `&format=json&limit=100&filters[state]=Maharashtra${districtFilter}`;
    const body = await fetchJson(url, 15000);
    const records = Array.isArray(body?.records) ? body.records : [];
    const prices = records
      .filter((row) => commodityMatchesCrops(row.commodity, crops))
      .slice(0, 12)
      .map((row) => ({
        commodity: row.commodity || "",
        market: row.market || "",
        variety: row.variety || "",
        date: row.arrival_date || "",
        minPrice: Number(row.min_price) || 0,
        maxPrice: Number(row.max_price) || 0,
        modalPrice: Number(row.modal_price) || 0,
      }));
    return {
      available: prices.length > 0,
      reason: prices.length ? "" : "No mandi rows for these crops in that district",
      prices,
    };
  } catch (error) {
    console.error("fetchMandiPrices:", error?.message || error);
    return { available: false, reason: "Mandi request failed", prices: [] };
  }
}

function analystPrompt({ district, question, capacity, board, weather, mandi }) {
  return [
    "You are the booking desk analyst of Ram Biotech, a plant nursery in Maharashtra.",
    "Staff ask you short questions before they promise plants to farmers. Answer the question they asked.",
    "",
    "DATA",
    "board.varieties is the live board, one row per crop – variety (e.g. Papaya – Taiwan):",
    "- stock.inShed / stock.readyNow: plants in our sheds now, and how many of them are ready to dispatch.",
    "- now: the current slot. It already includes overdue slots from the last board.overdueLookbackDays days.",
    "  ready = plants ready for that slot, booked = plants promised, net = ready − booked (negative = short, positive = free to sell).",
    "  overdueBooked = orders from past slots not dispatched yet (urgent). unsoldFromPast = ready plants left over from past slots.",
    "- next: the next slots in date order with the same ready / booked / net.",
    "- urgent = short now or has overdue orders. sowingRequired false = crop we do not sow (e.g. banana): only shed stock counts.",
    "- slotDays 1 = daily slots, 7 = weekly slots. Dates are DD-MM-YYYY.",
    "capacity is the older sowing sheet for the date window: canBook = sowed excess − sowing gap; negative means sow before booking.",
    "",
    "RULES",
    "- Use only these numbers. Never invent crops, varieties, dates, plant counts or prices. If the data does not have it, say so.",
    "- Always name rows as 'Crop – Variety'. Put urgent items (overdue, short) before free ones.",
    "- When asked about one crop or variety, give its stock, now and next slots.",
    "- Reply in the language of the question: Marathi (Devanagari) if the question is in Marathi, Hindi if Hindi, else simple English.",
    "- Weather and mandi are extra context only; they never override board numbers.",
    "",
    "OUTPUT: one JSON object, nothing else. Keys:",
    '  answer: the direct reply, 2-8 short lines separated by \\n, each line starting with "Crop – Variety:" when about a variety. No markdown tables.',
    '  action ("book" | "wait" | "sow_first"), confidence (0-100 integer, lower when weather or mandi is missing or rain is heavy),',
    "  summary (which varieties to sow first and which can be booked), downside (main risk), weatherNote, mandiNote.",
    "",
    JSON.stringify({
      scope: district || "Maharashtra",
      district: district || null,
      question: question || "What should we book or sow in this window, variety by variety?",
      board,
      capacity,
      weather: {
        available: weather.available,
        place: weather.place || "",
        rainTotalMm: weather.rainTotalMm,
        tempMin: weather.tempMin,
        tempMax: weather.tempMax,
        days: (weather.days || []).slice(0, 14),
      },
      mandi,
    }),
  ].join("\n");
}

async function askOpenRouter(prompt) {
  const apiKey = String(process.env.OPENROUTER_API_KEY || "").trim();
  if (!apiKey) {
    const error = new Error("OPENROUTER_API_KEY is not set");
    error.status = 500;
    throw error;
  }
  const model = String(process.env.OPENROUTER_MODEL || "openrouter/free").trim() || "openrouter/free";
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://erp.rambiotechplants.com",
      "X-Title": "Ram Biotech Capacity Analyst",
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        { role: "system", content: "Reply with a single JSON object. No markdown." },
        { role: "user", content: prompt },
      ],
    }),
    signal: AbortSignal.timeout(45000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body?.error?.message || `OpenRouter HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  const text = body?.choices?.[0]?.message?.content || "";
  return { model: body?.model || model, text, parsed: parseAnalystJson(text) };
}

const DAY = 24 * 60 * 60 * 1000;

export async function loadBookingFlow() {
  const end = new Date();
  const recentStart = new Date(end.getTime() - 14 * DAY);
  const prevStart = new Date(end.getTime() - 28 * DAY);
  const grouped = await Order.aggregate([
    {
      $match: {
        orderStatus: { $nin: ["CANCELLED", "REJECTED", "TEMPORARY_CANCELLED"] },
        $or: [
          { orderBookingDate: { $gte: prevStart, $lte: end } },
          { createdAt: { $gte: prevStart, $lte: end } },
        ],
      },
    },
    {
      $addFields: {
        when: { $ifNull: ["$orderBookingDate", "$createdAt"] },
        plants: { $add: [{ $ifNull: ["$numberOfPlants", 0] }, { $ifNull: ["$additionalPlants", 0] }] },
      },
    },
    { $match: { when: { $gte: prevStart, $lte: end } } },
    {
      $group: {
        _id: {
          plant: "$plantName",
          bucket: { $cond: [{ $gte: ["$when", recentStart] }, "recent", "previous"] },
        },
        plants: { $sum: "$plants" },
        orders: { $sum: 1 },
      },
    },
  ]);

  const byPlant = new Map();
  let recentPlants = 0;
  let previousPlants = 0;
  let recentOrders = 0;
  let previousOrders = 0;
  for (const row of grouped) {
    const id = row?._id?.plant ? String(row._id.plant) : "";
    const bucket = row?._id?.bucket === "recent" ? "recent" : "previous";
    const plants = Number(row.plants) || 0;
    const orders = Number(row.orders) || 0;
    if (bucket === "recent") {
      recentPlants += plants;
      recentOrders += orders;
    } else {
      previousPlants += plants;
      previousOrders += orders;
    }
    if (!id) continue;
    const current = byPlant.get(id) || { recent: 0, previous: 0 };
    current[bucket] += plants;
    byPlant.set(id, current);
  }

  const direction = bookingDirection(recentPlants, previousPlants);
  const ranked = [...byPlant.entries()]
    .map(([id, row]) => ({ id, delta: row.recent - row.previous, ...row }))
    .filter((row) => (direction === "down" ? row.delta < 0 : row.delta > 0))
    .sort((a, b) => (direction === "down" ? a.delta - b.delta : b.delta - a.delta))
    .slice(0, 2);
  const names = ranked.length
    ? await PlantCms.find({ _id: { $in: ranked.map((row) => row.id) } }).select("name").lean()
    : [];
  const nameById = new Map(names.map((row) => [String(row._id), row.name]));
  return {
    recentPlants,
    previousPlants,
    recentOrders,
    previousOrders,
    direction,
    movers: ranked.map((row) => ({ name: nameById.get(row.id) || "", delta: row.delta })).filter((row) => row.name),
  };
}

export const askCapacityAnalyst = async (req, res) => {
  try {
    const district = String(req.body?.district || "").trim();
    const scope = district || "Maharashtra";
    const unbounded = req.body?.all === true || String(req.body?.all || "") === "1";
    const defaults = defaultCapacityRange();
    const from = unbounded ? defaults.from : parseRangeBound(req.body?.from, defaults.from);
    const to = unbounded ? defaults.to : parseRangeBound(req.body?.to, defaults.to);
    if (!unbounded && to.isBefore(from, "day")) {
      return res.status(400).json({ success: false, message: "to must be on or after from" });
    }
    const question = String(req.body?.question || "").trim().slice(0, 500);

    const [sheet, boardPayload] = await Promise.all([
      loadCapacitySheetPayload({ from, to, unbounded }),
      loadCapacityBoardPayload().catch((error) => {
        console.error("loadCapacityBoardPayload:", error?.message || error);
        return null;
      }),
    ]);
    const capacity = slimCapacityForAnalyst(sheet);
    const board = boardForAnalyst(boardPayload);
    const crops = cropsOnSheet(sheet.plants);
    const [weather, mandi, flowResult] = await Promise.all([
      fetchDistrictWeather(scope),
      fetchMandiPrices({ district, crops }),
      loadBookingFlow().catch((error) => {
        console.error("loadBookingFlow:", error?.message || error);
        return null;
      }),
    ]);
    const flow = flowResult;

    const prompt = analystPrompt({ district, question, capacity, board, weather, mandi });
    let model = process.env.OPENROUTER_MODEL || "openrouter/free";
    let advice = null;
    let source = "rules";
    try {
      let reply = await askOpenRouter(prompt);
      if (!reply.parsed) reply = await askOpenRouter(prompt);
      if (reply.parsed) {
        advice = reply.parsed;
        model = reply.model;
        source = "openrouter";
      }
    } catch (error) {
      console.error("askOpenRouter:", error?.message || error);
    }
    if (!advice) {
      advice = rulesAnalyst({ capacity, weather, mandi, district });
      source = "rules";
    }
    advice = groundAdvice(advice, { capacity, weather, district });
    const modelAnswer = source === "openrouter" && Boolean(advice.answer);
    if (!modelAnswer) advice.answer = rulesAnswer(board, question);
    advice.answerSource = modelAnswer ? "ai" : "sheet";
    const focus = answerFocus(board, question);
    const mentioned = modelAnswer ? rowsMentioned(board, advice.answer) : [];
    const cards = mentioned.length ? mentioned : focus.rows;
    advice.answerTitle = focus.title;
    advice.answerStockOnly = !mentioned.length && focus.stockOnly;
    advice.answerRows = cards.slice(0, ANSWER_CARDS);
    advice.answerMore = Math.max(0, cards.length - ANSWER_CARDS);
    const context = contextBrief({ flow, weather, mandi, scope });

    return res.status(200).json({
      success: true,
      scope,
      district: district || null,
      from: capacity.from,
      to: capacity.to,
      source,
      model,
      advice,
      weather: {
        available: weather.available,
        place: weather.place || "",
        rainTotalMm: weather.rainTotalMm,
        tempMin: weather.tempMin,
        tempMax: weather.tempMax,
      },
      mandi: {
        available: mandi.available,
        reason: mandi.reason || "",
        prices: mandi.prices || [],
      },
      totals: capacity.totals,
      flow,
      context,
    });
  } catch (error) {
    console.error("askCapacityAnalyst:", error);
    return res.status(500).json({
      success: false,
      message: "Could not run the capacity analyst",
    });
  }
};
