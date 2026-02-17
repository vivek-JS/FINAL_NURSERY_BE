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

  if (normalizedContacts.length === 0) {
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
    contacts: normalizedContacts,
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

function normalizePhone(phone) {
  if (!phone) return "";
  const s = String(phone).replace(/\D/g, "");
  if (s.length === 10 && !s.startsWith("0")) return "91" + s;
  if (s.length === 12 && s.startsWith("91")) return s;
  return s;
}
