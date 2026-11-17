import Farmer from "../models/farmer.model.js";
import FarmerLead from "../models/farmerLead.model.js";
import OldSalesData from "../models/oldSalesData.model.js";
import { parseYmdRange } from "../utility/istOrderDateStats.js";

const KNOWN_TTL_MS = 60_000;
let knownCache = { at: 0, phones: null };

export function normalizeMobile10(mobile) {
  if (mobile == null || mobile === "") return "";
  const digits = String(mobile).replace(/\D/g, "");
  if (digits.length < 10) return "";
  return digits.slice(-10);
}

const addPhone = (set, value) => {
  const phone = normalizeMobile10(value);
  if (phone) set.add(phone);
};

/** Mobiles already stored as a current farmer or in old sales. Public-link leads are not included. */
export async function loadKnownFarmerPhones() {
  if (knownCache.phones && Date.now() - knownCache.at < KNOWN_TTL_MS) return knownCache.phones;
  const [currentMobiles, alternateMobiles, oldSalesMobiles] = await Promise.all([
    Farmer.distinct("mobileNumber"),
    Farmer.distinct("alternateNumber"),
    OldSalesData.distinct("mobileNo"),
  ]);
  const phones = new Set();
  for (const value of currentMobiles) addPhone(phones, value);
  for (const value of alternateMobiles) addPhone(phones, value);
  for (const value of oldSalesMobiles) addPhone(phones, value);
  knownCache = { at: Date.now(), phones };
  return phones;
}

export function summarizeLeadFarmers(leads, knownPhones) {
  const known = knownPhones instanceof Set ? knownPhones : new Set(knownPhones || []);
  const byLink = new Map();
  let totalLeads = 0;
  let newFarmers = 0;
  let repeatFarmers = 0;

  for (const lead of leads || []) {
    totalLeads += 1;
    const phone = normalizeMobile10(lead?.mobileNumber);
    const repeat = Boolean(phone && known.has(phone));
    if (repeat) repeatFarmers += 1;
    else newFarmers += 1;

    const publicLinkId = lead?.publicLinkId ? String(lead.publicLinkId) : "";
    if (!publicLinkId) continue;
    let bucket = byLink.get(publicLinkId);
    if (!bucket) {
      bucket = { publicLinkId, totalLeads: 0, newFarmers: 0, repeatFarmers: 0 };
      byLink.set(publicLinkId, bucket);
    }
    bucket.totalLeads += 1;
    if (repeat) bucket.repeatFarmers += 1;
    else bucket.newFarmers += 1;
  }

  return { totalLeads, newFarmers, repeatFarmers, byLink: [...byLink.values()] };
}

export async function fetchLeadFarmerStats({ startDate, endDate } = {}) {
  const query = {};
  if (startDate || endDate) {
    const range = parseYmdRange(startDate, endDate);
    if (range.error) return { error: range.error, statusCode: 400 };
    query.createdAt = { $gte: range.rangeStart, $lte: range.rangeEnd };
  }

  const [leads, known] = await Promise.all([
    FarmerLead.find(query).select("mobileNumber publicLinkId").lean(),
    loadKnownFarmerPhones(),
  ]);

  return { data: summarizeLeadFarmers(leads, known) };
}
