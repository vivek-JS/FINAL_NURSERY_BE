import FollowUp from "../models/followUp.model.js";
import User from "../models/user.model.js";
import generateResponse from "../utility/responseFormat.js";
import catchAsync from "../utility/catchAsync.js";
import mongoose from "mongoose";

export const getEmployeeMetrics = catchAsync(async (req, res) => {
  // aggregate follow-ups by assignedBy
  const pipeline = [
    { $match: { assignedBy: { $exists: true, $ne: null } } },
    {
      $group: {
        _id: "$assignedBy",
        totalAssigned: { $sum: 1 },
        completed: { $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] } },
        pending: { $sum: { $cond: [{ $eq: ["$status", "pending"] }, 1, 0] } },
        avgCompletionMs: { $avg: { $cond: [{ $and: [{ $eq: ["$status", "completed"] }, { $ifNull: ["$completedAt", false] }] }, { $subtract: ["$completedAt", "$createdAt"] }, null] } },
      },
    },
  ];

  const results = await FollowUp.aggregate(pipeline);
  const userIds = results.map((r) => mongoose.Types.ObjectId(r._id));
  const users = await User.find({ _id: { $in: userIds } }).select("name _id expoPushToken phoneNumber").lean();
  const userMap = new Map(users.map((u) => [String(u._id), u]));

  const metrics = results.map((r) => {
    const u = userMap.get(String(r._id)) || null;
    return {
      employeeId: r._id,
      name: u?.name || "Unknown",
      phoneNumber: u?.phoneNumber || null,
      totalAssigned: r.totalAssigned,
      completed: r.completed,
      pending: r.pending,
      completionRate: r.totalAssigned ? Math.round((r.completed / r.totalAssigned) * 100) : 0,
      avgCompletionMinutes: r.avgCompletionMs ? Math.round(r.avgCompletionMs / 60000) : null,
    };
  });

  return res.status(200).json(generateResponse("success", "Employee follow-up metrics", { metrics }));
});

