import mongoose from "mongoose";
import User from "../models/user.model.js";
import DealerWallet from "../models/dealerWallet.js";
import DealerLedgerEntry from "../models/dealerLedgerEntry.model.js";
import DealerCommissionRate from "../models/dealerCommissionRate.model.js";
import DealerCommissionSettlement from "../models/dealerCommissionSettlement.model.js";
import generateResponse from "../utility/responseFormat.js";
import catchAsync from "../utility/catchAsync.js";
import {
  buildDealerCommissionAnalysis,
  computeUnsettledCommission,
  syncCommissionRatesFromPlants,
  bulkDefaultCommissionRates,
} from "../services/dealerCommission.service.js";

const parsePeriodDates = (startDate, endDate) => {
  let periodStart = null;
  let periodEnd = null;
  if (startDate) {
    const start = new Date(startDate);
    if (!Number.isNaN(start.getTime())) periodStart = start;
  }
  if (endDate) {
    const end = new Date(endDate);
    if (!Number.isNaN(end.getTime())) {
      end.setHours(23, 59, 59, 999);
      periodEnd = end;
    }
  }
  return { periodStart, periodEnd };
};

const ensureDealer = async (dealerId) => {
  if (!mongoose.Types.ObjectId.isValid(dealerId)) {
    return { error: "Invalid dealer id" };
  }
  const dealer = await User.findById(dealerId).select("jobTitle role isDisabled name");
  if (!dealer || dealer.isDisabled) {
    return { error: "Dealer not found" };
  }
  const isDealer = dealer.jobTitle === "DEALER" || dealer.role === "DEALER";
  if (!isDealer) {
    return { error: "User is not a dealer" };
  }
  return { dealer };
};

export const getCommissionRates = catchAsync(async (req, res) => {
  const rates = await DealerCommissionRate.find({})
    .sort({ plantName: 1, subtypeName: 1 })
    .lean();
  return res.status(200).json(
    generateResponse("success", "Commission rates fetched", rates, null)
  );
});

export const patchCommissionRate = catchAsync(async (req, res) => {
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json(generateResponse("error", "Invalid rate id", null, null));
  }

  const ratePerPlant = Number(req.body?.ratePerPlant);
  if (!Number.isFinite(ratePerPlant) || ratePerPlant < 0) {
    return res
      .status(400)
      .json(generateResponse("error", "ratePerPlant must be a non-negative number", null, null));
  }

  const update = {
    ratePerPlant,
    updatedBy: req.user?._id,
  };
  if (typeof req.body?.isActive === "boolean") {
    update.isActive = req.body.isActive;
  }

  const updated = await DealerCommissionRate.findByIdAndUpdate(
    id,
    { $set: update },
    { new: true, runValidators: true }
  ).lean();

  if (!updated) {
    return res.status(404).json(generateResponse("error", "Commission rate not found", null, null));
  }

  return res.status(200).json(
    generateResponse("success", "Commission rate updated", updated, null)
  );
});

export const postSyncCommissionRates = catchAsync(async (req, res) => {
  const result = await syncCommissionRatesFromPlants(req.user?._id);
  return res.status(200).json(
    generateResponse("success", "Commission rates synced from plants", result, null)
  );
});

export const postBulkDefaultCommissionRates = catchAsync(async (req, res) => {
  const result = await bulkDefaultCommissionRates(req.user?._id);
  return res.status(200).json(
    generateResponse(
      "success",
      "Rates set to ₹1 (Papaya 15 NOA / 15 R15 unchanged)",
      result,
      null
    )
  );
});

export const getDealerCommissionAnalysis = catchAsync(async (req, res) => {
  const { dealerId } = req.params;
  const check = await ensureDealer(dealerId);
  if (check.error) {
    return res.status(check.error === "Invalid dealer id" ? 400 : 404).json(
      generateResponse("error", check.error, null, null)
    );
  }

  const { startDate, endDate } = req.query;
  const payload = await computeUnsettledCommission(dealerId, { startDate, endDate });

  return res.status(200).json(
    generateResponse("success", "Dealer commission analysis fetched", payload, null)
  );
});

export const getDealerCommissionSettlements = catchAsync(async (req, res) => {
  const { dealerId } = req.params;
  const check = await ensureDealer(dealerId);
  if (check.error) {
    return res.status(check.error === "Invalid dealer id" ? 400 : 404).json(
      generateResponse("error", check.error, null, null)
    );
  }

  const settlements = await DealerCommissionSettlement.find({ dealer: dealerId })
    .populate("createdBy", "name phoneNumber")
    .sort({ createdAt: -1 })
    .limit(100)
    .lean();

  return res.status(200).json(
    generateResponse("success", "Settlement history fetched", settlements, null)
  );
});

