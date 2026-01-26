import catchAsync from "../utility/catchAsync.js";
import generateResponse from "../utility/responseFormat.js";
import RamAgriInputsProduct from "../models/ramAgriInputsProduct.model.js";
import AgriSalesOrder from "../models/agriSalesOrder.model.js";
import RamAgriSalesTarget from "../models/ramAgriSalesTarget.model.js";
import User from "../models/user.model.js";

const buildRangeKey = (startDate, endDate) => {
  const startKey = new Date(startDate).toISOString().slice(0, 10);
  const endKey = new Date(endDate).toISOString().slice(0, 10);
  return `${startKey}_${endKey}`;
};

export const getRamAgriSalesRankboard = catchAsync(async (req, res, next) => {
  const { startDate, endDate } = req.query;

  const dateFilter = {};
  if (startDate && endDate) {
    dateFilter.orderDate = {
      $gte: new Date(startDate),
      $lte: new Date(endDate + "T23:59:59.999Z"),
    };
  } else if (startDate) {
    dateFilter.orderDate = { $gte: new Date(startDate) };
  } else if (endDate) {
    dateFilter.orderDate = { $lte: new Date(endDate + "T23:59:59.999Z") };
  }

  const cropTypeMap = new Map(
    (await RamAgriInputsProduct.find({}, { _id: 1, productType: 1 }).lean()).map(
      (crop) => [crop._id.toString(), crop.productType || "seed"]
    )
  );

  const orders = await AgriSalesOrder.find({
    orderStatus: { $nin: ["CANCELLED", "REJECTED"] },
    ...(Object.keys(dateFilter).length > 0 ? dateFilter : {}),
    $or: [{ isRamAgriProduct: true }, { ramAgriCropId: { $ne: null } }],
  }).lean();

  const userStats = new Map();
  const categoryStats = {
    seed: new Map(),
    chemical: new Map(),
  };

  orders.forEach((order) => {
    const createdById = order.createdBy?._id || order.createdBy;
    if (!createdById) return;
    const userId = createdById.toString();
    const stat = userStats.get(userId) || {
      userId,
      revenue: 0,
      quantity: 0,
      orderCount: 0,
      customers: new Set(),
      categories: { seed: 0, chemical: 0 },
    };

    const revenue = order.totalAmount || 0;
    const quantity = order.quantity || 0;
    const cropId = order.ramAgriCropId?.toString();
    const productType = cropId ? cropTypeMap.get(cropId) || "seed" : "seed";

    stat.revenue += revenue;
    stat.quantity += quantity;
    stat.orderCount += 1;
    if (order.customerMobile) {
      stat.customers.add(order.customerMobile);
    }
    stat.categories[productType] += revenue;

    userStats.set(userId, stat);

    const categoryMap = categoryStats[productType] || categoryStats.seed;
    categoryMap.set(userId, (categoryMap.get(userId) || 0) + revenue);
  });

  const userIds = Array.from(userStats.keys());
  const users = await User.find({ _id: { $in: userIds } })
    .select("name phoneNumber jobTitle")
    .lean();
  const userMap = new Map(users.map((user) => [user._id.toString(), user]));

  let targets = [];
  if (startDate && endDate) {
    const rangeKey = buildRangeKey(startDate, endDate);
    targets = await RamAgriSalesTarget.find({ rangeKey }).lean();
  }

  const targetAmountMap = new Map();
  targets.forEach((target) => {
    const key = target.userId.toString();
    targetAmountMap.set(key, (targetAmountMap.get(key) || 0) + (target.targetAmount || 0));
  });

  if (targetAmountMap.size === 0 && userIds.length > 0) {
    const fallbackTargets = await RamAgriSalesTarget.find({
      userId: { $in: userIds },
    })
      .sort({ updatedAt: -1 })
      .lean();

    const latestRangeByUser = new Map();
    fallbackTargets.forEach((target) => {
      const key = target.userId.toString();
      if (!latestRangeByUser.has(key)) {
        latestRangeByUser.set(key, target.rangeKey);
      }
    });

    fallbackTargets.forEach((target) => {
      const key = target.userId.toString();
      if (latestRangeByUser.get(key) !== target.rangeKey) return;
      targetAmountMap.set(key, (targetAmountMap.get(key) || 0) + (target.targetAmount || 0));
    });
  }

  const entries = Array.from(userStats.values()).map((stat) => {
    const targetAmount = targetAmountMap.get(stat.userId) || 0;
    const targetAchievement = targetAmount > 0 ? (stat.revenue / targetAmount) * 100 : 0;
    const uniqueCustomers = stat.customers.size;

    return {
      userId: stat.userId,
      user: userMap.get(stat.userId) || null,
      revenue: stat.revenue,
      quantity: stat.quantity,
      orderCount: stat.orderCount,
      uniqueCustomers,
      targetAmount,
      targetAchievement,
      categoryRevenue: stat.categories,
    };
  });

  const maxRevenue = Math.max(...entries.map((e) => e.revenue), 0);
  const maxQuantity = Math.max(...entries.map((e) => e.quantity), 0);
  const maxCustomers = Math.max(...entries.map((e) => e.uniqueCustomers), 0);
  const maxOrders = Math.max(...entries.map((e) => e.orderCount), 0);
  const maxTargetAchievement = Math.max(...entries.map((e) => e.targetAchievement), 0);

  const categoryRanks = {};
  ["seed", "chemical"].forEach((category) => {
    const categoryList = Array.from(categoryStats[category].entries())
      .sort((a, b) => b[1] - a[1])
      .map(([userId], index) => ({ userId, rank: index + 1 }));
    categoryRanks[category] = new Map(categoryList.map((item) => [item.userId, item.rank]));
  });

  const scoredEntries = entries.map((entry) => {
    const revenueNorm = maxRevenue > 0 ? entry.revenue / maxRevenue : 0;
    const quantityNorm = maxQuantity > 0 ? entry.quantity / maxQuantity : 0;
    const customerNorm = maxCustomers > 0 ? entry.uniqueCustomers / maxCustomers : 0;
    const orderNorm = maxOrders > 0 ? entry.orderCount / maxOrders : 0;
    const targetAchievementNorm = entry.targetAchievement > 0
      ? Math.min(entry.targetAchievement / 100, 1)
      : 0;

    const weightedScore =
      entry.revenue * 0.4 +
      entry.quantity * 0.3 +
      entry.uniqueCustomers * 0.2 +
      entry.orderCount * 0.1;

    const normalizedScore = (revenueNorm + quantityNorm) / 2;

    const categoryRankList = ["seed", "chemical"]
      .map((category) => categoryRanks[category].get(entry.userId))
      .filter((rank) => Number.isFinite(rank));
    const avgCategoryRank =
      categoryRankList.length > 0
        ? categoryRankList.reduce((sum, rank) => sum + rank, 0) / categoryRankList.length
        : null;
    const maxRank = Math.max(categoryRankList.length, entries.length, 1);
    const categoryScore =
      avgCategoryRank && maxRank > 1 ? 1 - (avgCategoryRank - 1) / (maxRank - 1) : 0;

    const unitEquivalentScore = entry.revenue / 1000;

    const recommendedScore =
      revenueNorm * 0.35 +
      quantityNorm * 0.25 +
      targetAchievementNorm * 0.25 +
      customerNorm * 0.15;

    return {
      ...entry,
      scores: {
        weightedScore,
        normalizedScore,
        categoryScore,
        targetAchievementScore: entry.targetAchievement,
        unitEquivalentScore,
        recommendedScore,
      },
      normalized: {
        revenue: revenueNorm,
        quantity: quantityNorm,
        customers: customerNorm,
        orders: orderNorm,
        targetAchievement: targetAchievementNorm,
      },
      categoryRanks: {
        seed: categoryRanks.seed.get(entry.userId) || null,
        chemical: categoryRanks.chemical.get(entry.userId) || null,
      },
    };
  });

  scoredEntries.sort((a, b) => b.scores.recommendedScore - a.scores.recommendedScore);

  const response = generateResponse(
    "Success",
    "Ram Agri sales rankboard fetched successfully",
    {
      range: { startDate, endDate },
      entries: scoredEntries,
      totals: {
        maxRevenue,
        maxQuantity,
        maxCustomers,
        maxOrders,
        maxTargetAchievement,
      },
    },
    undefined
  );

  return res.status(200).json(response);
});
