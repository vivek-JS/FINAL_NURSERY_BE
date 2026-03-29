import Farmer from "../models/farmer.model.js";
import FarmerLead from "../models/farmerLead.model.js";
import PublicFarmerLink from "../models/publicFarmerLink.model.js";
import CallAssignmentList from "../models/callAssignmentList.model.js";
import User from "../models/user.model.js";
import Task from "../models/task.model.js";
import FollowUp from "../models/followUp.model.js";
import AppError from "../utility/appError.js";
import catchAsync from "../utility/catchAsync.js";
import generateResponse from "../utility/responseFormat.js";
import crypto from "crypto";

const syncTaskForCallAssignmentList = async (list) => {
  try {
    const task = await Task.findOne({
      sourceType: "call_assignment",
      callAssignmentListId: list._id,
    });
    if (!task) return;

    const pendingCount = (list.entries || []).filter((e) => e.status !== "done").length;
    const completedCount = (list.completedEntries || []).length;
    const allEntries = [...(list.entries || []), ...(list.completedEntries || [])];
    const hasActivity = allEntries.some((e) => (e.callLogs || []).length > 0);
    const assignedId = String(list.assignedTo?._id || list.assignedTo || "");

    if (!Array.isArray(task.assignments) || task.assignments.length === 0) {
      task.assignments = (task.assignedEmployees || []).map((id) => ({
        employeeId: id,
        status: "pending",
      }));
    }

    task.assignments = task.assignments.map((a) => {
      if (assignedId && String(a.employeeId) !== assignedId) return a;
      const next = { ...(a?.toObject ? a.toObject() : a) };
      if (pendingCount === 0 && completedCount > 0) {
        next.status = "completed";
        next.completedAt = next.completedAt || new Date();
        if (!next.startedAt) next.startedAt = next.completedAt;
      } else if (hasActivity || completedCount > 0) {
        next.status = "in_progress";
        next.startedAt = next.startedAt || new Date();
        next.completedAt = undefined;
      } else {
        next.status = "pending";
        next.startedAt = undefined;
        next.completedAt = undefined;
      }
      return next;
    });

    const allDone = task.assignments.length > 0 && task.assignments.every((x) => x.status === "completed");
    const anyStarted = task.assignments.some((x) => x.status === "in_progress" || x.status === "completed");
    if (allDone) {
      task.status = "completed";
      task.completedAt = task.completedAt || new Date();
    } else if (anyStarted) {
      task.status = "in_progress";
      task.completedAt = undefined;
    } else {
      task.status = "pending";
      task.completedAt = undefined;
    }

    await task.save();
  } catch (e) {
    console.error("Failed to sync linked task for call assignment list:", e);
  }
};

const normalizePhone = (v) => {
  if (v == null) return "";
  const s = String(v).replace(/\D/g, "");
  return s.length >= 10 ? s.slice(-10) : s;
};

const verifyPhoneForList = (list, phone) => {
  const assignedPhone = list.assignedTo?.phoneNumber;
  if (!assignedPhone) return false;
  return normalizePhone(phone) === normalizePhone(assignedPhone);
};

const LINK_EXPIRY_HOURS = 18;

const isLinkExpired = (list) => {
  const expiresAt = list.linkExpiresAt || (list.createdAt && new Date(list.createdAt.getTime() + LINK_EXPIRY_HOURS * 60 * 60 * 1000));
  return expiresAt && new Date() > new Date(expiresAt);
};

const getListStats = (list) => {
  const pending = list.entries?.length || 0;
  const done = list.completedEntries?.length || 0;
  const total = pending + done;
  return { total, done, pending };
};