export const postSettleDealerCommission = catchAsync(async (req, res) => {
  const { dealerId } = req.params;
  const check = await ensureDealer(dealerId);
  if (check.error) {
    return res.status(check.error === "Invalid dealer id" ? 400 : 404).json(
      generateResponse("error", check.error, null, null)
    );
  }

  const { startDate, endDate, remark = "", modeOfPayment = "", transactionId = "", amount: amountRaw } =
    req.body || {};
  const { periodStart, periodEnd } = parsePeriodDates(startDate, endDate);

  const analysisPayload = await computeUnsettledCommission(dealerId, {
    startDate,
    endDate,
  });

  const unsettled = analysisPayload.unsettled;
  if (!Number.isFinite(unsettled) || unsettled <= 0) {
    return res.status(400).json(
      generateResponse(
        "error",
        unsettled <= 0
          ? "Nothing to settle. Net actual commission is zero or negative, or already fully settled."
          : "Invalid unsettled amount",
        {
          actualCommission: analysisPayload.summary.actualCommission,
          alreadySettled: analysisPayload.alreadySettled,
          unsettled,
        },
        null
      )
    );
  }

  const requestedAmount =
    amountRaw !== undefined && amountRaw !== null && amountRaw !== ""
      ? Number(amountRaw)
      : unsettled;

  if (!Number.isFinite(requestedAmount) || requestedAmount <= 0) {
    return res.status(400).json(
      generateResponse("error", "Settlement amount must be a positive number", null, null)
    );
  }

  if (requestedAmount > unsettled) {
    return res.status(400).json(
      generateResponse(
        "error",
        `Amount exceeds unsettled balance (max ${unsettled})`,
        { unsettled, requestedAmount },
        null
      )
    );
  }

  const settleAmount = requestedAmount;

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const metaParts = [];
    if (modeOfPayment) metaParts.push(`Mode: ${modeOfPayment}`);
    if (transactionId) metaParts.push(`Txn: ${transactionId}`);
    if (periodStart || periodEnd) {
      metaParts.push(
        `Period: ${periodStart ? periodStart.toISOString().slice(0, 10) : "—"} to ${
          periodEnd ? periodEnd.toISOString().slice(0, 10) : "—"
        }`
      );
    }
    const tail = remark?.trim() ? ` — ${remark.trim()}` : "";
    const partialNote =
      settleAmount < unsettled ? ` (partial: ₹${settleAmount} of ₹${unsettled} unsettled)` : "";
    const description = `Commission settlement${partialNote}${metaParts.length ? ` (${metaParts.join(", ")})` : ""}${tail}`;

    const metadata = {
      source: "COMMISSION_SETTLEMENT",
      modeOfPayment: modeOfPayment || undefined,
      transactionId: transactionId || undefined,
      periodStart: periodStart || undefined,
      periodEnd: periodEnd || undefined,
      remark: remark || undefined,
      requestedAmount: settleAmount,
      unsettledBefore: unsettled,
      isPartial: settleAmount < unsettled,
    };

    await DealerWallet.addPayment(
      dealerId,
      settleAmount,
      description,
      req.user?._id,
      "COMMISSION_SETTLEMENT",
      null,
      session,
      metadata
    );

    const ledgerEntry = await DealerLedgerEntry.findOne({ dealer: dealerId })
      .sort({ createdAt: -1 })
      .session(session)
      .lean();

    const wallet = await DealerWallet.findOne({ dealer: dealerId })
      .select("availableAmount")
      .session(session)
      .lean();

    const settlement = await DealerCommissionSettlement.create(
      [
        {
          dealer: dealerId,
          amount: settleAmount,
          settledAmount: settleAmount,
          periodStart,
          periodEnd,
          expectedCommission: analysisPayload.summary.expectedCommission,
          actualCommission: analysisPayload.summary.actualCommission,
          alreadySettled: analysisPayload.alreadySettled,
          breakdown: {
            byPlantType: analysisPayload.byPlantType,
            byVillage: analysisPayload.byVillage,
            orderCount: analysisPayload.orders?.length || 0,
          },
          ledgerEntryId: ledgerEntry?._id,
          walletBalanceAfter: wallet?.availableAmount ?? 0,
          createdBy: req.user?._id,
          remark,
          metadata,
        },
      ],
      { session }
    );

    await session.commitTransaction();

    return res.status(200).json(
      generateResponse("success", "Commission settled and wallet credited", {
        settlement: settlement[0],
        availableAmount: wallet?.availableAmount ?? 0,
        settledAmount: settleAmount,
        unsettledBefore: unsettled,
        unsettledAfter: unsettled - settleAmount,
      }, null)
    );
  } catch (err) {
    await session.abortTransaction();
    throw err;
  } finally {
    session.endSession();
  }
});
