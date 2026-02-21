import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import Campaign from "../models/campaign.model.js";
import CampaignRunQueue from "../models/campaignRunQueue.model.js";
import FarmerList from "../models/farmerList.model.js";
import Farmer from "../models/farmer.model.js";
import FarmerLead from "../models/farmerLead.model.js";
import AutomationJob from "../models/automationJob.model.js";
import { dedupeCandidates } from "../utility/dedupeHelper.js";
import SendEvent from "../models/sendEvent.model.js";
import AutomationReport from "../models/automationReport.model.js";
import xlsx from "xlsx";
import { cleanAndValidateMobileNumber } from "./excel.serveces.controller.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CAMPAIGN_PID_DIR = path.join(__dirname, "..", ".campaign-pids");

function getPidPath(campaignId) {
  return path.join(CAMPAIGN_PID_DIR, `${String(campaignId)}.pid`);
}

/** Kill existing run-campaign-now.js and Chrome processes before starting */
function killExistingCampaignProcesses(campaignId) {
  try {
    fs.mkdirSync(CAMPAIGN_PID_DIR, { recursive: true });
    const pidPath = getPidPath(campaignId);
    if (fs.existsSync(pidPath)) {
      const pid = parseInt(fs.readFileSync(pidPath, "utf8").trim(), 10);
      if (pid && !isNaN(pid)) {
        try {
          process.kill(pid, "SIGTERM");
          console.log("[CAMPAIGN] Killed existing process:", pid);
        } catch (e) {}
      }
      fs.unlinkSync(pidPath);
    }
  } catch (e) {
    console.warn("[CAMPAIGN] killExisting:", e?.message);
  }
}