/** GET /filter-values - Distinct districts, talukas, villages, states from farmer/lead/both */
export const getFilterValues = catchAsync(async (req, res) => {
  const { source = "both", linkId } = req.query;
  const leadQuery = {};
  if (linkId) leadQuery.publicLinkId = linkId;
  else if (source === "farmerForm") leadQuery.publicLinkId = { $exists: true, $ne: null };

  const runAgg = async (model, districtKey, talukaKey, villageKey, stateKey, query = {}) => {
    const pipeline = [
      { $match: query },
      {
        $group: {
          _id: null,
          districts: { $addToSet: `$${districtKey}` },
          talukas: { $addToSet: `$${talukaKey}` },
          villages: { $addToSet: `$${villageKey}` },
          states: { $addToSet: `$${stateKey}` },
        },
      },
    ];
    const result = await model.aggregate(pipeline);
    const r = result[0] || {};
    const clean = (arr) => [...new Set((arr || []).map((v) => String(v || "").trim()).filter(Boolean))].sort();
    return {
      districts: clean(r.districts),
      talukas: clean(r.talukas),
      villages: clean(r.villages),
      states: clean(r.states),
    };
  };

  const farmerQuery = { mobileNumber: { $exists: true, $ne: null } };

  if (source === "farmer") {
    const data = await runAgg(Farmer, "districtName", "talukaName", "village", "stateName", farmerQuery);
    return res.status(200).json(generateResponse("success", "Filter values fetched", data));
  }
  if (source === "lead" || source === "farmerForm") {
    const data = await runAgg(FarmerLead, "districtName", "talukaName", "villageName", "stateName", leadQuery);
    return res.status(200).json(generateResponse("success", "Filter values fetched", data));
  }
  const [farmerData, leadData] = await Promise.all([
    runAgg(Farmer, "districtName", "talukaName", "village", "stateName", farmerQuery),
    runAgg(FarmerLead, "districtName", "talukaName", "villageName", "stateName", leadQuery),
  ]);
  const merge = (a, b) => [...new Set([...(a || []), ...(b || [])])].filter(Boolean).sort();
  const data = {
    districts: merge(farmerData.districts, leadData.districts),
    talukas: merge(farmerData.talukas, leadData.talukas),
    villages: merge(farmerData.villages, leadData.villages),
    states: merge(farmerData.states, leadData.states),
  };
  return res.status(200).json(generateResponse("success", "Filter values fetched", data));
});

