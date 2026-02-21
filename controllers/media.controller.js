import multer from "multer";
import path from "path";
import fs from "fs";
import CampaignMedia from "../models/campaignMedia.model.js";

const uploadDir = path.resolve(process.cwd(), "uploads", "automation");
fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const ts = Date.now();
    const safe = file.originalname.replace(/\s+/g, "_");
    cb(null, `${ts}_${safe}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
  fileFilter: (req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp", "video/mp4", "video/quicktime", "video/webm"];
    if (!allowed.includes(file.mimetype)) {
      return cb(new Error("Invalid file type. Allowed: jpeg,png,webp,mp4,mov,webm"));
    }
    cb(null, true);
  },
});

export const uploadMedia = [
  upload.single("file"),
  async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ error: "File required (field 'file')" });
      const file = req.file;
      const url = `/uploads/automation/${file.filename}`;
      const media = await CampaignMedia.create({
        filename: file.filename,
        originalName: file.originalname,
        mimeType: file.mimetype,
        size: file.size,
        storagePath: file.path,
        url,
        uploadedBy: req.user?.id || null,
      });
      res.json({ mediaId: media._id, url: media.url, mimeType: media.mimeType, originalName: media.originalName });
    } catch (err) {
      next(err);
    }
  },
];

export const listMedia = async (req, res, next) => {
  try {
    const items = await CampaignMedia.find({}).sort({ createdAt: -1 }).limit(200).lean();
    res.json(items);
  } catch (err) {
    next(err);
  }
};

