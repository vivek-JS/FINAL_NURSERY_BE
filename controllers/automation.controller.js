import multer from "multer";
import xlsx from "xlsx";
import AutomationJob from "../models/automationJob.model.js";
import SendEvent from "../models/sendEvent.model.js";
import Farmer from "../models/farmer.model.js";
import { cleanAndValidateMobileNumber, importOrdersAndFarmers } from "./excel.serveces.controller.js";

const upload = multer();

export const uploadAndCreateJob = [
  upload.single("file"),
  async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ error: "Excel file required (form field 'file')" });
      const workbook = xlsx.read(req.file.buffer, { type: "buffer" });
      const sheetName = req.body.sheet || workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      if (!sheet) return res.status(400).json({ error: `Sheet "${sheetName}" not found` });
      const rows = xlsx.utils.sheet_to_json(sheet, { defval: "" });

      const phoneColumn = req.body.column || "Mobile";
      const messageColumn = req.body.messageColumn || null;
      const jobName = req.body.name || `Import ${new Date().toISOString()}`;
      const mode = req.body.mode === "rate" ? "rate" : "immediate";
      const ratePerHour = Number(req.body.ratePerHour || 30);
      const batchSize = Number(req.body.batchSize || 30);
      const enforceOptIn = req.body.enforceOptIn === "true" || req.body.enforceOptIn === true;

      // First, run the general import to create/update farmers using existing robust logic
      let importResults = {};
      try {
        importResults = await importOrdersAndFarmers(req.file.buffer, {
          importBatchId: `automation-import-${Date.now()}`,
          sourceFilename: req.file.originalname || "upload.xlsx",
        });
      } catch (e) {
        // Log and continue — we'll still try to create farmers from rows if import failed
        console.warn("ImportOrdersAndFarmers failed:", e.message || e);
        importResults = {};
      }

      // Build targets by linking rows to Farmer records (created/updated above)
      const targets = [];
      let createdCount = 0;
      let updatedCount = 0;
      let invalidCount = 0;
      let skippedCount = 0;

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const original = row[phoneColumn];
        const cleaned = cleanAndValidateMobileNumber(String(original || ""));
        const perRowMessage = messageColumn ? (row[messageColumn] || req.body.message || "") : req.body.message || "";

        if (cleaned.primaryNumber) {
          const primary = parseInt(cleaned.primaryNumber, 10);
          const numStr = String(cleaned.primaryNumber).padStart(10, "0");
          const phone = `${req.body.countryCode || "91"}${numStr}`;
          let farmer = await Farmer.findOne({ mobileNumber: primary });
          if (farmer) {
            updatedCount++;
          } else {
            // Create minimal farmer if import didn't create it
            const farmerData = {
              name: row.Name || row.name || "Unknown",
              mobileNumber: primary,
              village: row.Address || "",
              taluka: row.Taluka || "",
              district: row.District || "",
              stateName: row.State || "Unknown",
              talukaName: row.Taluka || "",
              districtName: row.District || "",
              state: row.StateCode || "NA",
              isInvalidPhone: cleaned.isInvalid || false,
              originalPhoneNumber: cleaned.originalValue || null,
            };
            try {
              farmer = await Farmer.create(farmerData);
              createdCount++;
            } catch (e) {
              console.warn("Failed to auto-create farmer for", cleaned.primaryNumber, e.message || e);
              farmer = null;
            }
          }

          if (enforceOptIn && farmer && farmer.opt_in !== true) {
            skippedCount++;
          } else {
            targets.push({
              name: row.Name || row.name || null,
              phone,
              farmerId: farmer ? farmer._id : null,
              message: perRowMessage,
              status: "pending",
            });
          }
        } else {
          // No valid phone — create a farmer record with isInvalidPhone=true
          invalidCount++;
          let farmer = await Farmer.findOne({ name: row.Name || row.name || null, originalPhoneNumber: String(original || "") });
          if (!farmer) {
            try {
              farmer = await Farmer.create({
                name: row.Name || row.name || "Unknown",
                village: row.Address || "",
                taluka: row.Taluka || "",
                district: row.District || "",
                stateName: row.State || "Unknown",
                talukaName: row.Taluka || "",
                districtName: row.District || "",
                state: row.StateCode || "NA",
                isInvalidPhone: true,
                originalPhoneNumber: String(original || "") || null,
              });
              createdCount++;
            } catch (e) {
              console.warn("Failed to auto-create invalid-phone farmer for row", i + 2, e.message || e);
              farmer = null;
            }
          }
          // Do not add to targets unless frontend explicitly requested; by default skip
          skippedCount++;
        }
      }

      const job = await AutomationJob.create({
        name: jobName,
        message: req.body.message || "",
        mode,
        ratePerHour,
        batchSize,
        status: "created",
        createdBy: req.user?.id || null,
        targets,
      });

      // Create an initial AutomationReport for this job
      try {
        const { default: AutomationReport } = await import("../models/automationReport.model.js");
        await AutomationReport.create({
          automationJobId: job._id,
          total: targets.length,
          startedAt: new Date(),
          createdBy: req.user?.id || null,
        });
      } catch (e) {
        console.warn("Could not create automation report:", e.message || e);
      }

      return res.json({
        jobId: job._id,
        targetsCount: targets.length,
        importSummary: {
          createdFarmers: createdCount,
          updatedFarmers: updatedCount,
          invalidRows: invalidCount,
          skippedRows: skippedCount,
          autoCreatedFromImport: (importResults && importResults.autoCreatedFarmers) ? importResults.autoCreatedFarmers.length : 0,
        },
      });
    } catch (err) {
      next(err);
    }
  },
];

