import mongoose from "mongoose";
import Farmer from "../models/farmer.model.js";
import FarmerLead from "../models/farmerLead.model.js";
import PublicFarmerLink from "../models/publicFarmerLink.model.js";
import { FieldFollowUp as FollowUp, Lead, LeadTarget } from "../models/fieldLead.model.js";
import AppError from "../utility/appError.js";

export function istDay(now = new Date()) {
  const ymd = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  return {
    ymd,
    start: new Date(`${ymd}T00:00:00+05:30`),
    end: new Date(`${ymd}T23:59:59.999+05:30`),
  };
}

export function cleanMobile(value) {
  const digits = String(value || "").replace(/\D/g, "");
  const mobile = digits.length > 10 ? digits.slice(-10) : digits;
  if (!/^\d{10}$/.test(mobile)) return "";
  return mobile;
}

function placeFrom(input = {}) {
  return {
    stateName: input.stateName || "Maharashtra",
    stateCode: input.stateCode || "MH",
    districtCode: input.districtCode || "",
    districtName: input.districtName || "",
    talukaCode: input.talukaCode || "",
    talukaName: input.talukaName || "",
    villageName: input.villageName || "",
  };
}

function farmerShape(farmer) {
  if (!farmer) return null;
  return {
    _id: farmer._id,
    name: farmer.name,
    mobile: String(farmer.mobileNumber || ""),
    place: {
      stateName: farmer.stateName || "Maharashtra",
      stateCode: farmer.state || "MH",
      districtCode: farmer.district || "",
      districtName: farmer.districtName || "",
      talukaCode: farmer.taluka || "",
      talukaName: farmer.talukaName || "",
      villageName: farmer.villageName || farmer.village || "",
    },
  };
}

export async function lookupByMobile(mobileRaw) {
  const mobile = cleanMobile(mobileRaw);
  if (!mobile) throw new AppError("Mobile number must be 10 digits", 400);

  const lead = await Lead.findOne({ mobile }).lean();
  if (lead) {
    let linkName = "";
    if (lead.publicLinkId) {
      const link = await PublicFarmerLink.findById(lead.publicLinkId).select("name").lean();
      linkName = link?.name || "";
    }
    return { found: true, source: "lead", mobile, lead, farmer: null, linkName };
  }

  const farmer = await Farmer.findOne({ mobileNumber: Number(mobile) }).lean();
  if (farmer) {
    const shaped = farmerShape(farmer);
    return { found: true, source: "farmer", mobile, lead: null, farmer: shaped };
  }

  return { found: false, source: null, mobile, lead: null, farmer: null };
}

async function ensureFarmer(mobile, name, place) {
  const existing = await Farmer.findOne({ mobileNumber: Number(mobile) });
  if (existing) return existing;
  return Farmer.create({
    name,
    mobileNumber: Number(mobile),
    village: place.villageName || "field",
    taluka: place.talukaCode || place.talukaName || "field",
    district: place.districtCode || place.districtName || "field",
    state: place.stateCode || "MH",
    stateName: place.stateName || "Maharashtra",
    talukaName: place.talukaName || place.talukaCode || "field",
    districtName: place.districtName || place.districtCode || "field",
  });
}

function mediaFromFiles(files = {}, audioSeconds) {
  const photos = (files.photos || []).map((file) => ({
    url: file.url,
    key: file.key,
  }));
  const audioFile = (files.audio || [])[0];
  const audio = audioFile
    ? { url: audioFile.url, key: audioFile.key, seconds: Number(audioSeconds) || 0 }
    : undefined;
  return { photos, audio };
}

