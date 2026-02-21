import catchAsync from "../utility/catchAsync.js";
import PublicFarmerLink from "../models/publicFarmerLink.model.js";
import Farmer from "../models/farmer.model.js";
import FarmerLead from "../models/farmerLead.model.js";
import AppError from "../utility/appError.js";
import generateResponse from "../utility/responseFormat.js";

export const importContactsForLink = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const { contacts = [], createMissing = true } = req.body;

  if (!Array.isArray(contacts) || contacts.length === 0) {
    return next(new AppError("contacts array required", 400));
  }

  const link = await PublicFarmerLink.findById(id);
  if (!link) return next(new AppError("Public farmer link not found", 404));

  const results = [];
  for (const c of contacts) {
    const name = String(c.name || "").trim();
    const mobile = String(c.mobileNumber || c.mobile || "").replace(/\D/g, "").slice(-10);
    if (!/^\d{10}$/.test(mobile)) {
      results.push({ mobile: c.mobileNumber, status: "invalid_number" });
      continue;
    }

    let farmer = await Farmer.findOne({ $or: [{ mobileNumber: Number(mobile) }, { originalPhoneNumber: mobile }] });
    if (!farmer && createMissing) {
      farmer = await Farmer.create({
        name: name || "Unknown",
        village: "Unknown",
        taluka: "Unknown",
        district: "Unknown",
        stateName: "Unknown",
        talukaName: "Unknown",
        districtName: "Unknown",
        state: "Unknown",
        mobileNumber: Number(mobile),
        originalPhoneNumber: mobile,
      });
    }

    // Create FarmerLead record linking to this link for reporting (if not exist)
    const existingLead = await FarmerLead.findOne({ publicLinkId: link._id, mobileNumber: mobile });
    if (!existingLead) {
      await FarmerLead.create({
        name: name || (farmer ? farmer.name : "Unknown"),
        mobileNumber: mobile,
        stateName: link.locationRules?.[0]?.stateName || "",
        districtName: link.locationRules?.[0]?.districts?.[0]?.districtName || "",
        talukaName: link.locationRules?.[0]?.talukas?.[0]?.talukaName || "",
        villageName: link.locationRules?.[0]?.villages?.[0]?.villageName || "",
        publicLinkId: link._id,
        sourceSlug: link.slug,
      });
    }

    results.push({ mobile, farmerId: farmer?._id || null, status: "ok" });
  }

  return res.status(200).json(generateResponse("success", "Import completed", { results }));
});