// Create campaign (supports preview=true to not persist)
export const createCampaign = async (req, res, next) => {
  try {
    // Log incoming body for debugging multipart/form-data vs json issues
    console.log("createCampaign called. body:", req.body, "file:", !!req.file)

    // If body was received as raw multipart text (some clients send --data-raw),
    // parse it into fields so downstream code works regardless.
    if (typeof req.body === "string" && req.headers && req.headers["content-type"] && req.headers["content-type"].includes("multipart/form-data")) {
      const parsed = parseMultipartText(req.body, req.headers["content-type"]);
      // overwrite req.body with parsed fields (but keep original if non-empty)
      req.body = { ...(typeof req.body === "object" ? req.body : {}), ...parsed };
    }

    // Normalize incoming fields (support JSON or multipart/form-data from clients)
    let {
      name,
      description,
      message,
      mediaIds = [],
      profileId = null,
      ratePerHour = 30,
      batchSize = 30,
      farmerListIds = [],
      farmerIds = [],
      preview = false,
    } = req.body || {};

    // If farmerIds or farmerListIds come as comma-separated strings (from form-data), parse them
    if (typeof farmerIds === "string") {
      farmerIds = farmerIds.split(",").map((s) => s.trim()).filter(Boolean)
    }
    if (typeof farmerListIds === "string") {
      farmerListIds = farmerListIds.split(",").map((s) => s.trim()).filter(Boolean)
    }

    // Manual phone numbers: comma, newline, or space separated
    let manualPhones = req.body.manualPhones || req.body.phoneNumbers || ""
    if (typeof manualPhones === "string") {
      manualPhones = manualPhones.split(/[\n,\s]+/).map((s) => s.trim()).filter(Boolean)
    }

    // If a file was uploaded under 'video' (multer), expose its originalname as a videoFilename fallback
    if (req.file && req.file.originalname && (!mediaIds || mediaIds.length === 0)) {
      // note: storing file handling is out of scope; attach filename for visibility
      mediaIds = mediaIds || []
      mediaIds.push(req.file.originalname)
    }
    // Ensure campaign has a name to satisfy model validation.
    // If frontend didn't provide a name, generate a sensible default.
    const campaignName = (name || "").toString().trim() || `Campaign ${Date.now()}`;

    // If farmerIds or farmerListIds provided, build targets directly from Farmer records
    let targets = []
    const seenTargets = new Set()
    if (Array.isArray(farmerIds) && farmerIds.length > 0) {
      // Fetch Farmers and FarmerLeads for provided IDs (prefer Farmer, fallback to FarmerLead)
      const farmersFromIds = await Farmer.find({ _id: { $in: farmerIds } }).lean()
      const farmerMap = {}
      for (const f of farmersFromIds) {
        farmerMap[String(f._id)] = f
      }
      const missingIds = farmerIds.filter((id) => !farmerMap[String(id)])
      let leads = []
      if (missingIds.length > 0) {
        leads = await FarmerLead.find({ _id: { $in: missingIds } }).lean()
      }

      // Add Farmers
      for (const f of farmersFromIds) {
        const fid = String(f._id)
        if (seenTargets.has(fid)) continue
        seenTargets.add(fid)
        targets.push({
          farmerId: f._id,
          name: f.name || "",
          phone: f.mobileNumber ? String(f.mobileNumber) : (f.originalPhoneNumber || ""),
          village: f.village || "",
          taluka: f.taluka || "",
          district: f.district || "",
          stateName: f.stateName || "",
          status: "pending",
          attempts: 0
        })
      }

      // Add FarmerLeads
      for (const l of leads) {
        const lid = String(l._id)
        if (seenTargets.has(lid)) continue
        seenTargets.add(lid)
        targets.push({
          farmerId: l._id,
          name: l.name || "",
          phone: l.mobileNumber ? String(l.mobileNumber) : (l.originalPhoneNumber || l.phone || ""),
          village: l.village || l.address || "",
          taluka: l.taluka || "",
          district: l.district || "",
          stateName: l.stateName || l.state || "",
          status: "pending",
          attempts: 0
        })
      }
    }

    for (const id of farmerListIds || []) {
      const list = await FarmerList.findById(id).populate("farmers").lean()
      if (!list) continue
      for (const f of list.farmers || []) {
        const fid = String(f._id)
        if (seenTargets.has(fid)) continue
        seenTargets.add(fid)
        targets.push({
          farmerId: f._id,
          name: f.name || "",
          phone: f.mobileNumber ? String(f.mobileNumber) : (f.originalPhoneNumber || ""),
          village: f.village || "",
          taluka: f.taluka || "",
          district: f.district || "",
          stateName: f.stateName || "",
          status: "pending",
          attempts: 0
        })
      }
    }

    // Manual phone numbers (no farmerId - phone-only targets)
    if (Array.isArray(manualPhones) && manualPhones.length > 0) {
      const normPhone = (p) => {
        const s = String(p || "").replace(/\D/g, "")
        if (s.length === 10 && !s.startsWith("0")) return "91" + s
        if (s.length === 12 && s.startsWith("91")) return s
        return s
      }
      for (const p of manualPhones) {
        const norm = normPhone(p)
        if (norm.length >= 10) {
          if (!seenTargets.has(norm)) {
            seenTargets.add(norm)
            targets.push({ farmerId: null, name: "", phone: norm, status: "pending", attempts: 0 })
          }
        }
      }
    }

    // If targets were provided (farmerIds, farmerListIds, or manualPhones) use them; otherwise fall back to dedupeCandidates
    let finalTargets = targets
    let duplicatesCount = 0
    if (targets.length === 0) {
      let candidates = []
      const dedupeResult = dedupeCandidates(candidates, String(req.body.countryCode || "91"))
      finalTargets = dedupeResult.finalTargets
      duplicatesCount = dedupeResult.duplicatesCount
    }

    if (preview) {
      return res.json({ preview: true, uniqueRecipients: finalTargets.length, duplicatesCount, sampleTargets: finalTargets.slice(0, 20) })
    }

    const campaign = await Campaign.create({
      name: campaignName,
      description,
      message,
      mediaIds,
      profileId,
      ratePerHour,
      batchSize,
      targets: finalTargets,
      recipientsCount: finalTargets.length,
      duplicatesCount,
      createdBy: req.user?.id || null,
    })

    res.json({ campaignId: campaign._id, recipientsCount: finalTargets.length, duplicatesCount });
  } catch (err) {
    next(err);
  }
};