/** GET /combined - Merge farmers + leads + farmer form, dedupe by phone, apply filters, paginated */
export const getCombinedList = catchAsync(async (req, res, next) => {
  const { search, district, taluka, village, stateName, opt_in, page = 1, limit = 50, source, linkId, includeAll } = req.query;
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitParsed = parseInt(limit, 10);
  const limitNum = Math.min(100, Math.max(5, Number.isFinite(limitParsed) ? limitParsed : 50));
  const skip = (pageNum - 1) * limitNum;

  const farmerQuery = { mobileNumber: { $exists: true, $ne: null } };
  const leadQuery = {};
  if (district) {
    farmerQuery.districtName = new RegExp(district, "i");
    leadQuery.districtName = new RegExp(district, "i");
  }
  if (taluka) {
    farmerQuery.talukaName = new RegExp(taluka, "i");
    leadQuery.talukaName = new RegExp(taluka, "i");
  }
  if (village) {
    farmerQuery.village = new RegExp(village, "i");
    leadQuery.villageName = new RegExp(village, "i");
  }
  if (stateName) {
    farmerQuery.stateName = new RegExp(stateName, "i");
    leadQuery.stateName = new RegExp(stateName, "i");
  }
  if (search) {
    const searchRe = new RegExp(search, "i");
    farmerQuery.$or = [{ name: searchRe }, { mobileNumber: searchRe }];
    leadQuery.$or = [{ name: searchRe }, { mobileNumber: searchRe }];
  }
  if (linkId) {
    leadQuery.publicLinkId = linkId;
  } else if (source === "farmerForm") {
    // "All forms" - leads from any public farmer link
    leadQuery.publicLinkId = { $exists: true, $ne: null };
  }
  if (opt_in === "true" || opt_in === true) {
    farmerQuery.opt_in = true;
    leadQuery.opt_in = true;
  } else if (opt_in === "false" || opt_in === false) {
    farmerQuery.opt_in = false;
    leadQuery.opt_in = false;
  }

  let activeSet = new Set();
  if (includeAll !== "true" && includeAll !== true) {
    const activeEntries = await CallAssignmentList.aggregate([
      { $match: { isActive: true, "entries.status": "pending" } },
      { $unwind: "$entries" },
      { $match: { "entries.status": "pending" } },
      { $project: { source: "$entries.source", sourceId: "$entries.sourceId" } },
    ]);
    activeSet = new Set(activeEntries.map((e) => `${e.source}:${e.sourceId}`));
  }

  const buildFarmerItems = (farmers) => {
    const items = [];
    const seen = new Set();
    for (const f of farmers) {
      const phone = normalizePhone(f.mobileNumber);
      if (!phone || seen.has(phone)) continue;
      if (activeSet.has(`farmer:${f._id}`)) continue;
      seen.add(phone);
      if (district && !String(f.districtName || "").toLowerCase().includes(String(district).toLowerCase())) continue;
      if (taluka && !String(f.talukaName || "").toLowerCase().includes(String(taluka).toLowerCase())) continue;
      if (village && !String(f.village || "").toLowerCase().includes(String(village).toLowerCase())) continue;
      if (stateName && !String(f.stateName || "").toLowerCase().includes(String(stateName).toLowerCase())) continue;
      if (search) {
        const q = String(search).toLowerCase();
        if (!String(f.name || "").toLowerCase().includes(q) && !String(phone).includes(q)) continue;
      }
      if (opt_in === "true" || opt_in === true) { if (f.opt_in !== true) continue; }
      else if (opt_in === "false" || opt_in === false) { if (f.opt_in === true) continue; }
      items.push({
        source: "farmer",
        sourceId: f._id,
        phone,
        name: f.name || "",
        village: f.village || "",
        district: f.districtName || "",
        taluka: f.talukaName || "",
        stateName: f.stateName || "",
        opt_in: !!f.opt_in,
      });
    }
    return items;
  };

  const buildLeadItems = (leads) => {
    const items = [];
    const seen = new Set();
    for (const l of leads) {
      const phone = normalizePhone(l.mobileNumber);
      if (!phone || seen.has(phone)) continue;
      if (activeSet.has(`lead:${l._id}`)) continue;
      seen.add(phone);
      if (district && !String(l.districtName || "").toLowerCase().includes(String(district).toLowerCase())) continue;
      if (taluka && !String(l.talukaName || "").toLowerCase().includes(String(taluka).toLowerCase())) continue;
      if (village && !String(l.villageName || "").toLowerCase().includes(String(village).toLowerCase())) continue;
      if (stateName && !String(l.stateName || "").toLowerCase().includes(String(stateName).toLowerCase())) continue;
      if (search) {
        const q = String(search).toLowerCase();
        if (!String(l.name || "").toLowerCase().includes(q) && !String(phone).includes(q)) continue;
      }
      if (opt_in === "true" || opt_in === true) { if (l.opt_in !== true) continue; }
      else if (opt_in === "false" || opt_in === false) { if (l.opt_in === true) continue; }
      items.push({
        source: "lead",
        sourceId: l._id,
        phone,
        name: l.name || "",
        village: l.villageName || "",
        district: l.districtName || "",
        taluka: l.talukaName || "",
        stateName: l.stateName || "",
        opt_in: !!l.opt_in,
      });
    }
    return items;
  };

  const fetchSource = source === "lead" || source === "farmerForm" ? "lead" : source === "farmer" ? "farmer" : "all";

  const fetchPaginated = async (model, query, buildFn, selectFields, sort) => {
    let items = [];
    let offset = skip;
    for (let i = 0; i < 5; i++) {
      const docs = await model.find(query).select(selectFields).sort(sort || {}).skip(offset).limit(limitNum * 3).lean();
      if (docs.length === 0) break;
      const built = buildFn(docs);
      for (const b of built) {
        items.push(b);
        if (items.length >= limitNum) break;
      }
      if (items.length >= limitNum) break;
      offset += docs.length;
    }
    return items.slice(0, limitNum);
  };

  if (fetchSource === "farmer") {
    const total = await Farmer.countDocuments(farmerQuery);
    const items = await fetchPaginated(
      Farmer,
      farmerQuery,
      buildFarmerItems,
      "name mobileNumber village taluka district stateName talukaName districtName opt_in",
      null
    );
    return res.status(200).json(
      generateResponse("success", "Farmers fetched", {
        total,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.max(1, Math.ceil(total / limitNum)),
        items,
      })
    );
  }

  if (fetchSource === "lead") {
    const total = await FarmerLead.countDocuments(leadQuery);
    const items = await fetchPaginated(
      FarmerLead,
      leadQuery,
      buildLeadItems,
      "name mobileNumber villageName talukaName districtName stateName publicLinkId opt_in",
      { createdAt: -1 }
    );
    return res.status(200).json(
      generateResponse("success", source === "farmerForm" ? "Farmer form leads fetched" : "Leads fetched", {
        total,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.max(1, Math.ceil(total / limitNum)),
        items,
      })
    );
  }

  const [farmerItems, leadItems] = await Promise.all([
    fetchPaginated(Farmer, farmerQuery, buildFarmerItems, "name mobileNumber village taluka district stateName talukaName districtName opt_in", null),
    fetchPaginated(FarmerLead, leadQuery, buildLeadItems, "name mobileNumber villageName talukaName districtName stateName publicLinkId opt_in", { createdAt: -1 }),
  ]);
  const farmersTotal = await Farmer.countDocuments(farmerQuery);
  const leadsTotal = await FarmerLead.countDocuments(leadQuery);
  return res.status(200).json(
    generateResponse("success", "Combined list fetched", {
      farmers: { items: farmerItems, total: farmersTotal, page: pageNum, limit: limitNum, totalPages: Math.max(1, Math.ceil(farmersTotal / limitNum)) },
      leads: { items: leadItems, total: leadsTotal, page: pageNum, limit: limitNum, totalPages: Math.max(1, Math.ceil(leadsTotal / limitNum)) },
    })
  );
});

