import mongoose from "mongoose";
import Order from "../models/order.model.js";
import RewardProgram from "../models/rewardProgram.model.js";
import RewardProgress from "../models/rewardProgress.model.js";

export const REWARD_IMAGE_URLS = {
  trophy: "/rewards/milestone-trophy.jpg",
  star: "/rewards/milestone-star.jpg",
  medal: "/rewards/milestone-medal.jpg",
  rocket: "/rewards/milestone-rocket.jpg",
};

const userRoleKey = (user) => user?.jobTitle || user?.role || "";

export const userMatchesProgram = (user, program) => {
  const key = userRoleKey(user);
  if (!key || !program?.targetRoles?.length) return false;
  return program.targetRoles.includes(key);
};

const buildOrderMatchForUser = (userId, role, program) => {
  const uid = new mongoose.Types.ObjectId(userId);
  const base = {
    orderStatus: { $nin: ["CANCELLED", "TEMPORARY_CANCELLED"] },
  };

  if (program.periodStart || program.periodEnd) {
    base.orderBookingDate = {};
    if (program.periodStart) base.orderBookingDate.$gte = program.periodStart;
    if (program.periodEnd) base.orderBookingDate.$lte = program.periodEnd;
  }

  if (role === "DEALER" || role === "AGRI_INPUT_DEALER") {
    return { ...base, $or: [{ dealer: uid }, { salesPerson: uid, dealerOrder: true }] };
  }

  return { ...base, salesPerson: uid };
};

export const computePointsFromOrders = async (user, program) => {
  const match = buildOrderMatchForUser(user._id, userRoleKey(user), program);
  const metric = program.progressMetric || "order_count";

  if (metric === "manual") {
    return 0;
  }

  if (metric === "order_count") {
    return Order.countDocuments(match);
  }

  if (metric === "plants_sold") {
    const rows = await Order.aggregate([
      { $match: match },
      {
        $group: {
          _id: null,
          total: {
            $sum: {
              $ifNull: ["$numberOfPlants", { $ifNull: ["$totalPlants", 0] }],
            },
          },
        },
      },
    ]);
    return rows[0]?.total ?? 0;
  }

  if (metric === "order_value") {
    const rows = await Order.aggregate([
      { $match: match },
      {
        $group: {
          _id: null,
          total: {
            $sum: {
              $multiply: [
                { $ifNull: ["$rate", 0] },
                {
                  $add: [
                    { $ifNull: ["$numberOfPlants", 0] },
                    { $ifNull: ["$additionalPlants", 0] },
                  ],
                },
              ],
            },
          },
        },
      },
    ]);
    return Math.round(rows[0]?.total ?? 0);
  }

  return 0;
};

export const getEffectivePoints = (progressRow) => {
  const computed = Number(progressRow?.computedPoints) || 0;
  const manual = Number(progressRow?.manualAdjustment) || 0;
  return Math.max(0, computed + manual);
};

export const serializeMilestone = (m) => ({
  id: String(m._id),
  title: m.title,
  description: m.description || "",
  target: m.target,
  reward: m.reward || "",
  imageKey: m.imageKey || "medal",
  image: REWARD_IMAGE_URLS[m.imageKey] || REWARD_IMAGE_URLS.medal,
});

export const serializeProgram = (program, extras = {}) => ({
  id: String(program._id),
  name: program.name,
  audience: program.audienceLabel || program.targetRoles?.join(", ") || "",
  audienceLabel: program.audienceLabel || "",
  targetRoles: program.targetRoles || [],
  theme: program.theme || "joy",
  unit: program.unit || "points",
  progressMetric: program.progressMetric || "order_count",
  periodStart: program.periodStart,
  periodEnd: program.periodEnd,
  isActive: program.isActive !== false,
  milestones: (program.milestones || []).map(serializeMilestone),
  ...extras,
});

export const ensureProgressRow = async (programId, userId) => {
  let row = await RewardProgress.findOne({ program: programId, user: userId });
  if (!row) {
    row = await RewardProgress.create({ program: programId, user: userId });
  }
  return row;
};

export const refreshProgressForUser = async (user, program, updatedBy = null) => {
  const row = await ensureProgressRow(program._id, user._id);
  if (program.progressMetric === "manual") {
    row.lastComputedAt = new Date();
    if (updatedBy) row.updatedBy = updatedBy;
    await row.save();
    return row;
  }
  const computed = await computePointsFromOrders(user, program);
  row.computedPoints = computed;
  row.lastComputedAt = new Date();
  if (updatedBy) row.updatedBy = updatedBy;
  await row.save();
  return row;
};

export const getActiveProgramsForUser = async (user) => {
  const role = userRoleKey(user);
  const programs = await RewardProgram.find({
    isActive: true,
    targetRoles: role,
  })
    .sort({ updatedAt: -1 })
    .lean();

  const result = [];
  for (const program of programs) {
    const progress = await refreshProgressForUser(user, program);
    result.push(
      serializeProgram(program, {
        points: getEffectivePoints(progress),
        progressId: String(progress._id),
        manualAdjustment: progress.manualAdjustment || 0,
        computedPoints: progress.computedPoints || 0,
      })
    );
  }
  return result;
};

export const listAllPrograms = async () => {
  const programs = await RewardProgram.find({}).sort({ updatedAt: -1 }).lean();
  return programs.map((p) => serializeProgram(p));
};