export async function addFollowUp({ lead, userId, note, nextAt, place, files, audioSeconds, gps }) {
  const { photos, audio } = mediaFromFiles(files, audioSeconds);
  const nextPlace = place && place.villageName ? placeFrom(place) : undefined;
  const visitPlace =
    nextPlace && nextPlace.villageName !== (lead.place?.villageName || "") ? nextPlace : undefined;
  const followUp = await FollowUp.create({
    leadId: lead._id,
    by: userId,
    note: String(note || "").trim(),
    photos,
    audio,
    nextAt: nextAt ? new Date(nextAt) : undefined,
    place: visitPlace,
    gps,
  });

  const patch = {
    $inc: { followUpCount: 1 },
    $set: { lastFollowUpAt: followUp.createdAt },
  };
  if (visitPlace) patch.$set.place = visitPlace;
  if (userId && !lead.assignedTo?.some((id) => String(id) === String(userId))) {
    patch.$addToSet = { assignedTo: userId };
  }
  await Lead.updateOne({ _id: lead._id }, patch);
  return followUp;
}

export async function createLeadWithVisit({
  mobile,
  name,
  place,
  note,
  nextAt,
  userId,
  publicLinkId,
  assignedTo,
  files,
  audioSeconds,
  gps,
}) {
  const clean = cleanMobile(mobile);
  if (!clean) throw new AppError("Mobile number must be 10 digits", 400);
  const farmerName = String(name || "").trim();
  if (!farmerName) throw new AppError("Farmer name is required", 400);

  const loc = placeFrom(place);
  let lead = await Lead.findOne({ mobile: clean });
  let farmer = await Farmer.findOne({ mobileNumber: Number(clean) });

  if (!farmer) farmer = await ensureFarmer(clean, farmerName, loc);

  if (!lead) {
    const assignees = [...new Set((assignedTo || [userId]).filter(Boolean).map(String))];
    lead = await Lead.create({
      mobile: clean,
      name: farmerName,
      farmerId: farmer._id,
      place: loc,
      publicLinkId: publicLinkId || undefined,
      assignedTo: assignees,
      createdBy: userId,
      status: "open",
    });
  } else if (!lead.farmerId) {
    lead.farmerId = farmer._id;
    await lead.save();
  }

  const followUp = await addFollowUp({
    lead,
    userId,
    note,
    nextAt,
    place: loc,
    files,
    audioSeconds,
    gps,
  });

  if (publicLinkId && String(lead.publicLinkId || "") !== String(publicLinkId)) {
    await Lead.updateOne({ _id: lead._id }, { $set: { publicLinkId } });
  }
  await rememberPublicLinkLead({ publicLinkId, name: farmerName, mobile: clean, place: loc });

  const fresh = await Lead.findById(lead._id).lean();
  return { lead: fresh, followUp, farmerId: farmer._id };
}

function ruleRows(rules, key) {
  const rows = [];
  for (const rule of rules || []) {
    for (const row of rule[key] || []) rows.push({ ...row, stateCode: rule.stateCode, stateName: rule.stateName });
  }
  return rows;
}

export async function linksForUser(user) {
  const role = String(user?.role || user?.jobTitle || "").toUpperCase();
  const admin = ["SUPER_ADMIN", "SUPERADMIN", "ADMIN", "OFFICE_ADMIN", "OFFICEADMIN"].includes(role);
  const query = { isActive: { $ne: false } };
  if (!admin) query.assignedUserIds = user._id;
  const links = await PublicFarmerLink.find(query).select("name slug description locationRules").sort({ name: 1 }).lean();
  return links.map((link) => ({
    id: link._id,
    name: link.name,
    slug: link.slug,
    description: link.description || "",
    states: (link.locationRules || [])
      .filter((rule) => rule.stateCode)
      .map((rule) => ({ code: rule.stateCode, name: rule.stateName })),
    districts: ruleRows(link.locationRules, "districts").map((row) => ({
      code: row.districtCode,
      name: row.districtName,
      stateCode: row.stateCode,
    })),
    talukas: ruleRows(link.locationRules, "talukas").map((row) => ({
      code: row.talukaCode,
      name: row.talukaName,
      districtCode: row.districtCode || "",
    })),
    villages: ruleRows(link.locationRules, "villages").map((row) => ({
      name: row.villageName,
      talukaCode: row.talukaCode || "",
      districtCode: row.districtCode || "",
    })),
  }));
}