/** POST /assign - Create list and assign to employee */
export const assignList = catchAsync(async (req, res, next) => {
  const { name, description, assignedTo, items } = req.body;

  if (!name || !assignedTo || !Array.isArray(items) || items.length === 0) {
    return next(new AppError("name, assignedTo and items (array) are required", 400));
  }

  const employee = await User.findById(assignedTo);
  if (!employee) return next(new AppError("Employee not found", 404));

  const activeEntries = await CallAssignmentList.aggregate([
    { $match: { isActive: true, "entries.status": "pending" } },
    { $unwind: "$entries" },
    { $match: { "entries.status": "pending" } },
    { $project: { source: "$entries.source", sourceId: "$entries.sourceId" } },
  ]);
  const activeSet = new Set(activeEntries.map((e) => `${e.source}:${e.sourceId}`));

  const entries = [];
  for (const it of items) {
    const src = it.source || "farmer";
    const sid = it.sourceId;
    if (!sid || activeSet.has(`${src}:${sid}`)) continue;

    let phone = it.phone || "";
    let displayName = it.name || "";
    let village = it.village || "";
    let district = it.district || "";
    let taluka = it.taluka || "";
    let stateName = it.stateName || "";

    if (src === "farmer") {
      const f = await Farmer.findById(sid).select("name mobileNumber village taluka district stateName talukaName districtName opt_in").lean();
      if (f) {
        phone = normalizePhone(f.mobileNumber) || phone;
        displayName = f.name || displayName;
        village = f.village || village;
        district = f.districtName || district;
        taluka = f.talukaName || taluka;
        stateName = f.stateName || stateName;
      }
    } else {
      const l = await FarmerLead.findById(sid).select("name mobileNumber villageName talukaName districtName stateName").lean();
      if (l) {
        phone = normalizePhone(l.mobileNumber) || phone;
        displayName = l.name || displayName;
        village = l.villageName || village;
        district = l.districtName || district;
        taluka = l.talukaName || taluka;
        stateName = l.stateName || stateName;
      }
    }

    if (!phone) continue;
    entries.push({
      source: src,
      sourceId: sid,
      phone,
      name: displayName,
      village,
      district,
      taluka,
      stateName,
      status: "pending",
      callLogs: [],
    });
    activeSet.add(`${src}:${sid}`);
  }

  if (entries.length === 0) {
    return next(new AppError("No valid items to add (all may already be in active lists)", 400));
  }

  const token = crypto.randomBytes(16).toString("hex");
  const list = await CallAssignmentList.create({
    name: name.trim(),
    description: description || "",
    assignedTo,
    assignedBy: req.user?._id || null,
    entries,
    isActive: true,
    publicToken: token,
  });

  const dueDateStr = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  try {
    await Task.create({
      title: `Call list: ${name.trim()}`,
      description: description || `Call assignment for ${entries.length} contacts`,
      dueDate: dueDateStr,
      priority: "medium",
      status: "pending",
      assignedEmployees: [assignedTo],
      assignments: [{ employeeId: assignedTo, status: "pending" }],
      tags: ["call-assignment"],
      sourceType: "call_assignment",
      callAssignmentListId: list._id,
      createdBy: req.user?._id || assignedTo,
    });
  } catch (e) {
    console.error("Failed to create linked ERP task for call assignment:", e);
  }

  const populated = await CallAssignmentList.findById(list._id)
    .populate("assignedTo", "name phoneNumber")
    .populate("assignedBy", "name")
    .lean();

  return res.status(201).json(
    generateResponse("success", "List assigned successfully", {
      list: populated,
      mobileUrl: `/call-list/${list._id}/${token}`,
    })
  );
});

