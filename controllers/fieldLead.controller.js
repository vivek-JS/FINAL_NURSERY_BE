import { uploadToS3 } from "../services/uploadService.js";
import {
  addFollowUp,
  createLeadWithVisit,
  istDay,
  leadWithVisits,
  linksForUser,
  lookupByMobile,
  todayForUser,
} from "../services/fieldLead.service.js";
import { FieldFollowUp, Lead, LeadTarget } from "../models/fieldLead.model.js";
import PublicFarmerLink from "../models/publicFarmerLink.model.js";
import User from "../models/user.model.js";
import catchAsync from "../utility/catchAsync.js";
import AppError from "../utility/appError.js";
import generateResponse from "../utility/responseFormat.js";

async function storeFiles(files) {
  const stored = { photos: [], audio: [] };
  for (const file of files?.photos || []) {
    const url = await uploadToS3(file.buffer, file.originalname || "photo.jpg", {
      folder: "field-leads",
    });
    stored.photos.push({ url, key: file.originalname || "photo.jpg" });
  }
  for (const file of files?.audio || []) {
    const url = await uploadToS3(file.buffer, file.originalname || "note.m4a", {
      folder: "field-leads",
    });
    stored.audio.push({ url, key: file.originalname || "note.m4a" });
  }
  return stored;
}

function gpsOf(body) {
  if (body.mocked === true || body.mocked === "true") {
    throw new AppError("Fake location is not allowed. Turn off mock location and try again.", 400);
  }
  if (body.developerMode === true || body.developerMode === "true") {
    throw new AppError("Turn off developer options, then save the lead again.", 400);
  }
  const lat = Number(body.lat);
  const lng = Number(body.lng);
  const accuracy = Number(body.accuracy);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new AppError("Location is required when saving a lead", 400);
  }
  const area = String(body.area || "").trim().slice(0, 180);
  return { lat, lng, accuracy: Number.isFinite(accuracy) ? accuracy : undefined, area };
}

function placeOf(body) {
  return {
    stateName: body.stateName,
    stateCode: body.stateCode,
    districtCode: body.districtCode,
    districtName: body.districtName,
    talukaCode: body.talukaCode,
    talukaName: body.talukaName,
    villageName: body.villageName,
  };
}

export const lookupFieldLead = catchAsync(async (req, res) => {
  const result = await lookupByMobile(req.query.mobile);
  return res.status(200).json(generateResponse("success", "Lookup complete", result));
});

export const myPublicLinks = catchAsync(async (req, res) => {
  const links = await linksForUser(req.user);
  return res.status(200).json(generateResponse("success", "Public links", { links }));
});

export const todayFieldLeads = catchAsync(async (req, res) => {
  const data = await todayForUser(req.user._id);
  return res.status(200).json(generateResponse("success", "Today's leads", data));
});

export const getFieldLead = catchAsync(async (req, res) => {
  const data = await leadWithVisits(req.params.id, req.user._id);
  return res.status(200).json(generateResponse("success", "Lead fetched", data));
});

export const createFieldLead = catchAsync(async (req, res, next) => {
  const files = await storeFiles(req.files);
  try {
    const data = await createLeadWithVisit({
      mobile: req.body.mobile,
      name: req.body.name,
      place: placeOf(req.body),
      note: req.body.note,
      nextAt: req.body.nextAt,
      userId: req.user._id,
      publicLinkId: req.body.publicLinkId,
      files,
      audioSeconds: req.body.audioSeconds,
      gps: gpsOf(req.body),
    });
    return res.status(201).json(generateResponse("success", "Lead saved", data));
  } catch (err) {
    return next(err instanceof AppError ? err : new AppError(err.message || "Could not save lead", 400));
  }
});

export const fieldLeadsBoard = catchAsync(async (req, res) => {
  const day = req.query.date ? istDay(new Date(`${req.query.date}T12:00:00+05:30`)) : istDay();
  const visits = await FieldFollowUp.find({ createdAt: { $gte: day.start, $lte: day.end } })
    .sort({ createdAt: -1 })
    .lean();
  const [leads, users, targets] = await Promise.all([
    Lead.find({ _id: { $in: visits.map((v) => v.leadId) } }).lean(),
    User.find({ _id: { $in: visits.map((v) => v.by) } }).select("name phoneNumber").lean(),
    LeadTarget.find({ userId: { $in: visits.map((v) => v.by) } }).lean(),
  ]);
  const linkIds = leads.map((lead) => lead.publicLinkId).filter(Boolean);
  const linkRows = linkIds.length
    ? await PublicFarmerLink.find({ _id: { $in: linkIds } }).select("name").lean()
    : [];
  const linkNameById = new Map(linkRows.map((link) => [String(link._id), link.name]));
  const leadById = new Map(
    leads.map((lead) => [String(lead._id), { ...lead, linkName: linkNameById.get(String(lead.publicLinkId)) || "" }])
  );
  const userById = new Map(users.map((user) => [String(user._id), user]));
  const targetById = new Map(targets.map((row) => [String(row.userId), row.dailyTarget]));
  const counts = {};
  for (const visit of visits) {
    const key = String(visit.by);
    counts[key] = (counts[key] || 0) + 1;
  }
  const people = Object.keys(counts).map((id) => ({
    user: userById.get(id) || null,
    count: counts[id],
    target: targetById.get(id) ?? 10,
  }));
  return res.status(200).json(
    generateResponse("success", "Field leads", {
      date: day.ymd,
      people,
      visits: visits.map((visit) => ({
        ...visit,
        lead: leadById.get(String(visit.leadId)) || null,
        user: userById.get(String(visit.by)) || null,
      })),
    })
  );
});

export const addFieldFollowUp = catchAsync(async (req, res, next) => {
  const lead = await Lead.findById(req.params.id);
  if (!lead) return next(new AppError("Lead not found", 404));
  const files = await storeFiles(req.files);
  const followUp = await addFollowUp({
    lead,
    userId: req.user._id,
    note: req.body.note,
    nextAt: req.body.nextAt,
    place: placeOf(req.body),
    files,
    audioSeconds: req.body.audioSeconds,
    gps: gpsOf(req.body),
  });
  const fresh = await Lead.findById(lead._id).lean();
  return res.status(201).json(generateResponse("success", "Follow-up saved", { lead: fresh, followUp }));
});