async function rememberPublicLinkLead({ publicLinkId, name, mobile, place }) {
  if (!publicLinkId || !place?.villageName) return;
  const link = await PublicFarmerLink.findById(publicLinkId).select("slug").lean();
  if (!link) return;
  const loc = placeFrom(place);
  const payload = {
    name,
    stateCode: loc.stateCode || "MH",
    stateName: loc.stateName || "Maharashtra",
    districtCode: loc.districtCode || loc.districtName || "field",
    districtName: loc.districtName || loc.districtCode || "field",
    talukaCode: loc.talukaCode || loc.talukaName || "field",
    talukaName: loc.talukaName || loc.talukaCode || "field",
    villageName: loc.villageName,
    publicLinkId: link._id,
    sourceSlug: link.slug,
  };
  try {
    const existing = await FarmerLead.findOne({ mobileNumber: mobile });
    if (existing) {
      existing.set(payload);
      await existing.save();
      return;
    }
    await FarmerLead.create({ ...payload, mobileNumber: mobile });
  } catch (err) {
    if (err?.code !== 11000) throw err;
  }
}

export async function upsertFromPublicLink({ link, name, mobile, place }) {
  const assignees = (link.assignedUserIds || []).filter(Boolean);
  if (!assignees.length) return null;
  const clean = cleanMobile(mobile);
  if (!clean) return null;

  const loc = placeFrom(place);
  let farmer = await Farmer.findOne({ mobileNumber: Number(clean) });
  if (!farmer) farmer = await ensureFarmer(clean, name, loc);

  const existing = await Lead.findOne({ mobile: clean });
  if (existing) {
    await Lead.updateOne(
      { _id: existing._id },
      {
        $addToSet: { assignedTo: { $each: assignees } },
        $set: { publicLinkId: link._id, farmerId: farmer._id },
      }
    );
    return existing;
  }

  return Lead.create({
    mobile: clean,
    name: String(name || "").trim(),
    farmerId: farmer._id,
    place: loc,
    publicLinkId: link._id,
    assignedTo: assignees,
    createdBy: assignees[0],
    status: "open",
    followUpCount: 0,
  });
}

export async function todayForUser(userId) {
  const { start, end } = istDay();
  const [count, targetDoc, leads] = await Promise.all([
    FollowUp.countDocuments({ by: userId, createdAt: { $gte: start, $lte: end } }),
    LeadTarget.findOne({ userId }).lean(),
    Lead.find({ assignedTo: userId }).sort({ lastFollowUpAt: -1, updatedAt: -1 }).limit(100).lean(),
  ]);
  return {
    count,
    target: targetDoc?.dailyTarget ?? 10,
    leads,
  };
}

export async function leadWithVisits(id, userId) {
  if (!mongoose.isValidObjectId(id)) throw new AppError("Lead not found", 404);
  const lead = await Lead.findById(id).lean();
  if (!lead) throw new AppError("Lead not found", 404);
  const assigned = (lead.assignedTo || []).some((uid) => String(uid) === String(userId));
  if (!assigned && String(lead.createdBy) !== String(userId)) {
    throw new AppError("You are not assigned to this lead", 403);
  }
  const visits = await FollowUp.find({ leadId: lead._id }).sort({ createdAt: -1 }).lean();
  return { lead, visits };
}

export async function saveDailyTargets(userIds, dailyTarget) {
  const target = Number(dailyTarget);
  if (!Number.isFinite(target) || target < 0) return;
  const ids = [...new Set((userIds || []).filter(Boolean).map(String))];
  await Promise.all(
    ids.map((userId) =>
      LeadTarget.updateOne({ userId }, { $set: { dailyTarget: target } }, { upsert: true })
    )
  );
}
