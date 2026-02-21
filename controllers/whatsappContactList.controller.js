import WhatsAppContactList from "../models/whatsappContactList.model.js";
import AppError from "../utility/appError.js";
import catchAsync from "../utility/catchAsync.js";
import generateResponse from "../utility/responseFormat.js";

// Get all WhatsApp contact lists
export const getAllContactLists = catchAsync(async (req, res, next) => {
  const lists = await WhatsAppContactList.find({ isActive: true })
    .populate("createdBy", "name")
    .sort({ createdAt: -1 });

  const response = generateResponse(
    "Success",
    "WhatsApp contact lists fetched successfully",
    lists,
    undefined
  );

  return res.status(200).json(response);
});

// Get a single contact list by ID
export const getContactListById = catchAsync(async (req, res, next) => {
  const { id } = req.params;

  const list = await WhatsAppContactList.findById(id).populate(
    "createdBy",
    "name"
  );

  if (!list) {
    return next(new AppError("Contact list not found", 404));
  }

  const response = generateResponse(
    "Success",
    "Contact list fetched successfully",
    list,
    undefined
  );

  return res.status(200).json(response);
});

// Create a new contact list (e.g. from Excel upload)
export const createContactList = catchAsync(async (req, res, next) => {
  const { name, description, contacts, source } = req.body;

  if (!name || !name.trim()) {
    return next(new AppError("List name is required", 400));
  }

  if (!contacts || !Array.isArray(contacts) || contacts.length === 0) {
    return next(
      new AppError("At least one contact with phone number is required", 400)
    );
  }

  const existingList = await WhatsAppContactList.findOne({
    name: name.trim(),
    isActive: true,
  });

  if (existingList) {
    return next(new AppError("A list with this name already exists", 400));
  }

  const normalizedContacts = contacts
    .filter((c) => c && (c.phone || c.mobile))
    .map((c) => ({
      phone: normalizePhone(c.phone || c.mobile),
      name: (c.name || c.Name || "").trim() || "",
    }))
    .filter((c) => c.phone.length >= 10);
  
  // Deduplicate by phone (keep first occurrence)
  const uniqueByPhone = []
  const seen = new Set()
  for (const c of normalizedContacts) {
    if (!seen.has(c.phone)) {
      uniqueByPhone.push(c)
      seen.add(c.phone)
    }
  }

  const finalContacts = uniqueByPhone

  if (finalContacts.length === 0) {
    return next(
      new AppError(
        "No valid phone numbers found. Ensure column has 'phone' or 'mobile'.",
        400
      )
    );
  }

  const newList = await WhatsAppContactList.create({
    name: name.trim(),
    description: description || "",
    source: source || "excel",
    contacts: finalContacts,
    createdBy: req.user?._id || null,
    isActive: true,
  });

  const response = generateResponse(
    "Success",
    "Contact list created successfully",
    newList,
    undefined
  );

  return res.status(201).json(response);
});

// Update a contact list (name, description)
export const updateContactList = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const { name, description } = req.body;

  const list = await WhatsAppContactList.findById(id);

  if (!list) {
    return next(new AppError("Contact list not found", 404));
  }

  if (name !== undefined && name !== null) {
    const trimmed = name.trim();
    if (!trimmed) {
      return next(new AppError("List name cannot be empty", 400));
    }
    if (trimmed !== list.name) {
      const existing = await WhatsAppContactList.findOne({
        name: trimmed,
        isActive: true,
        _id: { $ne: id },
      });
      if (existing) {
        return next(new AppError("A list with this name already exists", 400));
      }
      list.name = trimmed;
    }
  }

  if (description !== undefined) {
    list.description = (description || "").trim();
  }

  await list.save();

  const response = generateResponse(
    "Success",
    "Contact list updated successfully",
    list,
    undefined
  );

  return res.status(200).json(response);
});

// Delete (soft delete) a contact list
export const deleteContactList = catchAsync(async (req, res, next) => {
  const { id } = req.params;

  const list = await WhatsAppContactList.findById(id);

  if (!list) {
    return next(new AppError("Contact list not found", 404));
  }

  list.isActive = false;
  await list.save();

  const response = generateResponse(
    "Success",
    "Contact list deleted successfully",
    null,
    undefined
  );

  return res.status(200).json(response);
});

// Extract or create Farmers from a contact list and return farmer refs
export const extractFarmersFromList = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const list = await WhatsAppContactList.findById(id);
  if (!list) return next(new AppError("Contact list not found", 404));

  const created = [];
  const existing = [];
  const errors = [];
  // Lazy import to avoid circular deps
  const Farmer = (await import("../models/farmer.model.js")).default;

  for (const c of list.contacts || []) {
    const rawPhone = c.phone || c.mobile || "";
    const normalized = normalizePhone(rawPhone);
    if (!normalized || normalized.length < 10) {
      errors.push({ contact: c, reason: "Invalid phone" });
      continue;
    }

    // Try find existing farmer by mobileNumber (numeric)
    const numeric = parseInt(normalized, 10);
    let farmer = await Farmer.findOne({ mobileNumber: numeric });
    if (farmer) {
      existing.push({ farmerId: farmer._id, phone: normalized, name: farmer.name || "" });
      continue;
    }

    // Create farmer; fill required location fields with provided values or 'Unknown'
    const name = (c.name || "Unknown").trim() || "Unknown";
    const village = (c.village || "Unknown").trim() || "Unknown";
    const taluka = (c.taluka || "Unknown").trim() || "Unknown";
    const district = (c.district || "Unknown").trim() || "Unknown";
    const stateName = (c.state || "Unknown").trim() || "Unknown";
    const stateCode = c.stateCode || "NA";

    try {
      const newFarmer = await Farmer.create({
        name,
        village,
        taluka,
        district,
        stateName,
        talukaName: taluka,
        districtName: district,
        state: stateCode,
        mobileNumber: numeric,
        isInvalidPhone: false,
        originalPhoneNumber: rawPhone || null,
      });
      created.push({ farmerId: newFarmer._id, phone: normalized, name: newFarmer.name || "" });
    } catch (e) {
      errors.push({ contact: c, reason: e.message || "create_failed" });
    }
  }

  const response = generateResponse(
    "Success",
    "Extracted farmers from contact list",
    { created, existing, errors },
    undefined
  );
  return res.status(200).json(response);
});

function normalizePhone(phone) {
  if (!phone) return "";
  const s = String(phone).replace(/\D/g, "");
  if (s.length === 10 && !s.startsWith("0")) return "91" + s;
  if (s.length === 12 && s.startsWith("91")) return s;
  return s;
}
