import crypto from "crypto";
import moment from "moment";
import Dispatch from "../models/dispatch.model.js";
import { generateJson, GeminiType as Type } from "./gemini.service.js";

const CACHE_TTL_MS = 30 * 60 * 1000;
const MAX_GROUPS_FOR_AI = 40;
/** Shed app request timeout is 45s; fall back to rules well before that. */
const AI_TIMEOUT_MS = 25 * 1000;
const NOTES_LANG = "mr";
const NOTES_FORMAT = "items-v2";
const MAX_ITEMS_PER_POINT = 6;

/** "Purandar (पुरंदर) (6)" → "Purandar (6)" so notes stay English-only. */
export function englishShedName(raw) {
  return String(raw || "")
    .replace(/\s*\([^)]*[^\x00-\x7F][^)]*\)/g, "")
    .trim() || "Unknown";
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`AI timed out after ${ms / 1000}s`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
let cache = null;

const PRIORITIES = ["HIGH", "MEDIUM", "LOW"];

const NOTES_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    summary: { type: Type.STRING, description: "Max 2 short sentences" },
    points: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          priority: { type: Type.STRING, enum: PRIORITIES },
          title: { type: Type.STRING, description: "Short action, max 8 words" },
          detail: {
            type: Type.STRING,
            description: "One short sentence, max 15 words, why/what to do. No shed-wise number lists.",
          },
          batch: { type: Type.STRING },
          shed: { type: Type.STRING },
          crop: { type: Type.STRING },
          plants: { type: Type.INTEGER },
          items: {
            type: Type.ARRAY,
            description: `Stock rows this point is about, max ${MAX_ITEMS_PER_POINT}`,
            items: {
              type: Type.OBJECT,
              properties: {
                batch: { type: Type.STRING },
                shed: { type: Type.STRING },
              },
              required: ["batch", "shed"],
              propertyOrdering: ["batch", "shed"],
            },
          },
        },
        required: ["priority", "title", "detail", "items"],
        propertyOrdering: ["priority", "title", "detail", "batch", "shed", "crop", "plants", "items"],
      },
    },
  },
  required: ["summary", "points"],
  propertyOrdering: ["summary", "points"],
};

function cropOf(ln) {
  return [ln.plantLabel, ln.subtypeLabel].filter(Boolean).join(" ").trim() || "Unknown";
}

/** Stock lines → one row per batch + shed + size with age and overdue days. */
export function groupStockForNotes(lines, today = moment().startOf("day")) {
  const map = new Map();
  for (const ln of lines || []) {
    const plants = Number(ln.availableQuantity) || 0;
    if (plants < 1) continue;
    const shed = englishShedName(ln.pollyhouse);
    const size = String(ln.size || "").trim();
    const key = `${ln.batchId}|${shed}|${size}`;
    const g =
      map.get(key) ||
      {
        batch: String(ln.batchNumber || "").trim() || "—",
        crop: cropOf(ln),
        cropKey: `${ln.plantCmsId?._id || ln.plantCmsId || ""}:${ln.plantSubtypeId || ""}`,
        shed,
        size,
        plants: 0,
        readyPlants: 0,
        lagwadDate: null,
        readyDate: null,
      };
    g.plants += plants;
    if (ln.dispatchEligible) g.readyPlants += plants;
    const lag = ln.secondaryInwardDate ? moment(ln.secondaryInwardDate) : null;
    if (lag?.isValid() && (!g.lagwadDate || lag.isBefore(g.lagwadDate))) g.lagwadDate = lag;
    const rd = ln.expectedReadyByCalendar ? moment(ln.expectedReadyByCalendar) : null;
    if (rd?.isValid() && (!g.readyDate || rd.isBefore(g.readyDate))) g.readyDate = rd;
    map.set(key, g);
  }

  return [...map.values()]
    .map((g) => {
      const ageDays = g.lagwadDate ? today.diff(g.lagwadDate.clone().startOf("day"), "days") : null;
      const readyIn = g.readyDate ? g.readyDate.clone().startOf("day").diff(today, "days") : null;
      return {
        batch: g.batch,
        crop: g.crop,
        cropKey: g.cropKey,
        shed: g.shed,
        size: g.size,
        plants: g.plants,
        readyPlants: g.readyPlants,
        lagwadDate: g.lagwadDate ? g.lagwadDate.format("YYYY-MM-DD") : null,
        readyDate: g.readyDate ? g.readyDate.format("YYYY-MM-DD") : null,
        ageDays,
        overdueDays: readyIn != null && readyIn < 0 ? -readyIn : 0,
        daysUntilReady: readyIn != null && readyIn > 0 ? readyIn : 0,
      };
    })
    .sort(
      (a, b) =>
        b.overdueDays - a.overdueDays ||
        (b.ageDays ?? -1) - (a.ageDays ?? -1) ||
        b.plants - a.plants
    );
}