/** GET /lists - All lists (admin) or my lists (employee) */
export const getLists = catchAsync(async (req, res, next) => {
  const { myOnly } = req.query;
  const isSuperAdmin = req.user?.role === "SUPER_ADMIN" || req.user?.jobTitle === "SUPER_ADMIN";

  let query = { isActive: true };
  if (!isSuperAdmin && myOnly !== "false") {
    query.assignedTo = req.user._id;
  }

  const lists = await CallAssignmentList.find(query)
    .populate("assignedTo", "name phoneNumber")
    .populate("assignedBy", "name")
    .sort({ createdAt: -1 })
    .lean();

  const withStats = lists.map((l) => {
    const stats = getListStats(l);
    return { ...l, ...stats };
  });

  return res.status(200).json(
    generateResponse("success", "Lists fetched", {
      lists: withStats,
    })
  );
});

/** GET /lists/:id - Single list with entries */
export const getListById = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const list = await CallAssignmentList.findById(id)
    .populate("assignedTo", "name phoneNumber")
    .populate("assignedBy", "name")
    .lean();

  if (!list) return next(new AppError("List not found", 404));

  const assignedId = list.assignedTo?._id?.toString() || list.assignedTo?.toString();
  const isOwner = assignedId === req.user?._id?.toString();
  const isSuperAdmin = req.user?.role === "SUPER_ADMIN" || req.user?.jobTitle === "SUPER_ADMIN";
  if (!isOwner && !isSuperAdmin) {
    return next(new AppError("Not authorized to view this list", 403));
  }

  const stats = getListStats(list);
  return res.status(200).json(
    generateResponse("success", "List fetched", {
      list: { ...list, ...stats },
    })
  );
});