// Helper to parse multipart body text (when clients send raw multipart text)
function parseMultipartText(bodyText, contentType) {
  try {
    const m = contentType.match(/boundary=(.*)$/i)
    if (!m) return {}
    const boundary = m[1].replace(/(^")|("$)/g, "")
    const parts = bodyText.split(`--${boundary}`)
    const data = {}
    for (let part of parts) {
      part = part.trim()
      if (!part || part === '--') continue
      const [rawHeaders, ...rest] = part.split('\r\n\r\n')
      const value = rest.join('\r\n\r\n').replace(/\r\n$/, '')
      const cd = rawHeaders.match(/name="([^"]+)"/i)
      if (cd) {
        const name = cd[1]
        data[name] = data[name] ? data[name] + ',' + value : value
      }
    }
    return data
  } catch (e) {
    return {}
  }
}

// Accept raw multipart text (for fragile clients). Parses fields into req.body then calls createCampaign logic.
export const createCampaignRaw = async (req, res, next) => {
  try {
    const raw = req.body || ''
    const contentType = req.headers['content-type'] || ''
    const parsed = parseMultipartText(raw, contentType)
    // attach parsed fields to req.body and call main handler
    req.body = { ...(req.body || {}), ...parsed }
    return await createCampaign(req, res, next)
  } catch (err) {
    next(err)
  }
}

export const uploadAndCreateCampaign = async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Excel file required (field 'file')" });
    const workbook = xlsx.read(req.file.buffer, { type: "buffer" });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    if (!sheet) return res.status(400).json({ error: "No sheet found in Excel" });
    const rows = xlsx.utils.sheet_to_json(sheet, { defval: "" });

    const name = req.body.name || `Campaign ${Date.now()}`;
    const message = req.body.message || "";
    const profileId = req.body.profileId || null;
    const mediaIds = req.body.mediaIds || [];
    const ratePerHour = Number(req.body.ratePerHour || 30);
    const batchSize = Number(req.body.batchSize || 30);

    const candidates = [];
    for (const row of rows) {
      // try common phone headers
      const possible = row["Mobile"] || row["mobile"] || row["Phone"] || row["Mobile No."] || row["mobileNumber"] || "";
      const cleaned = cleanAndValidateMobileNumber(String(possible || ""));
      if (cleaned.primaryNumber) {
        candidates.push({ name: row["Name"] || row["name"] || null, phone: String(cleaned.primaryNumber), farmerId: null, message });
        // create or update farmer
        const primary = parseInt(cleaned.primaryNumber, 10);
        let farmer = await Farmer.findOne({ mobileNumber: primary });
        if (!farmer) {
          try {
            farmer = await Farmer.create({
              name: row["Name"] || row["name"] || "Unknown",
              mobileNumber: primary,
              village: row["Address"] || "",
              taluka: row["Taluka"] || "",
              district: row["District"] || "",
              stateName: row["State"] || "Unknown",
              talukaName: row["Taluka"] || "",
              districtName: row["District"] || "",
              state: row["StateCode"] || "NA",
              isInvalidPhone: cleaned.isInvalid || false,
              originalPhoneNumber: cleaned.originalValue || null,
            });
          } catch (e) {
            // ignore creation errors
          }
        }
      } else {
        // create invalid farmer optionally
        const nameVal = row["Name"] || row["name"] || "Unknown";
        let farmer = await Farmer.findOne({ name: nameVal, originalPhoneNumber: String(possible || "") });
        if (!farmer) {
          try {
            farmer = await Farmer.create({
              name: nameVal,
              village: row["Address"] || "",
              taluka: row["Taluka"] || "",
              district: row["District"] || "",
              stateName: row["State"] || "Unknown",
              isInvalidPhone: true,
              originalPhoneNumber: String(possible || "") || null,
            });
          } catch (e) {}
        }
      }
    }

    // dedupe candidates
    const { finalTargets, duplicatesCount } = dedupeCandidates(candidates, String(req.body.countryCode || "91"));
    const campaign = await Campaign.create({
      name,
      description: req.body.description || "",
      message,
      mediaIds,
      profileId,
      ratePerHour,
      batchSize,
      targets: finalTargets,
      recipientsCount: finalTargets.length,
      duplicatesCount,
      createdBy: req.user?.id || null,
    });

    res.json({ campaignId: campaign._id, recipientsCount: finalTargets.length, duplicatesCount });
  } catch (err) {
    next(err);
  }
};