const normKey = (s) => String(s || "").toLowerCase().replace(/\s+/g, "");

/**
 * AI item refs ({ batch, shed }) → rows with numbers taken from stock data.
 * Sizes of the same batch + shed are merged; a ref missing shed (or batch)
 * expands to every shed of that batch (or batch in that shed).
 */
export function resolveNoteItems(refs, groups, fallback = {}) {
  const rows = new Map();
  for (const g of groups || []) {
    const key = `${normKey(g.batch)}|${normKey(g.shed)}`;
    const r =
      rows.get(key) ||
      { batch: g.batch, shed: g.shed, crop: g.crop, plants: 0, readyPlants: 0, ageDays: null, overdueDays: 0 };
    r.plants += g.plants;
    r.readyPlants += g.readyPlants;
    if (g.ageDays != null) r.ageDays = Math.max(r.ageDays ?? 0, g.ageDays);
    r.overdueDays = Math.max(r.overdueDays, g.overdueDays || 0);
    rows.set(key, r);
  }

  const wanted = (Array.isArray(refs) ? refs : []).filter((x) => x && (x.batch || x.shed));
  if (!wanted.length && (fallback.batch || fallback.shed)) wanted.push(fallback);

  const out = new Map();
  for (const ref of wanted) {
    const b = normKey(ref.batch);
    const s = normKey(ref.shed);
    for (const [key, r] of rows) {
      const [rb, rs] = key.split("|");
      if ((b && rb !== b) || (s && rs !== s)) continue;
      out.set(key, r);
    }
  }
  return [...out.values()]
    .sort((a, b) => b.overdueDays - a.overdueDays || b.plants - a.plants)
    .slice(0, MAX_ITEMS_PER_POINT);
}

/** Plants still to load on pending vehicles, by plant:subtype. */
async function pendingDemandByCrop() {
  const docs = await Dispatch.find({
    isDeleted: { $ne: true },
    transportStatus: { $in: ["PENDING", "IN_TRANSIT"] },
  })
    .select("plantsDetails")
    .lean();
  const out = new Map();
  for (const d of docs) {
    for (const p of d.plantsDetails || []) {
      const key = `${p.plantId || ""}:${p.subTypeId || ""}`;
      out.set(key, (out.get(key) || 0) + (Number(p.quantity ?? p.totalPlants) || 0));
    }
  }
  return { vehicles: docs.length, byCrop: out };
}

function ruleNotes(groups, demandRows) {
  const points = [];
  for (const g of groups) {
    if (points.length >= 8) break;
    if (g.overdueDays < 1 && g.readyPlants < 1) continue;
    const priority = g.overdueDays >= 7 ? "HIGH" : g.overdueDays > 0 ? "MEDIUM" : "LOW";
    points.push({
      priority,
      title: `${g.shed} मधून बॅच ${g.batch} आधी पाठवा`,
      detail: g.overdueDays > 0 ? "तयार तारीख उलटली आहे, पुढच्या गाडीत लोड करा." : "रोप तयार आहेत.",
      batch: g.batch,
      shed: g.shed,
      crop: g.crop,
      plants: g.plants,
      items: resolveNoteItems([{ batch: g.batch, shed: g.shed }], groups),
    });
  }
  const total = groups.reduce((s, g) => s + g.plants, 0);
  const overdue = groups.filter((g) => g.overdueDays > 0).reduce((s, g) => s + g.plants, 0);
  const demand = demandRows.reduce((s, r) => s + r.pendingVehiclePlants, 0);
  return {
    summary:
      `स्टॉकमध्ये ${total.toLocaleString("en-IN")} रोप आहेत; त्यापैकी ${overdue.toLocaleString("en-IN")} रोप तयार तारखेपेक्षा जुने आहेत. ` +
      `बाकी गाड्यांना ${demand.toLocaleString("en-IN")} रोप हवे आहेत. सर्वात जुन्या बॅच आधी लोड करा.`,
    points,
  };
}

