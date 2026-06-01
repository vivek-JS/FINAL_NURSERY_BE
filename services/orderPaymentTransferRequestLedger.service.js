/**
 * Farmer plant + dealer + central reference ledgers for approved transfer requests
 * (including same-dealer / dealer-scoped pairs that previously skipped farmer ledger).
 */
import mongoose from "mongoose";
import {
  shouldLogFarmerPlantLedger,
  ensureFarmerPlantOrderDebit,
  createFarmerPlantLedgerEntry,
  recordFarmerPlantLedgerPaymentTransition,
  resolveFarmerIdentity,
  resolveFundingDealerId,
  roundMoney,
  parseTransferRequestDeductionFromRemark,
} from "../utils/farmerPlantOrderLedgerHelper.js";
import {
  createDealerLedgerEntry,
  ensureDealerOrderBookingAudit,
  ensureDealerOrderReceivablePaymentCredit,
  findDealerOrderReceivablePaymentEntry,
  getLastDealerOrderOutstanding,
  roundLedgerMoney,
  syncDealerLedgerForPaymentStatusTransition,
} from "../utils/dealerLedgerHelper.js";

function requestMeta(transferRequestId, direction, peerOrderMongoId, peerOrderNumber) {
  return {
    kind: "order_payment_transfer_request",
    transferRequestId: transferRequestId ? String(transferRequestId) : undefined,
    direction,
    peerOrderMongoId: peerOrderMongoId ? String(peerOrderMongoId) : undefined,
    peerOrderNumber: peerOrderNumber != null ? String(peerOrderNumber) : undefined,
  };
}

function requestUndoMeta(transferRequestId, direction, peerOrderMongoId, peerOrderNumber) {
  return {
    kind: "order_payment_transfer_request_undo",
    transferRequestId: transferRequestId ? String(transferRequestId) : undefined,
    direction,
    peerOrderMongoId: peerOrderMongoId ? String(peerOrderMongoId) : undefined,
    peerOrderNumber: peerOrderNumber != null ? String(peerOrderNumber) : undefined,
  };
}

async function shadowTransferRequestPair({ transferRequestId, amount, sourceOrder, targetOrder, userId }) {
  const results = [];
  try {
    const fs = await import("../modules/finance/integration/financeShadow.js");
    const amt = roundMoney(amount);
    const tid = transferRequestId ? String(transferRequestId) : null;
    if (!(amt > 0) || !tid) return results;

    const sourceParty = await resolveFarmerIdentity(sourceOrder);
    const targetParty = await resolveFarmerIdentity(targetOrder);

    if (sourceParty.customerMobile) {
      fs.shadowFarmerPaymentTransfer({
        requestId: tid,
        direction: "REVERSAL",
        amount: amt,
        customerMobile: sourceParty.customerMobile,
        userId,
      });
      results.push({ party: "source", direction: "REVERSAL" });
    }
    if (targetParty.customerMobile) {
      fs.shadowFarmerPaymentTransfer({
        requestId: `${tid}:in`,
        direction: "CREDIT",
        amount: amt,
        customerMobile: targetParty.customerMobile,
        userId,
      });
      results.push({ party: "target", direction: "CREDIT" });
    }
  } catch (err) {
    console.error("[Finance] shadow transfer request:", err?.message || err);
  }
  return results;
}

async function shadowTransferRequestUndoPair({
  transferRequestId,
  amount,
  sourceOrder,
  targetOrder,
  userId,
  prevTargetStatus,
}) {
  const results = [];
  try {
    const fs = await import("../modules/finance/integration/financeShadow.js");
    const amt = roundMoney(amount);
    const tid = transferRequestId ? String(transferRequestId) : null;
    if (!(amt > 0) || !tid) return results;

    const sourceParty = await resolveFarmerIdentity(sourceOrder);
    const targetParty = await resolveFarmerIdentity(targetOrder);

    if (sourceParty.customerMobile) {
      fs.shadowFarmerPaymentTransfer({
        requestId: tid,
        direction: "CREDIT",
        amount: amt,
        customerMobile: sourceParty.customerMobile,
        userId,
      });
      results.push({ party: "source", direction: "CREDIT" });
    }
    if (targetParty.customerMobile && prevTargetStatus === "COLLECTED") {
      fs.shadowFarmerPaymentTransfer({
        requestId: `${tid}:undo`,
        direction: "REVERSAL",
        amount: amt,
        customerMobile: targetParty.customerMobile,
        userId,
      });
      results.push({ party: "target", direction: "REVERSAL" });
    }
  } catch (err) {
    console.error("[Finance] shadow transfer request undo:", err?.message || err);
  }
  return results;
}