/** GET /lists/:id/mobile - Mobile-friendly data (auth or token) */
export const getListForMobile = catchAsync(async (req, res, next) => {
  const { id, token } = req.params;

  let list = await CallAssignmentList.findOne({
    _id: id,
    isActive: true,
  })
    .populate("assignedTo", "name phoneNumber")
    .lean();

  if (!list) return next(new AppError("List not found", 404));

  if (token) {
    if (list.publicToken !== token) {
      return next(new AppError("Invalid token", 403));
    }
  } else {
    const assignedId = list.assignedTo?._id?.toString() || list.assignedTo?.toString();
  const isOwner = assignedId === req.user?._id?.toString();
    const isSuperAdmin = req.user?.role === "SUPER_ADMIN" || req.user?.jobTitle === "SUPER_ADMIN";
    if (!req.user || (!isOwner && !isSuperAdmin)) {
      return next(new AppError("Authentication required", 401));
    }
  }

  const stats = getListStats(list);
  // Also fetch any follow-ups related to farmers present in this list (by farmerId)
  const farmerIds = (list.entries || [])
    .map((e) => {
      if (e.source === "farmer") return e.sourceId;
      return null;
    })
    .filter(Boolean);

  let followUpsByFarmer = {};
  if (farmerIds.length > 0) {
    const fups = await FollowUp.find({ farmerId: { $in: farmerIds } }).sort({ scheduledAt: 1 }).lean();
    followUpsByFarmer = fups.reduce((acc, fu) => {
      const key = String(fu.farmerId);
      acc[key] = acc[key] || [];
      acc[key].push(fu);
      return acc;
    }, {});
  }

  // Provide list of employees (id + name) so mobile UI can offer assignment options
  const employees = await User.find({}).select("name _id").lean();

  return res.status(200).json(
    generateResponse("success", "List fetched for mobile", {
      list: {
        _id: list._id,
        name: list.name,
        assignedTo: list.assignedTo,
        entries: list.entries || [],
        followUpsByFarmer,
        employees,
        ...stats,
      },
    })
  );
});

/** POST /lists/:id/call-log - Record call and optionally mark done (auth or token) */
export const addCallLog = catchAsync(async (req, res, next) => {
  const { id, token } = req.params;
  const { entryIndex, remark, result, durationSeconds, token: bodyToken } = req.body;

  const idx = typeof entryIndex === "number" ? entryIndex : parseInt(entryIndex, 10);
  if (isNaN(idx) || idx < 0) {
    return next(new AppError("entryIndex (number) is required", 400));
  }

  const list = await CallAssignmentList.findById(id);
  if (!list) return next(new AppError("List not found", 404));

  const useToken = token || bodyToken;
  let employeeId = req.user?._id;

  if (useToken) {
    if (list.publicToken !== useToken) return next(new AppError("Invalid token", 403));
    employeeId = list.assignedTo;
  } else {
    const assignedId = list.assignedTo?._id?.toString() || list.assignedTo?.toString();
    const isOwner = assignedId === req.user?._id?.toString();
    const isSuperAdmin = req.user?.role === "SUPER_ADMIN" || req.user?.jobTitle === "SUPER_ADMIN";
    if (!req.user || (!isOwner && !isSuperAdmin)) {
      return next(new AppError("Not authorized to update this list", 403));
    }
  }

  const pendingEntries = list.entries?.filter((e) => e.status !== "done") || [];
  const entry = pendingEntries[idx];
  if (!entry) return next(new AppError("Entry not found", 404));

  const logEntry = {
    employeeId,
    timestamp: new Date(),
    remark: String(remark || ""),
    result: ["connected", "no_answer", "not_interested", "done", "callback", "other"].includes(result) ? result : "other",
    durationSeconds: durationSeconds != null ? Number(durationSeconds) : null,
  };

  if (!entry.callLogs) entry.callLogs = [];
  entry.callLogs.push(logEntry);

  if (logEntry.result === "done" || logEntry.result === "not_interested") {
    entry.status = "done";
    list.completedEntries = list.completedEntries || [];
    const copy = typeof entry.toObject === "function" ? entry.toObject() : JSON.parse(JSON.stringify(entry));
    list.completedEntries.push(copy);
    list.entries = list.entries.filter((e) => e.status !== "done");
  }

  await list.save();
  await syncTaskForCallAssignmentList(list);

  const updated = await CallAssignmentList.findById(id)
    .populate("assignedTo", "name phoneNumber")
    .lean();

  const stats = getListStats(updated);

  return res.status(200).json(
    generateResponse("success", "Call log added", {
      list: { ...updated, entries: updated.entries || [], ...stats },
    })
  );
});