// Update campaign (allow editing name, message, description, ratePerHour, batchSize, scheduledAt)
export const updateCampaign = async (req, res, next) => {
  try {
    const { id } = req.params;
    const allowed = ["name", "description", "message", "ratePerHour", "batchSize", "scheduledAt"];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    const campaign = await Campaign.findById(id);
    if (!campaign) return res.status(404).json({ error: "Campaign not found" });
    // Prevent editing active campaign
    if (campaign.status === "active") return res.status(400).json({ error: "Cannot edit an active campaign" });
    Object.assign(campaign, updates);
    await campaign.save();
    res.json({ success: true, campaignId: campaign._id, campaign });
  } catch (err) {
    next(err);
  }
};

// Update status for multiple targets in a campaign
export const updateTargetsStatus = async (req, res, next) => {
  try {
    const { id } = req.params
    const { targetIds = [], farmerIds = [], phoneNumbers = [], status } = req.body
    if (!status) return res.status(400).json({ error: "status is required" })

    const campaign = await Campaign.findById(id)
    if (!campaign) return res.status(404).json({ error: "Campaign not found" })

    // Update by target._id, or by farmerId, or by phone
    campaign.targets = (campaign.targets || []).map((t) => {
      const tId = String(t._id || t.id || "")
      const fId = String(t.farmerId || t.farmer || "")
      const phone = String(t.phone || t.mobile || t.normalizedPhone || "")
      if (targetIds.includes(tId) || farmerIds.includes(fId) || phoneNumbers.includes(phone)) {
        t.status = status
      }
      return t
    })

    await campaign.save()
    return res.json({ success: true, updatedCount: campaign.targets.filter(t => t.status === status).length })
  } catch (err) {
    next(err)
  }
}

export const listCampaigns = async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 20)));
    const skip = (page - 1) * limit;
    const [campaigns, total] = await Promise.all([
      Campaign.find({}).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Campaign.countDocuments({})
    ]);
    res.json({ page, limit, total, campaigns });
  } catch (err) {
    next(err);
  }
};

// Get paginated targets for a campaign
export const getCampaignTargets = async (req, res, next) => {
  try {
    const campaignId = req.params.id || req.query.campaignId;
    if (!campaignId) return res.status(400).json({ error: "campaignId is required" });
    const campaign = await Campaign.findById(campaignId).lean();
    if (!campaign) return res.status(404).json({ error: "Campaign not found" });
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(500, Math.max(1, Number(req.query.limit || 50)));
    const total = (campaign.targets || []).length;
    const start = (page - 1) * limit;
    const targets = (campaign.targets || []).slice(start, start + limit);
    res.json({ campaignId, page, limit, total, targets });
  } catch (err) {
    next(err);
  }
};

export const getCampaign = async (req, res, next) => {
  try {
    const { id } = req.params;
    const campaign = await Campaign.findById(id).lean();
    if (!campaign) return res.status(404).json({ error: "Campaign not found" });
    res.json(campaign);
  } catch (err) {
    next(err);
  }
};

