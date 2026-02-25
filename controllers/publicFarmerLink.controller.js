import PublicFarmerLink from "../models/publicFarmerLink.model.js";
import FarmerLead from "../models/farmerLead.model.js";
import catchAsync from "../utility/catchAsync.js";
import AppError from "../utility/appError.js";
import generateResponse from "../utility/responseFormat.js";

const normalizeSlug = (value) => {
  if (!value) return "";
  return String(value)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
};

export const createPublicFarmerLink = catchAsync(async (req, res, next) => {
  const { name, slug, description, locationRules, maxSubmissions, meta, isActive } = req.body;

  if (!name || !Array.isArray(locationRules) || locationRules.length === 0) {
    return next(new AppError("Name and at least one location rule are required", 400));
  }

  const finalSlug = normalizeSlug(slug || name);

  const existing = await PublicFarmerLink.findOne({ slug: finalSlug });
  if (existing) {
    return next(new AppError("Slug already in use. Please choose another.", 400));
  }

  const link = await PublicFarmerLink.create({
    name: name.trim(),
    slug: finalSlug,
    description: description || "",
    locationRules,
    maxSubmissions,
    meta,
    isActive: isActive !== undefined ? Boolean(isActive) : true,
    createdBy: req.user?._id
  });

  return res.status(201).json(
    generateResponse("success", "Public farmer link created", {
      link
    })
  );
});

export const getPublicFarmerLinks = catchAsync(async (req, res) => {
  const links = await PublicFarmerLink.aggregate([
    { $sort: { createdAt: -1 } },
    {
      $lookup: {
        from: "farmerleads",
        localField: "_id",
        foreignField: "publicLinkId",
        as: "_leads"
      }
    },
    {
      $addFields: {
        leadCount: { $size: "$_leads" }
      }
    },
    { $project: { _leads: 0 } }
  ]);

  return res.status(200).json(
    generateResponse("success", "Public farmer links fetched", {
      total: links.length,
      links
    })
  );
});

export const getPublicFarmerLinkById = catchAsync(async (req, res, next) => {
  const { id } = req.params;

  const link = await PublicFarmerLink.findById(id).lean();
  if (!link) {
    return next(new AppError("Public farmer link not found", 404));
  }

  return res.status(200).json(
    generateResponse("success", "Public farmer link fetched", {
      link
    })
  );
});

export const updatePublicFarmerLink = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const updates = { ...req.body };

  if (updates.slug) {
    updates.slug = normalizeSlug(updates.slug);

    const existing = await PublicFarmerLink.findOne({
      _id: { $ne: id },
      slug: updates.slug
    });
    if (existing) {
      return next(new AppError("Slug already in use. Please choose another.", 400));
    }
  }

  const link = await PublicFarmerLink.findByIdAndUpdate(
    id,
    updates,
    { new: true, runValidators: true }
  );

  if (!link) {
    return next(new AppError("Public farmer link not found", 404));
  }

  return res.status(200).json(
    generateResponse("success", "Public farmer link updated", {
      link
    })
  );
});

export const getPublicLinkConfigBySlug = catchAsync(async (req, res, next) => {
  const { slug } = req.params;
  const normalizedSlug = normalizeSlug(slug);

  const link = await PublicFarmerLink.findOne({
    slug: normalizedSlug,
    isActive: true
  }).lean();

  if (!link) {
    return next(new AppError("Public farmer link not found or inactive", 404));
  }

  // Only expose fields required for public form
  const publicData = {
    name: link.name,
    slug: link.slug,
    description: link.description,
    locationRules: link.locationRules
  };

  return res.status(200).json(
    generateResponse("success", "Public farmer link config", {
      link: publicData
    })
  );
});

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** GET /public-links/filter-options - Cascading district/taluka/village for leads filter dropdowns */
export const getLeadFilterOptions = catchAsync(async (req, res) => {
  const { district, taluka } = req.query;
  const talukaFilter = district ? { districtName: district } : {};
  const villageFilter = district && taluka ? { districtName: district, talukaName: taluka } : district ? { districtName: district } : taluka ? { talukaName: taluka } : {};

  const [districts, talukas, villages] = await Promise.all([
    FarmerLead.distinct("districtName").then((arr) => arr.filter(Boolean).sort()),
    FarmerLead.distinct("talukaName", talukaFilter).then((arr) => arr.filter(Boolean).sort()),
    FarmerLead.distinct("villageName", villageFilter).then((arr) => arr.filter(Boolean).sort()),
  ]);
  return res.status(200).json(
    generateResponse("success", "Filter options fetched", {
      districts,
      talukas,
      villages,
    })
  );
});

export const getFarmerLeadsForLink = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
  const skip = (page - 1) * limit;
  const q = (req.query.q || req.query.search || "").toString().trim();

  const link = await PublicFarmerLink.findById(id).lean();
  if (!link) {
    return next(new AppError("Public farmer link not found", 404));
  }

  const leadQuery = { publicLinkId: link._id };
  if (req.query.district) leadQuery.districtName = req.query.district;
  if (req.query.taluka) leadQuery.talukaName = req.query.taluka;
  if (req.query.village) leadQuery.villageName = req.query.village;
  if (q) {
    const regex = { $regex: escapeRegex(q), $options: "i" };
    leadQuery.$or = [
      { name: regex },
      { mobileNumber: regex },
      { villageName: regex },
      { talukaName: regex },
      { districtName: regex },
      { stateName: regex },
    ];
  }

  const [total, leads] = await Promise.all([
    FarmerLead.countDocuments(leadQuery),
    FarmerLead.find(leadQuery).sort({ createdAt: -1 }).skip(skip).limit(limit).lean()
  ]);

  const totalPages = Math.ceil(total / limit) || 1;
  const hasNextPage = page < totalPages;
  const nextPage = hasNextPage ? page + 1 : null;

  return res.status(200).json(
    generateResponse("success", "Farmer leads fetched", {
      total,
      page,
      limit,
      totalPages,
      hasNextPage,
      nextPage,
      leads
    })
  );
});

