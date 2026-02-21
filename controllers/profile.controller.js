import WhatsAppProfile from "../models/whatsappProfile.model.js";

export const listProfiles = async (req, res, next) => {
  try {
    const profiles = await WhatsAppProfile.find({}).sort({ createdAt: -1 }).lean();
    res.json(profiles);
  } catch (err) {
    next(err);
  }
};

export const createProfile = async (req, res, next) => {
  try {
    const { name, userDataDir, description = "", active = true } = req.body;
    if (!name || !userDataDir) return res.status(400).json({ error: "name and userDataDir required" });
    const profile = await WhatsAppProfile.create({
      name,
      userDataDir,
      description,
      active,
      createdBy: req.user?.id || null,
    });
    res.json(profile);
  } catch (err) {
    next(err);
  }
};

export const updateProfile = async (req, res, next) => {
  try {
    const id = req.params.id;
    const updates = req.body;
    const profile = await WhatsAppProfile.findByIdAndUpdate(id, updates, { new: true }).lean();
    if (!profile) return res.status(404).json({ error: "Profile not found" });
    res.json(profile);
  } catch (err) {
    next(err);
  }
};

export const deleteProfile = async (req, res, next) => {
  try {
    const id = req.params.id;
    await WhatsAppProfile.findByIdAndDelete(id);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
};

