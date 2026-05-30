import mongoose from "mongoose";
import catchAsync from "../utility/catchAsync.js";
import generateResponse from "../utility/responseFormat.js";
import RewardProgram, {
  REWARD_AUDIENCE_ROLES,
  REWARD_THEMES,
  REWARD_IMAGE_KEYS,
  REWARD_PROGRESS_METRICS,
} from "../models/rewardProgram.model.js";
import RewardProgress from "../models/rewardProgress.model.js";
import User from "../models/user.model.js";
import {
  listAllPrograms,
  serializeProgram,
  serializeMilestone,
  getActiveProgramsForUser,
  refreshProgressForUser,
  ensureProgressRow,
  getEffectivePoints,
  userMatchesProgram,
} from "../services/rewards.service.js";

const parseProgramBody = (body) => {
  const update = {};
  if (body.name != null) update.name = String(body.name).trim();
  if (body.audienceLabel != null) update.audienceLabel = String(body.audienceLabel).trim();
  if (body.audience != null && body.audienceLabel == null) {
    update.audienceLabel = String(body.audience).trim();
  }
  if (Array.isArray(body.targetRoles)) {
    update.targetRoles = body.targetRoles.filter((r) => REWARD_AUDIENCE_ROLES.includes(r));
  }
  if (body.theme && REWARD_THEMES.includes(body.theme)) update.theme = body.theme;
  if (body.unit != null) update.unit = String(body.unit).trim();
  if (body.progressMetric && REWARD_PROGRESS_METRICS.includes(body.progressMetric)) {
    update.progressMetric = body.progressMetric;
  }
  if (typeof body.isActive === "boolean") update.isActive = body.isActive;
  if (body.periodStart !== undefined) {
    update.periodStart = body.periodStart ? new Date(body.periodStart) : null;
  }
  if (body.periodEnd !== undefined) {
    update.periodEnd = body.periodEnd ? new Date(body.periodEnd) : null;
  }
  if (Array.isArray(body.milestones)) {
    update.milestones = body.milestones.map((m) => ({
      title: String(m.title || "").trim(),
      description: String(m.description || "").trim(),
      target: Number(m.target) || 0,
      reward: String(m.reward || "").trim(),
      imageKey: REWARD_IMAGE_KEYS.includes(m.imageKey) ? m.imageKey : "medal",
      ...(m.id && mongoose.Types.ObjectId.isValid(m.id) ? { _id: m.id } : {}),
    }));
  }
  return update;
};

export const getRewardMeta = catchAsync(async (_req, res) => {
  return res.status(200).json(
    generateResponse(
      "success",
      "Reward metadata",
      {
        audienceRoles: REWARD_AUDIENCE_ROLES,
        themes: REWARD_THEMES,
        imageKeys: REWARD_IMAGE_KEYS,
        progressMetrics: REWARD_PROGRESS_METRICS,
      },
      null
    )
  );
});

export const listPrograms = catchAsync(async (_req, res) => {
  const programs = await listAllPrograms();
  return res.status(200).json(generateResponse("success", "Programs fetched", programs, null));
});

export const createProgram = catchAsync(async (req, res) => {
  const data = parseProgramBody(req.body);
  if (!data.name) {
    return res.status(400).json(generateResponse("error", "Program name is required", null, null));
  }
  if (!data.targetRoles?.length) {
    return res.status(400).json(generateResponse("error", "Select at least one audience role", null, null));
  }
  const program = await RewardProgram.create({
    ...data,
    createdBy: req.user._id,
    updatedBy: req.user._id,
  });
  return res
    .status(201)
    .json(generateResponse("success", "Program created", serializeProgram(program.toObject()), null));
});

export const updateProgram = catchAsync(async (req, res) => {
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json(generateResponse("error", "Invalid program id", null, null));
  }
  const data = parseProgramBody(req.body);
  data.updatedBy = req.user._id;
  const program = await RewardProgram.findByIdAndUpdate(id, data, { new: true, runValidators: true });
  if (!program) {
    return res.status(404).json(generateResponse("error", "Program not found", null, null));
  }
  return res
    .status(200)
    .json(generateResponse("success", "Program updated", serializeProgram(program.toObject()), null));
});

export const deleteProgram = catchAsync(async (req, res) => {
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json(generateResponse("error", "Invalid program id", null, null));
  }
  const program = await RewardProgram.findByIdAndDelete(id);
  if (!program) {
    return res.status(404).json(generateResponse("error", "Program not found", null, null));
  }
  await RewardProgress.deleteMany({ program: id });
  return res.status(200).json(generateResponse("success", "Program deleted", { id }, null));
});