/** First source payment line that received a deduction for this transfer request. */
export function findPrimarySourcePaymentForTransferRequest(sourceOrder, transferRequestId) {
  const rid = String(transferRequestId || "");
  let best = null;
  let bestDeduct = 0;
  for (const p of sourceOrder?.payment || []) {
    const deduct = parseTransferRequestDeductionFromRemark(p?.remark, rid);
    if (deduct > bestDeduct) {
      bestDeduct = deduct;
      best = p;
    }
  }
  if (best) return best;
  return (sourceOrder?.payment || []).find(
    (p) =>
      p &&
      p.paymentStatus === "COLLECTED" &&
      !p.isWalletPayment &&
      !p.mainPaymentId &&
      Number(p.paidAmount || 0) > 0
  );
}

export async function syncDealerTransferRequestApproveReference(
  { sourceOrder, targetOrder, targetPayment, amount, transferRequestId, userId },
  { session } = {}
) {
  const dealerId = await resolveFundingDealerId(sourceOrder);
  const targetDealer = await resolveFundingDealerId(targetOrder);
  if (!dealerId || !targetDealer || String(dealerId) !== String(targetDealer)) {
    return { source: { action: "SKIP" }, target: { action: "SKIP" } };
  }

  const amt = roundLedgerMoney(amount);
  if (!(amt > 0)) return { source: { action: "NONE" }, target: { action: "NONE" } };

  const sourceNum = sourceOrder.orderId ?? "";
  const targetNum = targetOrder.orderId ?? "";
  const metaBase = requestMeta(transferRequestId, null, null, null);
  const reqOid =
    transferRequestId instanceof mongoose.Types.ObjectId
      ? transferRequestId
      : new mongoose.Types.ObjectId(String(transferRequestId));

  await ensureDealerOrderBookingAudit(sourceOrder, { userId, session });
  await ensureDealerOrderBookingAudit(targetOrder, { userId, session });

  const bal0 = await getLastDealerOrderOutstanding(dealerId, session);
  const bal1 = roundLedgerMoney(bal0 + amt);
  const sourceRow = await createDealerLedgerEntry({
    dealer: dealerId,
    refType: "ADJUSTMENT",
    refId: reqOid,
    orderId: sourceOrder._id,
    debit: amt,
    credit: 0,
    balanceBefore: bal0,
    balanceAfter: bal1,
    reference: String(sourceNum),
    description: `Transfer request out (ref) — order #${sourceNum} → #${targetNum}`,
    createdBy: userId,
    metadata: {
      ...metaBase,
      direction: "out",
      tracksOrderOutstanding: true,
    },
    session,
  });

  const bal2 = bal1;
  const bal3 = roundLedgerMoney(bal2 - amt);
  const targetRow = await createDealerLedgerEntry({
    dealer: dealerId,
    refType: "ORDER_RECEIVABLE_PAYMENT",
    refId: targetPayment._id,
    orderId: targetOrder._id,
    paymentId: targetPayment._id,
    debit: 0,
    credit: amt,
    balanceBefore: bal2,
    balanceAfter: bal3,
    reference: String(targetNum),
    description: `Transfer request in (ref) — order #${targetNum} ← #${sourceNum}`,
    createdBy: userId,
    metadata: {
      ...metaBase,
      direction: "in",
      tracksOrderOutstanding: true,
    },
    session,
  });

  return {
    source: { action: sourceRow ? "DEBIT_REF" : "NONE", entry: sourceRow },
    target: { action: targetRow ? "CREDIT_REF" : "NONE", entry: targetRow },
  };
}