/** Public: GET /call-list/:id/:token - Mobile list (requires phone verification, link expires in 18h) */
export const getListForMobilePublic = catchAsync(async (req, res, next) => {
  const { id, token } = req.params;
  const phone = req.query.phone || req.body?.phone || "";

  const list = await CallAssignmentList.findOne({ _id: id, isActive: true, publicToken: token })
    .populate("assignedTo", "name phoneNumber")
    .lean();

  if (!list) return next(new AppError("List not found or invalid token", 404));

  if (isLinkExpired(list)) {
    return res.status(403).json(
      generateResponse("fail", "This link has expired (valid for 18 hours)", null, {
        code: "LINK_EXPIRED",
      })
    );
  }

  if (!phone || !verifyPhoneForList(list, phone)) {
    return res.status(403).json(
      generateResponse("fail", "Enter your mobile number to access this list", null, {
        code: "PHONE_REQUIRED",
        message: "Mobile number must match the assigned employee",
      })
    );
  }

  const allEntries = list.entries || [];
  const pendingEntries = allEntries.filter((e) => e.status !== "done");
  const doneCount = allEntries.filter((e) => e.status === "done").length;

  return res.status(200).json(
    generateResponse("success", "List fetched for mobile", {
      list: {
        _id: list._id,
        name: list.name,
        assignedTo: list.assignedTo,
        entries: pendingEntries,
        total: allEntries.length,
        done: doneCount,
        pending: pendingEntries.length,
      },
    })
  );
});