export const getProgramParticipants = catchAsync(async (req, res) => {
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json(generateResponse("error", "Invalid program id", null, null));
  }
  const program = await RewardProgram.findById(id).lean();
  if (!program) {
    return res.status(404).json(generateResponse("error", "Program not found", null, null));
  }

  const roles = program.targetRoles || [];
  const users = await User.find({
    isDisabled: { $ne: true },
    $or: [{ jobTitle: { $in: roles } }, { role: { $in: roles } }],
  })
    .select("name phoneNumber jobTitle role")
    .lean();

  const rows = [];
  for (const user of users) {
    const progress = await refreshProgressForUser(user, program, req.user._id);
    rows.push({
      userId: String(user._id),
      name: user.name,
      phoneNumber: user.phoneNumber,
      jobTitle: user.jobTitle,
      role: user.role,
      points: getEffectivePoints(progress),
      computedPoints: progress.computedPoints || 0,
      manualAdjustment: progress.manualAdjustment || 0,
      progressId: String(progress._id),
    });
  }

  return res.status(200).json(
    generateResponse(
      "success",
      "Participants fetched",
      { program: serializeProgram(program), participants: rows },
      null
    )
  );
});

export const patchUserProgress = catchAsync(async (req, res) => {
  const { programId, userId } = req.params;
  if (!mongoose.Types.ObjectId.isValid(programId) || !mongoose.Types.ObjectId.isValid(userId)) {
    return res.status(400).json(generateResponse("error", "Invalid id", null, null));
  }
  const program = await RewardProgram.findById(programId).lean();
  if (!program) {
    return res.status(404).json(generateResponse("error", "Program not found", null, null));
  }
  const user = await User.findById(userId).select("name jobTitle role isDisabled").lean();
  if (!user || user.isDisabled) {
    return res.status(404).json(generateResponse("error", "User not found", null, null));
  }

  const row = await ensureProgressRow(programId, userId);
  if (req.body.manualAdjustment !== undefined) {
    row.manualAdjustment = Number(req.body.manualAdjustment) || 0;
  }
  if (req.body.notes !== undefined) row.notes = String(req.body.notes || "");
  row.updatedBy = req.user._id;

  if (program.progressMetric !== "manual") {
    const computed = await refreshProgressForUser(user, program, req.user._id);
    row.computedPoints = computed.computedPoints;
  }
  await row.save();

  return res.status(200).json(
    generateResponse(
      "success",
      "Progress updated",
      {
        userId,
        programId,
        points: getEffectivePoints(row),
        computedPoints: row.computedPoints,
        manualAdjustment: row.manualAdjustment,
      },
      null
    )
  );
});

export const refreshProgramProgress = catchAsync(async (req, res) => {
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json(generateResponse("error", "Invalid program id", null, null));
  }
  const program = await RewardProgram.findById(id).lean();
  if (!program) {
    return res.status(404).json(generateResponse("error", "Program not found", null, null));
  }
  const roles = program.targetRoles || [];
  const users = await User.find({
    isDisabled: { $ne: true },
    $or: [{ jobTitle: { $in: roles } }, { role: { $in: roles } }],
  }).lean();

  for (const user of users) {
    await refreshProgressForUser(user, program, req.user._id);
  }

  return res.status(200).json(
    generateResponse("success", "Progress refreshed for all participants", { count: users.length }, null)
  );
});

export const getMyPrograms = catchAsync(async (req, res) => {
  const programs = await getActiveProgramsForUser(req.user);
  return res.status(200).json(generateResponse("success", "Your reward programs", programs, null));
});

export const getMyProgramById = catchAsync(async (req, res) => {
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json(generateResponse("error", "Invalid program id", null, null));
  }
  const program = await RewardProgram.findOne({ _id: id, isActive: true }).lean();
  if (!program) {
    return res.status(404).json(generateResponse("error", "Program not found", null, null));
  }
  if (!userMatchesProgram(req.user, program)) {
    return res.status(403).json(generateResponse("error", "Program not available for your role", null, null));
  }
  const progress = await refreshProgressForUser(req.user, program);
  return res.status(200).json(
    generateResponse(
      "success",
      "Program fetched",
      serializeProgram(program, {
        points: getEffectivePoints(progress),
        computedPoints: progress.computedPoints || 0,
        manualAdjustment: progress.manualAdjustment || 0,
      }),
      null
    )
  );
});