function buildPrompt(today, groups, demandRows, pendingVehicles) {
  return `You are a dispatch planner for a plant nursery's secondary hardening sheds.
Today is ${today.format("YYYY-MM-DD")}.

Goal: tell the shed team which stock is getting old and must be dispatched first (FIFO by age), so plants do not over-grow in trays.

Stock rows (one per batch + shed + size). ageDays = days since planting (lagwad). overdueDays = days past the expected ready date. readyPlants = plants ready to dispatch now.
${JSON.stringify(groups)}

Pending vehicle demand by crop (plants still to load on ${pendingVehicles} pending vehicles):
${JSON.stringify(demandRows)}

Write 5 to 8 points, most urgent first. Use HIGH for at most 4 points.
Each point is about ONE shed or ONE batch (never all sheds in one point). List the stock rows it covers in "items" as { batch, shed } (max ${MAX_ITEMS_PER_POINT}); the app shows plant counts and days for each item, so do NOT repeat per-shed numbers in detail.
title: max 8 words. detail: one short sentence, max 15 words, saying why or what to do. summary: max 2 short sentences.
Never write plant counts or day counts in title or detail; the items already show exact numbers.
Never translate or rename crops: write the crop exactly as in the data (e.g. "Banana G9", "Banana Vasai"), or say "केळी" only for Banana.
- HIGH: overdue by 7+ days or very old stock; dispatch today/next vehicles.
- MEDIUM: ready or slightly overdue; plan in the next few days.
- LOW: watch items, e.g. a crop with old stock but no pending demand (suggest the office books orders), or stock split across many sheds that should be consolidated.
Use only numbers from the data. No markdown.

Language: write summary, title and detail in simple spoken Marathi (Devanagari script) for shed workers.
Keep batch codes (e.g. RB 19), shed names and crop names exactly as given in English, and write all numbers with Western digits (0-9).
The fields batch, shed and crop must be copied exactly from the data (English).`;
}

/**
 * AI dispatch-priority notes for live secondary stock.
 * Cached for 30 min per stock snapshot; `refresh` forces a new AI call.
 */
export async function buildSecondaryStockNotes(lines, { refresh = false } = {}) {
  const today = moment().startOf("day");
  const groups = groupStockForNotes(lines, today);
  const demand = await pendingDemandByCrop();

  const stockByCrop = new Map();
  for (const g of groups) {
    const cur = stockByCrop.get(g.cropKey) || { crop: g.crop, stockPlants: 0 };
    cur.stockPlants += g.plants;
    stockByCrop.set(g.cropKey, cur);
  }
  const demandRows = [...stockByCrop.entries()].map(([key, v]) => ({
    crop: v.crop,
    stockPlants: v.stockPlants,
    pendingVehiclePlants: demand.byCrop.get(key) || 0,
  }));

  const aiGroups = groups
    .slice(0, MAX_GROUPS_FOR_AI)
    .map(({ cropKey, ...g }) => g);
  const hash = crypto
    .createHash("sha1")
    .update(JSON.stringify([NOTES_LANG, NOTES_FORMAT, today.format("YYYY-MM-DD"), aiGroups, demandRows]))
    .digest("hex");

  if (!refresh && cache && cache.hash === hash && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.result;
  }

  let notes;
  let source = "ai";
  let aiError = null;
  try {
    const raw = await withTimeout(
      generateJson(buildPrompt(today, aiGroups, demandRows, demand.vehicles), NOTES_SCHEMA),
      AI_TIMEOUT_MS
    );
    const points = (Array.isArray(raw?.points) ? raw.points : [])
      .filter((p) => p && p.title)
      .map((p) => {
        const batch = p.batch ? String(p.batch) : "";
        const shed = p.shed ? String(p.shed) : "";
        const items = resolveNoteItems(p.items, groups, { batch, shed });
        return {
          priority: PRIORITIES.includes(p.priority) ? p.priority : "MEDIUM",
          title: String(p.title),
          detail: String(p.detail || ""),
          batch,
          shed,
          crop: p.crop ? String(p.crop) : "",
          plants: items.length ? items.reduce((s, r) => s + r.plants, 0) : Number(p.plants) || 0,
          items,
        };
      });
    if (!points.length) throw new Error("AI returned no points");
    notes = { summary: String(raw.summary || ""), points };
  } catch (e) {
    aiError = e?.message || String(e);
    source = "rules";
    notes = ruleNotes(groups, demandRows);
  }

  const result = {
    lang: NOTES_LANG,
    generatedAt: new Date().toISOString(),
    source,
    aiError,
    summary: notes.summary,
    points: notes.points,
    oldest: groups.slice(0, 10).map(({ cropKey, ...g }) => g),
    demand: demandRows.sort((a, b) => b.stockPlants - a.stockPlants),
  };
  if (source === "ai") cache = { hash, at: Date.now(), result };
  return result;
}