export const createJob = async (req, res, next) => {
  try {
    const {
      name,
      message,
      mode = "immediate",
      ratePerHour = 30,
      batchSize = 30,
      targets = [],
      mediaIds = [],
      profileId = null,
      schedule = null,
      maxPerRun = null,
      farmerListId = null,
    } = req.body;

    // Support building targets from one or more farmer lists and dedupe by normalized mobile
    let finalTargets = targets || [];
    const farmerListIds = req.body.farmerListIds || (farmerListId ? [farmerListId] : []);
    let duplicatesCount = 0;
    if (farmerListIds && farmerListIds.length > 0) {
      const FarmerList = (await import("../models/farmerList.model.js")).default;
      const FarmerModel = (await import("../models/farmer.model.js")).default;
      const phoneMap = new Map();
      for (const listId of farmerListIds) {
        const list = await FarmerList.findById(listId).populate("farmers", "name mobileNumber").lean();
        if (!list) continue;
        for (const f of list.farmers || []) {
          const cleaned = cleanAndValidateMobileNumber(String(f.mobileNumber || ""));
          if (!cleaned.primaryNumber) {
            // if no primary number, skip adding as target; could create invalid farmer earlier
            continue;
          }
          const normalized = `${req.body.countryCode || "91"}${String(cleaned.primaryNumber).padStart(10, "0")}`;
          if (!phoneMap.has(normalized)) {
            phoneMap.set(normalized, {
              name: f.name || null,
              phone: normalized,
              farmerId: f._id,
              message: message || "",
              status: "pending",
              normalizedPhone: normalized,
              attempts: 0,
            });
          } else {
            duplicatesCount++;
          }
        }
      }
      // merge any explicit targets provided in body as well, deduped by normalized phone
      for (const t of targets || []) {
        const cleaned = cleanAndValidateMobileNumber(String(t.phone || t.mobile || ""));
        if (!cleaned.primaryNumber) continue;
        const normalized = `${req.body.countryCode || "91"}${String(cleaned.primaryNumber).padStart(10, "0")}`;
        if (!phoneMap.has(normalized)) {
          phoneMap.set(normalized, {
            name: t.name || null,
            phone: normalized,
            farmerId: t.farmerId || null,
            message: t.message || message || "",
            status: "pending",
            normalizedPhone: normalized,
            attempts: 0,
          });
        } else {
          duplicatesCount++;
        }
      }
      finalTargets = Array.from(phoneMap.values());
    }

    // If preview flag is set, do not persist — return dedupe summary and sample
    if (req.body.preview === true || req.query.preview === "true") {
      const uniqueRecipients = finalTargets.length;
      return res.json({
        preview: true,
        uniqueRecipients,
        duplicatesCount,
        sampleTargets: finalTargets.slice(0, 20),
      });
    }

    const job = await AutomationJob.create({
      name,
      message,
      mode,
      ratePerHour,
      batchSize,
      targets: finalTargets,
      mediaIds,
      profileId,
      schedule,
      maxPerRun,
      createdBy: req.user?.id || null,
    });
    res.json({ jobId: job._id, uniqueRecipients: finalTargets.length, duplicatesCount });
  } catch (err) {
    next(err);
  }
};