export const startCampaign = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { ratePer2Min } = req.body || {};
    console.log("[CAMPAIGN] startCampaign called, campaignId:", id, "ratePer2Min:", ratePer2Min);
    const campaign = await Campaign.findById(id);
    if (!campaign) return res.status(404).json({ error: "Campaign not found" });
    if (campaign.status === "active") {
      console.log("[CAMPAIGN] Campaign already active, skipping:", id);
      return res.status(400).json({ error: "Campaign already active" });
    }
    campaign.status = "active";
    await campaign.save();

    // ratePer2Min: messages per 2 minutes (default 1). ratePerHour = ratePer2Min * 30
    const effectiveRatePer2Min = ratePer2Min != null ? Math.max(1, Math.min(30, Number(ratePer2Min) || 1)) : null;
    const ratePerHour = effectiveRatePer2Min != null ? effectiveRatePer2Min * 30 : campaign.ratePerHour;

    // create an AutomationJob mirror for processing with existing processors
    const job = await AutomationJob.create({
      name: `Campaign:${campaign._id} ${campaign.name}`,
      message: campaign.message,
      mode: "rate",
      ratePerHour,
      ratePer2Min: effectiveRatePer2Min ?? 1,
      batchSize: campaign.batchSize,
      status: "created",
      createdBy: req.user?.id || null,
      targets: campaign.targets.map((t) => ({ ...t, status: "pending" })),
      mediaIds: campaign.mediaIds || [],
      profileId: campaign.profileId || null,
    });

    // link jobId to campaign and set job.campaignId
    campaign.jobId = job._id;
    job.campaignId = campaign._id;
    await job.save();
    await campaign.save();

    // enqueue per-target jobs
    const Queue = (await import("bull")).default;
    const REDIS = process.env.REDIS_URL || "redis://127.0.0.1:6379";
    const tQueue = new Queue("automation-targets", REDIS);
    for (let idx = 0; idx < job.targets.length; idx++) {
      const t = job.targets[idx];
      if (t.status && t.status !== "pending") continue;
      await tQueue.add({ jobId: job._id.toString(), targetIndex: idx }, { attempts: 1 });
    }
    await tQueue.close();

    const queuedCount = job.targets.filter((t) => !t.status || t.status === "pending").length;
    console.log("[CAMPAIGN] Campaign started:", {
      campaignId: campaign._id,
      jobId: job._id,
      targetsQueued: queuedCount,
      totalTargets: job.targets.length,
    });
    res.json({ success: true, campaignId: campaign._id, jobId: job._id });
  } catch (err) {
    next(err);
  }
};

export const pauseCampaign = async (req, res, next) => {
  try {
    const { id } = req.params;
    const campaign = await Campaign.findById(id);
    if (!campaign) return res.status(404).json({ error: "Campaign not found" });
    campaign.status = "paused";
    await campaign.save();
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
};

export const stopCampaign = async (req, res, next) => {
  try {
    const { id } = req.params;
    const campaign = await Campaign.findById(id);
    if (!campaign) return res.status(404).json({ error: "Campaign not found" });
    killExistingCampaignProcesses(id);
    campaign.status = "stopped";
    await campaign.save();
    await Campaign.updateOne({ _id: id }, { $set: { "targets.$[elem].status": "skipped" } }, { arrayFilters: [{ "elem.status": "pending" }] });
    res.json({ success: true, message: "Campaign stopped. Chrome/browser closed." });
  } catch (err) {
    next(err);
  }
};

/** Reset all campaign targets to pending so campaign can be rerun. Only updates status/lastError, does not remove targets. */
export const resetTargetsCampaign = async (req, res, next) => {
  try {
    const { id } = req.params;
    const campaign = await Campaign.findById(id).lean();
    if (!campaign) return res.status(404).json({ error: "Campaign not found" });
    const targets = campaign.targets || [];
    const toReset = targets.filter((t) => t.status && t.status !== "pending");
    if (toReset.length === 0) {
      return res.json({ success: true, message: "All targets already pending. You can rerun now." });
    }
    await Campaign.updateOne(
      { _id: id },
      {
        $set: {
          "targets.$[elem].status": "pending",
          "targets.$[elem].lastError": null,
          status: "created",
        },
      },
      { arrayFilters: [{ "elem.status": { $in: ["sent", "error", "skipped"] } }] }
    );
    console.log("[CAMPAIGN] Reset targets for campaign:", id, "count:", toReset.length);
    res.json({ success: true, message: `Reset ${toReset.length} targets to pending. You can rerun now.` });
  } catch (err) {
    next(err);
  }
};

/** Resume Web campaign: reset failed+pending to pending, then run. */
export const resumeWebCampaign = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { delaySeconds = 10 } = req.body || {};
    const campaign = await Campaign.findById(id);
    if (!campaign) return res.status(404).json({ error: "Campaign not found" });
    const toReset = (campaign.targets || []).filter((t) => !t.status || t.status === "pending" || t.status === "error" || t.status === "skipped");
    if (toReset.length === 0) {
      return res.status(400).json({ error: "No targets to resume. All already sent." });
    }
    await Campaign.updateOne(
      { _id: id },
      {
        $set: {
          "targets.$[elem].status": "pending",
          "targets.$[elem].lastError": null,
          status: "created",
        },
      },
      { arrayFilters: [{ "elem.status": { $in: ["error", "skipped"] } }] }
    );
    req.params = { ...req.params };
    req.body = { delaySeconds };
    return runNowCampaign(req, res, next);
  } catch (err) {
    next(err);
  }
};

