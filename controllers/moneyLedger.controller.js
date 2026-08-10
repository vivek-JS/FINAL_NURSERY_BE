import catchAsync from "../utility/catchAsync.js";
import AppError from "../utility/appError.js";
import generateResponse from "../utility/responseFormat.js";
import {
  addDocumentPayment,
  runMoneyLedgerBackfill,
  postPartyAdjustment,
} from "../services/moneyLedger/index.js";

const SUPER_ROLES = new Set(["SuperAdmin", "SUPER_ADMIN", "Master", "MASTER", "Admin", "ADMIN"]);

function isSuperUser(user) {
  const roles = [].concat(user?.role || [], user?.roles || []).map((r) => String(r));
  if (roles.some((r) => SUPER_ROLES.has(r))) return true;
  const name = String(user?.roleName || user?.role?.name || "");
  return SUPER_ROLES.has(name);
}

export const listBooks = catchAsync(async (_req, res) => {
  return res.status(200).json(
    generateResponse("Success", "Money ledger books", {
      books: [
        {
          id: "RAM_AGRI",
          label: "Ram Agri Input",
          sides: ["ALL"],
          description:
            "Ram Agri single debit/credit ledger (B2B sell, purchase, returns, payments, discount)",
        },
        {
          id: "BIOTECH",
          label: "Biotech Master",
          sides: ["ALL"],
          description:
            "Biotech plant inventory single debit/credit ledger (sell orders, GRN purchase, payments)",
        },
      ],
    })
  );
});

export const listParties = catchAsync(async (req, res, next) => {
  const book = String(req.query.book || "RAM_AGRI").toUpperCase();
  const q = req.query.q || "";
  const limit = req.query.limit;
  const partyKind = String(req.query.partyKind || "ALL").toUpperCase();

  if (!["BIOTECH", "RAM_AGRI"].includes(book)) {
    return next(new AppError("Invalid book", 400));
  }

  // Always unified per book — never AR/AP split (no "Invalid side")
  const { listUnifiedBookParties } = await import("../services/moneyLedger/unifiedPartyLedger.js");
  const parties = await listUnifiedBookParties({ book, partyKind, q, limit });
  return res
    .status(200)
    .json(generateResponse("Success", "Parties", { parties, book, side: "ALL" }));
});

export const getPartyStatement = catchAsync(async (req, res, next) => {
  const book = String(req.query.book || "RAM_AGRI").toUpperCase();
  const partyType = String(req.params.partyType || "").toUpperCase();
  const partyId = req.params.partyId;
  const { limit } = req.query;

  if (!["BIOTECH", "RAM_AGRI"].includes(book)) {
    return next(new AppError("Invalid book", 400));
  }
  if (!partyType || !partyId) return next(new AppError("partyType and partyId required", 400));

  const { getUnifiedBookPartyStatement } = await import(
    "../services/moneyLedger/unifiedPartyLedger.js"
  );
  const result = await getUnifiedBookPartyStatement(book, partyType, partyId, { limit });
  if (result.ok === false) {
    return next(new AppError(result.error || "Failed", result.status || 400));
  }
  return res.status(200).json(
    generateResponse("Success", "Statement", {
      party: result.party,
      entries: result.entries,
      totals: result.totals,
    })
  );
});

export const addPayment = catchAsync(async (req, res, next) => {
  const userId = req.user?._id || req.user?.id;
  if (!userId) return next(new AppError("Authentication required", 401));

  const {
    documentType,
    documentId,
    amount,
    modeOfPayment,
    paymentDate,
    paymentStatus,
    book,
    remark,
    bankName,
    transactionId,
    chequeNumber,
    upiId,
    // Party-scoped (no document)
    partyType,
    partyId,
    kind,
    direction,
    entryDate,
  } = req.body || {};

  // Party payment / discount without PO or order
  if (partyType && partyId && !documentId) {
    const result = await postPartyAdjustment({
      book: book || "RAM_AGRI",
      partyType,
      partyId,
      amount,
      kind: kind || "PAYMENT",
      direction: direction || "AUTO",
      entryDate: entryDate || paymentDate,
      modeOfPayment,
      remark,
      userId,
    });
    if (!result.ok) {
      return next(new AppError(result.error || "Party adjustment failed", result.status || 400));
    }
    return res.status(201).json(
      generateResponse(
        "Success",
        String(kind || "PAYMENT").toUpperCase() === "DISCOUNT"
          ? "Discount recorded"
          : "Payment recorded",
        result.data
      )
    );
  }

  if (!documentType || !documentId) {
    return next(
      new AppError("documentType+documentId or partyType+partyId are required", 400)
    );
  }

  const result = await addDocumentPayment({
    documentType,
    documentId,
    amount,
    modeOfPayment,
    paymentDate,
    paymentStatus,
    book,
    remark,
    bankName,
    transactionId,
    chequeNumber,
    upiId,
    userId,
  });

  if (!result.ok) return next(new AppError(result.error || "Payment failed", result.status || 400));
  return res.status(201).json(generateResponse("Success", "Payment recorded", result.data));
});

/** Explicit party discount endpoint (same engine, kind=DISCOUNT). */
export const addPartyDiscount = catchAsync(async (req, res, next) => {
  const userId = req.user?._id || req.user?.id;
  if (!userId) return next(new AppError("Authentication required", 401));
  const { partyType, partyId, amount, entryDate, remark, book, direction } = req.body || {};
  if (!partyType || !partyId) {
    return next(new AppError("partyType and partyId are required", 400));
  }
  const result = await postPartyAdjustment({
    book: book || "RAM_AGRI",
    partyType,
    partyId,
    amount,
    kind: "DISCOUNT",
    direction: direction || "AUTO",
    entryDate,
    remark,
    userId,
  });
  if (!result.ok) {
    return next(new AppError(result.error || "Discount failed", result.status || 400));
  }
  return res.status(201).json(generateResponse("Success", "Discount recorded", result.data));
});

export const addDocumentScopedPayment = catchAsync(async (req, res, next) => {
  const userId = req.user?._id || req.user?.id;
  if (!userId) return next(new AppError("Authentication required", 401));
  const { type, id } = req.params;
  const result = await addDocumentPayment({
    documentType: type,
    documentId: id,
    ...req.body,
    userId,
  });
  if (!result.ok) return next(new AppError(result.error || "Payment failed", result.status || 400));
  return res.status(201).json(generateResponse("Success", "Payment recorded", result.data));
});

export const runBackfill = catchAsync(async (req, res, next) => {
  if (!isSuperUser(req.user)) {
    return next(new AppError("Only SuperAdmin / Master can run ledger backfill", 403));
  }
  const dryRun = req.body?.dryRun === true || req.query?.dryRun === "true";
  const limit = Number(req.body?.limit || req.query?.limit || 0);
  const result = await runMoneyLedgerBackfill({ dryRun, limit });
  return res.status(200).json(generateResponse("Success", "Backfill completed", result));
});