/** Get all farmer leads across all public links (for admin broadcast list) */
export const getAllFarmerLeads = catchAsync(async (req, res) => {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
  const skip = (page - 1) * limit;
  const q = (req.query.q || req.query.search || "").toString().trim();

  const leadQuery = {};
  if (req.query.district) leadQuery.districtName = req.query.district;
  if (req.query.taluka) leadQuery.talukaName = req.query.taluka;
  if (req.query.village) leadQuery.villageName = req.query.village;
  if (q) {
    const regex = { $regex: escapeRegex(q), $options: "i" };
    leadQuery.$or = [
      { name: regex },
      { mobileNumber: regex },
      { villageName: regex },
      { talukaName: regex },
      { districtName: regex },
      { stateName: regex },
    ];
  }

  const [total, leads] = await Promise.all([
    FarmerLead.countDocuments(leadQuery),
    FarmerLead.find(leadQuery).sort({ createdAt: -1 }).skip(skip).limit(limit).lean()
  ]);

  const totalPages = Math.ceil(total / limit) || 1;
  const hasNextPage = page < totalPages;
  const nextPage = hasNextPage ? page + 1 : null;

  const linkIds = [...new Set(leads.map((l) => l.publicLinkId?.toString()).filter(Boolean))];
  const links = await PublicFarmerLink.find({ _id: { $in: linkIds } })
    .select("_id name slug")
    .lean();
  const linkMap = Object.fromEntries(links.map((l) => [l._id.toString(), l]));

  const leadsWithLink = leads.map((lead) => ({
    ...lead,
    linkName: linkMap[lead.publicLinkId?.toString()]?.name || "",
    linkSlug: linkMap[lead.publicLinkId?.toString()]?.slug || ""
  }));

  return res.status(200).json(
    generateResponse("success", "All farmer leads fetched", {
      total,
      page,
      limit,
      totalPages,
      hasNextPage,
      nextPage,
      leads: leadsWithLink
    })
  );
});

const isLocationAllowed = (locationRules, payload) => {
  if (!Array.isArray(locationRules) || locationRules.length === 0) return false;

  return locationRules.some((rule) => {
    if (rule.stateCode !== payload.stateCode) return false;

    const hasDistrict =
      Array.isArray(rule.districts) &&
      rule.districts.some((d) => d.districtCode === payload.districtCode);

    const hasTaluka =
      Array.isArray(rule.talukas) &&
      rule.talukas.some((t) => t.talukaCode === payload.talukaCode);

    const hasVillage =
      Array.isArray(rule.villages) &&
      rule.villages.some(
        (v) =>
          v.villageName?.toLowerCase() === payload.villageName.toLowerCase()
      );

    return hasDistrict && hasTaluka && hasVillage;
  });
};

export const createFarmerLead = catchAsync(async (req, res, next) => {
  const {
    slug,
    name,
    mobileNumber,
    stateCode,
    stateName,
    districtCode,
    districtName,
    talukaCode,
    talukaName,
    villageName
  } = req.body;

  if (!slug || !name || !mobileNumber || !stateCode || !districtCode || !talukaCode || !villageName) {
    return next(new AppError("Required fields are missing", 400));
  }

  if (!/^\d{10}$/.test(String(mobileNumber))) {
    return next(new AppError("Mobile number must be 10 digits", 400));
  }

  // Check for duplicate mobile number
  const existingLead = await FarmerLead.findOne({ mobileNumber: String(mobileNumber) }).lean();
  if (existingLead) {
    return next(new AppError("या मोबाईल नंबरवर आधीच शेतकरी नोंदणी झालेली आहे", 400));
  }

  const normalizedSlug = normalizeSlug(slug);

  const link = await PublicFarmerLink.findOne({
    slug: normalizedSlug,
    isActive: true
  }).lean();

  if (!link) {
    return next(new AppError("Public farmer link not found or inactive", 404));
  }

  if (link.maxSubmissions && link.maxSubmissions > 0) {
    const currentCount = await FarmerLead.countDocuments({ publicLinkId: link._id });
    if (currentCount >= link.maxSubmissions) {
      return next(new AppError("This link has reached its submission limit", 400));
    }
  }

  const locationPayload = {
    stateCode,
    districtCode,
    talukaCode,
    villageName
  };

  if (!isLocationAllowed(link.locationRules, locationPayload)) {
    return next(new AppError("Selected location is not allowed for this link", 400));
  }

  const lead = await FarmerLead.create({
    name: name.trim(),
    mobileNumber: String(mobileNumber),
    stateCode,
    stateName,
    districtCode,
    districtName,
    talukaCode,
    talukaName,
    villageName,
    publicLinkId: link._id,
    sourceSlug: link.slug
  });

  return res.status(201).json(
    generateResponse("success", "Farmer lead created", {
      leadId: lead._id
    })
  );
});