/** Run campaign via Chrome/WhatsApp Web script. On server with display: spawns directly. On production: adds to queue for local worker. */
export const runNowCampaign = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { delaySeconds = 10 } = req.body || {};
    const campaign = await Campaign.findById(id);
    if (!campaign) return res.status(404).json({ error: "Campaign not found" });
    const pending = (campaign.targets || []).filter((t) => !t.status || t.status === "pending");
    if (pending.length === 0) {
      return res.status(400).json({ error: "No pending targets. Campaign may already be sent." });
    }
    const delay = delaySeconds != null ? Math.max(1, Math.min(300, Number(delaySeconds) || 10)) : 10;

    const runOnServer = process.env.API_RUN_CAMPAIGN === "true";
    if (runOnServer) {
      killExistingCampaignProcesses(id);
      const scriptPath = path.join(__dirname, "..", "scripts", "run-campaign-now.js");
      const pidPath = getPidPath(id);
      const child = spawn("node", [scriptPath, `--campaignId=${id}`, `--delaySeconds=${delay}`], {
        stdio: "inherit",
        env: { ...process.env, CAMPAIGN_PID_FILE: pidPath },
        cwd: path.join(__dirname, ".."),
        detached: true,
      });
      child.unref();
      try {
        fs.mkdirSync(CAMPAIGN_PID_DIR, { recursive: true });
        fs.writeFileSync(pidPath, String(child.pid));
      } catch (e) {}
      console.log("[CAMPAIGN] Spawned run-campaign-now.js for campaign:", id, "pid:", child.pid);
      return res.json({ success: true, message: "Chrome is opening. WhatsApp Web will send messages." });
    }

    await CampaignRunQueue.create({ campaignId: id, delaySeconds: delay, status: "pending" });
    console.log("[CAMPAIGN] Queued for local worker:", id);
    res.json({
      success: true,
      message: "Campaign queued. Ensure Campaign Runner is open on your computer (with Chrome). It will start automatically.",
    });
  } catch (err) {
    next(err);
  }
};

/** Worker-only: claim next pending campaign. Requires X-Campaign-Worker-Key header. */
export const claimCampaignRun = async (req, res, next) => {
  try {
    const key = req.headers["x-campaign-worker-key"];
    if (!key || key !== process.env.CAMPAIGN_WORKER_SECRET) {
      return res.status(401).json({ error: "Invalid worker key" });
    }
    const job = await CampaignRunQueue.findOneAndUpdate(
      { status: "pending" },
      { $set: { status: "running", claimedAt: new Date(), workerId: req.headers["x-worker-id"] || "local" } },
      { new: true }
    ).populate("campaignId", "name");
    if (!job) return res.json({ success: true, job: null });
    res.json({ success: true, job: { id: job._id, campaignId: job.campaignId, delaySeconds: job.delaySeconds } });
  } catch (err) {
    next(err);
  }
};