async function syncDealerTransferRequestUndoReference(
  { sourceOrder, targetOrder, targetPayment, amount, transferRequestId, userId },
  { session } = {}
) {
  const dealerId = await resolveFundingDealerId(sourceOrder);
  const targetDealer = await resolveFundingDealerId(targetOrder);
  if (!dealerId || !targetDealer || String(dealerId) !== String(targetDealer)) {
    return { source: { action: "SKIP" }, target: { action: "SKIP" } };
  }

  const amt = roundLedgerMoney(amount);
  if (!(amt > 0)) return { source: { action: "NONE" }, target: { action: "NONE" } };

  const sourceNum = sourceOrder.orderId ?? "";
  const targetNum = targetOrder.orderId ?? "";
  const metaUndo = requestUndoMeta(transferRequestId, null, null, null);
  const reqOid =
    transferRequestId instanceof mongoose.Types.ObjectId
      ? transferRequestId
      : new mongoose.Types.ObjectId(String(transferRequestId));

  let targetResult = await syncDealerLedgerForPaymentStatusTransition(
    targetOrder,
    targetPayment,
    "COLLECTED",
    "REJECTED",
    {
      userId,
      session,
      descriptionOverride: `Transfer request undo — reject on order #${targetNum}`,
      metadataExtra: { ...metaUndo, direction: "reject_target" },
    }
  );

  if (targetResult?.action === "NONE") {
    await ensureDealerOrderBookingAudit(targetOrder, { userId, session });
    const snap = {
      ...(targetPayment.toObject?.() || targetPayment),
      paymentStatus: "COLLECTED",
    };
    await ensureDealerOrderReceivablePaymentCredit(targetOrder, snap, {
      userId,
      session,
      allowTransferIn: true,
      metadataExtra: requestMeta(transferRequestId, "in", sourceOrder._id, sourceNum),
    });
    targetResult = await syncDealerLedgerForPaymentStatusTransition(
      targetOrder,
      targetPayment,
      "COLLECTED",
      "REJECTED",
      {
        userId,
        session,
        descriptionOverride: `Transfer request undo — reject on order #${targetNum}`,
        metadataExtra: { ...metaUndo, direction: "reject_target" },
      }
    );
  }

  const existingIn = await findDealerOrderReceivablePaymentEntry(
    targetOrder._id,
    targetPayment._id,
    session
  );

  const bal0 = await getLastDealerOrderOutstanding(dealerId, session);
  const bal1 = roundLedgerMoney(bal0 - amt);
  const sourceRow = await createDealerLedgerEntry({
    dealer: dealerId,
    refType: "ADJUSTMENT",
    refId: reqOid,
    orderId: sourceOrder._id,
    debit: 0,
    credit: amt,
    balanceBefore: bal0,
    balanceAfter: bal1,
    reference: String(sourceNum),
    description: `Transfer request undo restore (ref) — order #${sourceNum}`,
    createdBy: userId,
    metadata: {
      ...metaUndo,
      direction: "restore_source",
      tracksOrderOutstanding: true,
      reversedTargetReceivableId: existingIn ? String(existingIn._id) : undefined,
    },
    session,
  });

  return {
    source: { action: sourceRow ? "CREDIT_REF" : "NONE", entry: sourceRow },
    target: targetResult,
  };
}

async function syncFarmerTransferRequestApprove({
  sourceOrder,
  targetOrder,
  targetPayment,
  amount,
  transferRequestId,
  ledgerTxnId,
  userId,
  session,
  transferMsg,
}) {
  const farmer = { source: null, target: null };
  const sourceNum = sourceOrder.orderId ?? "";
  const targetNum = targetOrder.orderId ?? "";
  const meta = requestMeta(transferRequestId, null, null, null);

  if (shouldLogFarmerPlantLedger(sourceOrder)) {
    const sourceParty = await resolveFarmerIdentity(sourceOrder);
    await ensureFarmerPlantOrderDebit(sourceOrder, { userId, session });
    farmer.source = await createFarmerPlantLedgerEntry({
      customerMobile: sourceParty.customerMobile,
      customerName: sourceParty.customerName,
      farmerId: sourceParty.farmerId,
      refType: "REVERSAL",
      refId: ledgerTxnId || transferRequestId,
      orderId: sourceOrder._id,
      debit: amount,
      reference: String(sourceNum),
      category: "Order Transfer Out",
      description:
        `Transfer request approved (out): order #${sourceNum} → #${targetNum}. ` +
        `₹${amount.toLocaleString("en-IN")}.${transferMsg ? ` Note: ${transferMsg}` : ""}`,
      entryDate: new Date(),
      createdBy: userId,
      metadata: { ...meta, direction: "out", peerOrderMongoId: String(targetOrder._id), peerOrderNumber: targetNum },
      session,
    });
  }

  if (shouldLogFarmerPlantLedger(targetOrder) && targetPayment?._id) {
    const targetParty = await resolveFarmerIdentity(targetOrder);
    await ensureFarmerPlantOrderDebit(targetOrder, { userId, session });
    farmer.target = await createFarmerPlantLedgerEntry({
      customerMobile: targetParty.customerMobile,
      customerName: targetParty.customerName,
      farmerId: targetParty.farmerId,
      refType: "PAYMENT",
      refId: targetPayment._id,
      orderId: targetOrder._id,
      paymentId: targetPayment._id,
      credit: amount,
      reference: String(targetNum),
      category: "Order Transfer In",
      description:
        `Transfer request approved (in): order #${targetNum} ← #${sourceNum}. ` +
        `₹${amount.toLocaleString("en-IN")}.${transferMsg ? ` Note: ${transferMsg}` : ""}`,
      entryDate: new Date(),
      createdBy: userId,
      metadata: { ...meta, direction: "in", peerOrderMongoId: String(sourceOrder._id), peerOrderNumber: sourceNum },
      session,
    });
  }

  return farmer;
}