/** Public: POST /call-list/:id/:token/call-log - Record call (requires phone verification, link expires in 18h) */
export const addCallLogPublic = catchAsync(async (req, res, next) => {
  const { id, token } = req.params;
  const list = await CallAssignmentList.findById(id).populate("assignedTo", "phoneNumber");
  if (!list || list.publicToken !== token) {
    return next(new AppError("List not found or invalid token", 404));
  }

  if (isLinkExpired(list)) {
    return res.status(403).json(
      generateResponse("fail", "This link has expired (valid for 18 hours)", null, {
        code: "LINK_EXPIRED",
      })
    );
  }

  const phone = req.body.phone || req.query.phone || "";
  if (!phone || !verifyPhoneForList(list, phone)) {
    return res.status(403).json(
      generateResponse("fail", "Mobile number required or does not match", null, {
        code: "PHONE_REQUIRED",
      })
    );
  }

  const { entryIndex, remark, result, durationSeconds } = req.body;
  const idx = typeof entryIndex === "number" ? entryIndex : parseInt(entryIndex, 10);
  if (isNaN(idx) || idx < 0) {
    return next(new AppError("entryIndex (number) is required", 400));
  }

  const pendingEntries = list.entries.filter((e) => e.status !== "done");
  const entry = pendingEntries[idx];
  if (!entry) return next(new AppError("Entry not found", 404));

  const logEntry = {
    employeeId: list.assignedTo,
    timestamp: new Date(),
    remark: String(remark || ""),
    result: ["connected", "no_answer", "not_interested", "done", "callback", "other"].includes(result) ? result : "other",
    durationSeconds: durationSeconds != null ? Number(durationSeconds) : null,
  };

  if (!entry.callLogs) entry.callLogs = [];
  entry.callLogs.push(logEntry);

  if (logEntry.result === "done" || logEntry.result === "not_interested") {
    entry.status = "done";
    list.completedEntries = list.completedEntries || [];
    const copy = typeof entry.toObject === "function" ? entry.toObject() : JSON.parse(JSON.stringify(entry));
    list.completedEntries.push(copy);
    list.entries = list.entries.filter((e) => e.status !== "done");
  }

  // If client requested follow-up action on an existing FollowUp (reschedule / mark complete)
  const { followUpAction, followUpId, followUpNewScheduledAt } = req.body;
  if (followUpAction && followUpId) {
    try {
      if (!mongoose.Types.ObjectId.isValid(followUpId)) {
        // ignore invalid id
      } else {
        const fu = await FollowUp.findById(followUpId);
        if (fu) {
          // Ensure the phone or farmer matches the entry / request
          const reqPhone = String(phone).replace(/\D/g, "").slice(-10);
          if (String(fu.phone).slice(-10) === reqPhone || String(fu.farmerId) === String(entry.sourceId) || entry.source !== "farmer") {
            if (followUpAction === "reschedule" && followUpNewScheduledAt) {
              fu.scheduledAt = new Date(followUpNewScheduledAt);
              fu.status = "pending";
              fu.reminderSent = false;
            } else if (followUpAction === "complete") {
              fu.status = "completed";
              fu.completedAt = new Date();
            }
            await fu.save();
          }
        }
      }
    } catch (err) {
      console.error("Failed to apply followUpAction:", err);
    }
  }

  // Support scheduling a follow-up from public mobile: if followUpScheduledAt provided, create FollowUp
  const { followUpScheduledAt, followUpAssignTo, followUpNotes } = req.body;
  if (followUpScheduledAt) {
    try {
      // Determine farmerId: if source is farmer use sourceId, else try to resolve by phone
      let farmerId = null;
      if (entry.source === "farmer") farmerId = entry.sourceId;
      else {
        const possible = await Farmer.findOne({ mobileNumber: Number(String(phone).replace(/\D/g, "").slice(-10)) });
        if (possible) farmerId = possible._id;
      }

      const assignedBy = list.assignedTo || null;
      const assignedTo = followUpAssignTo && mongoose.Types.ObjectId.isValid(followUpAssignTo) ? followUpAssignTo : assignedBy;

      const fu = await FollowUp.create({
        farmerId: farmerId || null,
        phone: String(phone).replace(/\D/g, "").slice(-10),
        scheduledAt: new Date(followUpScheduledAt),
        notes: String(followUpNotes || remark || ""),
        source: "call-list-followup",
        assignedBy: assignedTo,
      });

      // Update farmer metadata if applicable
      if (farmerId) {
        const farmer = await Farmer.findById(farmerId);
        if (farmer) {
          farmer.lastFollowUpAt = fu.scheduledAt;
          farmer.followUpCount = (farmer.followUpCount || 0) + 1;
          await farmer.save();
        }
      }
      // Mark the call-list entry as done so it disappears from active entries
      if (entry && entry.status !== "done") {
        entry.status = "done";
        list.completedEntries = list.completedEntries || [];
        const copy2 = typeof entry.toObject === "function" ? entry.toObject() : JSON.parse(JSON.stringify(entry));
        list.completedEntries.push(copy2);
        list.entries = list.entries.filter((e) => e.status !== "done");
      }
    } catch (err) {
      console.error("Failed to create follow-up from public call-log:", err);
    }
  }

  await list.save();
  await syncTaskForCallAssignmentList(list);

  const updated = await CallAssignmentList.findById(id)
    .populate("assignedTo", "name phoneNumber")
    .lean();

  const allEntries = updated.entries || [];
  const pending = allEntries.filter((e) => e.status !== "done");
  const doneCount = allEntries.filter((e) => e.status === "done").length;

  return res.status(200).json(
    generateResponse("success", "Call log added", {
      list: {
        ...updated,
        entries: pending,
        total: allEntries.length,
        done: doneCount,
        pending: pending.length,
      },
    })
  );
});

/** GET /lists/progress - Employee progress summary */
export const getProgress = catchAsync(async (req, res, next) => {
  const isSuperAdmin = req.user?.role === "SUPER_ADMIN" || req.user?.jobTitle === "SUPER_ADMIN";
  const employeeId = isSuperAdmin ? req.query.employeeId : req.user._id;

  if (!employeeId) {
    return res.status(200).json(
      generateResponse("success", "Progress", {
        totalAssigned: 0,
        totalDone: 0,
        totalPending: 0,
        lists: [],
      })
    );
  }

  const lists = await CallAssignmentList.find({
    assignedTo: employeeId,
    isActive: true,
  })
    .select("name entries completedEntries createdAt")
    .lean();

  let totalAssigned = 0;
  let totalDone = 0;
  const listStats = lists.map((l) => {
    const stats = getListStats(l);
    totalAssigned += stats.total;
    totalDone += stats.done;
    return { _id: l._id, name: l.name, ...stats };
  });

  return res.status(200).json(
    generateResponse("success", "Progress fetched", {
      totalAssigned,
      totalDone,
      totalPending: totalAssigned - totalDone,
      lists: listStats,
    })
  );
});