/** Worker-only: mark job completed or failed. */
export const completeCampaignRun = async (req, res, next) => {
  try {
    const key = req.headers["x-campaign-worker-key"];
    if (!key || key !== process.env.CAMPAIGN_WORKER_SECRET) {
      return res.status(401).json({ error: "Invalid worker key" });
    }
    const { id } = req.params;
    const { status = "completed", error } = req.body || {};
    await CampaignRunQueue.updateOne(
      { _id: id },
      { $set: { status: status === "failed" ? "failed" : "completed", completedAt: new Date(), error: error || null } }
    );
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
};

export const resumeCampaign = async (req, res, next) => {
  try {
    const { id } = req.params;
    const campaign = await Campaign.findById(id);
    if (!campaign) return res.status(404).json({ error: "Campaign not found" });
    if (campaign.status === "stopped") return res.status(400).json({ error: "Campaign is stopped and cannot be resumed" });
    campaign.status = "active";
    await campaign.save();

    // find or create an AutomationJob mirror
    let job = null;
    if (campaign.jobId) job = await AutomationJob.findById(campaign.jobId);
    if (!job) {
      job = await AutomationJob.create({
        name: `Campaign:${campaign._id} ${campaign.name}`,
        message: campaign.message,
        mode: "rate",
        ratePerHour: campaign.ratePerHour,
        batchSize: campaign.batchSize,
        status: "created",
        createdBy: req.user?.id || null,
        targets: campaign.targets.map((t) => ({ ...t, status: t.status || "pending" })),
        mediaIds: campaign.mediaIds || [],
        profileId: campaign.profileId || null,
        campaignId: campaign._id,
      });
      campaign.jobId = job._id;
      await campaign.save();
    } else {
      // ensure job has campaignId
      job.campaignId = campaign._id;
      await job.save();
    }

    // enqueue pending targets
    const Queue = (await import("bull")).default;
    const REDIS = process.env.REDIS_URL || "redis://127.0.0.1:6379";
    const tQueue = new Queue("automation-targets", REDIS);
    for (let idx = 0; idx < job.targets.length; idx++) {
      const t = job.targets[idx];
      if (!t.status || t.status === "pending" || t.status === "error") {
        await tQueue.add({ jobId: job._id.toString(), targetIndex: idx }, { attempts: 1 });
      }
    }
    await tQueue.close();

    res.json({ success: true, campaignId: campaign._id });
  } catch (err) {
    next(err);
  }
};

export const campaignHistory = async (req, res, next) => {
  try {
    const { id } = req.params;
    // find job(s) for this campaign
    const jobs = await AutomationJob.find({ name: new RegExp(`Campaign:${id}`) }).lean();
    const jobIds = jobs.map((j) => j._id);
    const page = Number(req.query.page || 1);
    const limit = Math.min(100, Number(req.query.limit || 50));
    const events = await SendEvent.find({ automationJobId: { $in: jobIds } }).sort({ timestamp: -1 }).skip((page - 1) * limit).limit(limit).lean();
    res.json({ page, limit, events });
  } catch (err) {
    next(err);
  }
};

export const exportCampaignCsv = async (req, res, next) => {
  try {
    const { id } = req.params;
    const jobs = await AutomationJob.find({ name: new RegExp(`Campaign:${id}`) }).lean();
    const jobIds = jobs.map((j) => j._id);
    const events = await SendEvent.find({ automationJobId: { $in: jobIds } }).sort({ timestamp: -1 }).lean();
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="campaign-${id}-events.csv"`);
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