async function syncFarmerTransferRequestUndo({
  sourceOrder,
  targetOrder,
  targetPayment,
  transferRequestId,
  restoredTotal,
  userId,
  session,
  prevTargetStatus,
}) {
  const farmer = { source: null, target: null };
  const sourceNum = sourceOrder.orderId ?? "";
  const targetNum = targetOrder.orderId ?? "";
  const metaUndo = requestUndoMeta(transferRequestId, null, null, null);

  if (
    shouldLogFarmerPlantLedger(targetOrder) &&
    prevTargetStatus === "COLLECTED" &&
    targetPayment?._id
  ) {
    await ensureFarmerPlantOrderDebit(targetOrder, { userId, session });
    farmer.target = await recordFarmerPlantLedgerPaymentTransition(
      targetOrder,
      targetPayment,
      "COLLECTED",
      "REJECTED",
      {
        userId,
        session,
        descriptionOverride: `Transfer request undo: reject payment on order #${targetNum}`,
        metadataExtra: { ...metaUndo, direction: "reject_target" },
      }
    );
  }

  if (shouldLogFarmerPlantLedger(sourceOrder) && restoredTotal > 0) {
    const sourceParty = await resolveFarmerIdentity(sourceOrder);
    if (sourceParty.customerMobile) {
      await ensureFarmerPlantOrderDebit(sourceOrder, { userId, session });
      farmer.source = await createFarmerPlantLedgerEntry({
        customerMobile: sourceParty.customerMobile,
        customerName: sourceParty.customerName,
        farmerId: sourceParty.farmerId,
        refType: "ADJUSTMENT",
        refId: new mongoose.Types.ObjectId(),
        orderId: sourceOrder._id,
        credit: restoredTotal,
        reference: String(sourceNum),
        category: "Order Transfer Undo",
        description: `Transfer request undo: restore order #${sourceNum} (reject on #${targetNum})`,
        entryDate: new Date(),
        createdBy: userId,
        metadata: {
          ...metaUndo,
          direction: "restore_source",
          peerOrderMongoId: String(targetOrder._id),
          peerOrderNumber: targetNum,
        },
        session,
      });
    }
  }

  return farmer;
}

/**
 * Post farmer + dealer + central reference rows when a transfer request is approved.
 */
export async function syncTransferRequestApproveLedgers(
  {
    sourceOrder,
    targetOrder,
    targetPayment,
    transferRequestId,
    amount,
    userId,
    ledgerTxnId,
    transferMsg,
  },
  { session } = {}
) {
  const amt = roundMoney(amount);

  const farmer = await syncFarmerTransferRequestApprove({
    sourceOrder,
    targetOrder,
    targetPayment,
    amount: amt,
    transferRequestId,
    ledgerTxnId,
    userId,
    session,
    transferMsg,
  });

  const dealer = await syncDealerTransferRequestApproveReference(
    { sourceOrder, targetOrder, targetPayment, amount: amt, transferRequestId, userId },
    { session }
  );

  const central = await shadowTransferRequestPair({
    transferRequestId,
    amount: amt,
    sourceOrder,
    targetOrder,
    userId,
  });

  return { farmer, dealer, central };
}

/**
 * Reverse farmer + dealer + central reference rows when an approved transfer is rejected.
 */
export async function syncTransferRequestUndoLedgers(
  {
    sourceOrder,
    targetOrder,
    targetPayment,
    transferRequestId,
    amount,
    restoredTotal,
    userId,
    prevTargetStatus,
  },
  { session } = {}
) {
  const amt = roundMoney(amount);
  const restored = roundMoney(restoredTotal);

  const farmer = await syncFarmerTransferRequestUndo({
    sourceOrder,
    targetOrder,
    targetPayment,
    transferRequestId,
    restoredTotal: restored,
    userId,
    session,
    prevTargetStatus,
  });

  const dealer = await syncDealerTransferRequestUndoReference(
    { sourceOrder, targetOrder, targetPayment, amount: amt, transferRequestId, userId },
    { session }
  );

  const central = await shadowTransferRequestUndoPair({
    transferRequestId,
    amount: amt,
    sourceOrder,
    targetOrder,
    userId,
    prevTargetStatus,
  });

  return { farmer, dealer, central };
}