export const startJob = async (req, res, next) => {
  try {
    const id = req.params.id;
    const job = await AutomationJob.findById(id);
    if (!job) return res.status(404).json({ error: "Job not found" });
    job.status = "active";
    await job.save();

    // enqueue each target as a per-target job in automation-targets queue
    try {
      const Queue = (await import("bull")).default;
      const REDIS = process.env.REDIS_URL || "redis://127.0.0.1:6379";
      const tQueue = new Queue("automation-targets", REDIS);
      for (let idx = 0; idx < job.targets.length; idx++) {
        const t = job.targets[idx];
        if (t.status && t.status !== "pending") continue;
        await tQueue.add({ jobId: job._id.toString(), targetIndex: idx }, { attempts: 1 });
      }
      await tQueue.close();
    } catch (e) {
      console.warn("Could not enqueue target jobs (is Redis running?)", e.message || e);
    }

    res.json({ success: true, jobId: job._id });
  } catch (err) {
    next(err);
  }
};

export const pauseJob = async (req, res, next) => {
  try {
    const id = req.params.id;
    const job = await AutomationJob.findById(id);
    if (!job) return res.status(404).json({ error: "Job not found" });
    job.status = "paused";
    await job.save();
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
};

export const getJob = async (req, res, next) => {
  try {
    const id = req.params.id;
    const job = await AutomationJob.findById(id).lean();
    if (!job) return res.status(404).json({ error: "Job not found" });
    res.json(job);
  } catch (err) {
    next(err);
  }
};

export const getJobs = async (req, res, next) => {
  try {
    const jobs = await AutomationJob.find({}).sort({ createdAt: -1 }).lean();
    res.json(jobs);
  } catch (err) {
    next(err);
  }
};

export const exportJobCsv = async (req, res, next) => {
  try {
    const id = req.params.id;
    const events = await SendEvent.find({ automationJobId: id }).sort({ timestamp: -1 }).lean();
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="automation-${id}-events.csv"`);
    const header = ["timestamp", "farmerId", "phone", "name", "message", "status", "error"].join(",") + "\n";
    res.write(header);
    for (const e of events) {
      const line = [
        new Date(e.timestamp).toISOString(),
        e.farmerId || "",
        `"${String(e.phone || "")}"`,
        `"${String(e.name || "")}"`,
        `"${String(e.message || "").replace(/"/g, '""')}"`,
        e.status,
        `"${String(e.error || "").replace(/"/g, '""')}"`,
      ].join(",") + "\n";
      res.write(line);
    }
    res.end();
  } catch (err) {
    next(err);
  }
};

export const jobHistory = async (req, res, next) => {
  try {
    const id = req.params.id;
    const page = Number(req.query.page || 1);
    const limit = Math.min(100, Number(req.query.limit || 50));
    const q = { automationJobId: id };
    const events = await SendEvent.find(q).sort({ timestamp: -1 }).skip((page - 1) * limit).limit(limit).lean();
    res.json({ page, limit, events });
  } catch (err) {
    next(err);
  }
};

