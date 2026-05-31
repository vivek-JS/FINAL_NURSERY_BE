/**
 * Paired ledger + central finance for direct order payment transfer (POST transfer-order-payment).
 */
import {
  shouldLogFarmerPlantLedger,
  ensureFarmerPlantOrderDebit,
  recordFarmerPlantLedgerPaymentTransition,
  resolveFarmerIdentity,
  resolveFundingDealerId,
  roundMoney,
} from "../utils/farmerPlantOrderLedgerHelper.js";
import {
  syncDealerLedgerForDirectOrderPaymentTransfer,
  syncDealerLedgerForDirectOrderPaymentTransferUndo,
  ensureDealerOrderBookingAudit,
  ensureDealerOrderReceivablePaymentCredit,
  findDealerOrderReceivablePaymentEntry,
  syncDealerLedgerForPaymentStatusTransition,
} from "../utils/dealerLedgerHelper.js";

function transferMeta(transferId, direction, peerOrderMongoId, peerOrderNumber) {
  return {
    kind: "order_payment_transfer",
    transferId: transferId ? String(transferId) : undefined,
    direction,
    peerOrderMongoId: peerOrderMongoId ? String(peerOrderMongoId) : undefined,
    peerOrderNumber: peerOrderNumber != null ? String(peerOrderNumber) : undefined,
  };
}

function undoMeta(direction, peerOrderMongoId, peerOrderNumber) {
  return {
    kind: "order_payment_transfer_undo",
    direction,
    peerOrderMongoId: peerOrderMongoId ? String(peerOrderMongoId) : undefined,
    peerOrderNumber: peerOrderNumber != null ? String(peerOrderNumber) : undefined,
  };
}

async function shadowFarmerTransferPair({ transferId, amount, sourceOrder, targetOrder, userId }) {
  const results = [];
  try {
    const fs = await import("../modules/finance/integration/financeShadow.js");
    const amt = roundMoney(amount);
    if (!(amt > 0) || !transferId) return results;

    const sourceParty = await resolveFarmerIdentity(sourceOrder);
    const targetParty = await resolveFarmerIdentity(targetOrder);

    if (sourceParty.customerMobile) {
      fs.shadowFarmerPaymentTransfer({
        requestId: transferId,
        direction: "REVERSAL",
        amount: amt,
        customerMobile: sourceParty.customerMobile,
        userId,
      });
      results.push({ party: "source", direction: "REVERSAL" });
    }
    if (targetParty.customerMobile) {
      fs.shadowFarmerPaymentTransfer({
        requestId: `${transferId}:in`,
        direction: "CREDIT",
        amount: amt,
        customerMobile: targetParty.customerMobile,
        userId,
      });
      results.push({ party: "target", direction: "CREDIT" });
    }
  } catch (err) {
    console.error("[Finance] shadow farmer payment transfer:", err?.message || err);
  }
  return results;
}

async function ensureDealerTransferOutReversal(
  sourceOrder,
  sourcePayment,
  { transferId, userId, session, targetOrder }
) {
  const dealerId = await resolveFundingDealerId(sourceOrder);
  if (!dealerId) return { action: "NONE" };

  const oid = sourceOrder._id;
  const pid = sourcePayment._id;
  const existing = await findDealerOrderReceivablePaymentEntry(oid, pid, session);

  if (!existing) {
    await ensureDealerOrderBookingAudit(sourceOrder, { userId, session });
    const snapshot = {
      ...(sourcePayment.toObject?.() || sourcePayment),
      paymentStatus: "COLLECTED",
    };
    await ensureDealerOrderReceivablePaymentCredit(sourceOrder, snapshot, {
      userId,
      session,
      metadataExtra: transferMeta(transferId, "out", targetOrder?._id, targetOrder?.orderId),
    });
  }

  return syncDealerLedgerForPaymentStatusTransition(
    sourceOrder,
    sourcePayment,
    "COLLECTED",
    "REJECTED",
    {
      userId,
      session,
      descriptionOverride: `Order payment transfer out — order ${sourceOrder.orderId ?? ""}`,
      metadataExtra: transferMeta(transferId, "out", targetOrder?._id, targetOrder?.orderId),
    }
  );
}

async function syncFarmerPlantTransferForward({
  sourceOrder,
  sourcePayment,
  targetOrder,
  targetPayment,
  transferId,
  userId,
  session,
  prevSourceStatus,
}) {
  const farmer = { source: null, target: null };
  const sourceNum = sourceOrder.orderId ?? "";
  const targetNum = targetOrder.orderId ?? "";

  if (shouldLogFarmerPlantLedger(sourceOrder)) {
    await ensureFarmerPlantOrderDebit(sourceOrder, { userId, session });
    farmer.source = await recordFarmerPlantLedgerPaymentTransition(
      sourceOrder,
      sourcePayment,
      prevSourceStatus || "COLLECTED",
      "REJECTED",
      {
        userId,
        session,
        descriptionOverride: `Order transfer (out): #${sourceNum} → #${targetNum}.`,
        metadataExtra: transferMeta(transferId, "out", targetOrder._id, targetNum),
      }
    );
  }

  if (shouldLogFarmerPlantLedger(targetOrder)) {
    await ensureFarmerPlantOrderDebit(targetOrder, { userId, session });
    farmer.target = await recordFarmerPlantLedgerPaymentTransition(
      targetOrder,
      targetPayment,
      "PENDING",
      "COLLECTED",
      {
        userId,
        session,
        descriptionOverride: `Order transfer (in): #${targetNum} ← #${sourceNum}.`,
        metadataExtra: transferMeta(transferId, "in", sourceOrder._id, sourceNum),
      }
    );
  }

  return farmer;
}

async function syncFarmerPlantTransferUndo({
  sourceOrder,
  sourcePayment,
  targetOrder,
  targetPayment,
  transferId,
  userId,
  session,
  prevTargetStatus,
}) {
  const farmer = { source: null, target: null };
  const sourceNum = sourceOrder.orderId ?? "";
  const targetNum = targetOrder.orderId ?? "";
  const metaBase = transferId ? { transferId: String(transferId) } : {};

  if (shouldLogFarmerPlantLedger(sourceOrder)) {
    await ensureFarmerPlantOrderDebit(sourceOrder, { userId, session });
    farmer.source = await recordFarmerPlantLedgerPaymentTransition(
      sourceOrder,
      sourcePayment,
      "REJECTED",
      "COLLECTED",
      {
        userId,
        session,
        descriptionOverride: `Transfer undo: restore order #${sourceNum} payment`,
        metadataExtra: { ...metaBase, ...undoMeta("restore_source", targetOrder._id, targetNum) },
      }
    );
  }

  if (shouldLogFarmerPlantLedger(targetOrder) && prevTargetStatus === "COLLECTED") {
    await ensureFarmerPlantOrderDebit(targetOrder, { userId, session });
    farmer.target = await recordFarmerPlantLedgerPaymentTransition(
      targetOrder,
      targetPayment,
      "COLLECTED",
      "REJECTED",
      {
        userId,
        session,
        descriptionOverride: `Transfer undo: reject transferred payment on order #${targetNum}`,
        metadataExtra: { ...metaBase, ...undoMeta("reject_target", sourceOrder._id, sourceNum) },
      }
    );
  }

  return farmer;
}

export async function syncDirectOrderPaymentTransferLedgers(
  { sourceOrder, sourcePayment, targetOrder, targetPayment, transferId, userId, prevSourceStatus },
  { session } = {}
) {
  const amount = roundMoney(Math.abs(Number(sourcePayment?.paidAmount || 0)));

  const farmer = await syncFarmerPlantTransferForward({
    sourceOrder,
    sourcePayment,
    targetOrder,
    targetPayment,
    transferId,
    userId,
    session,
    prevSourceStatus,
  });

  const sourceDealer = await resolveFundingDealerId(sourceOrder);
  const targetDealer = await resolveFundingDealerId(targetOrder);
  let dealer;

  if (sourceDealer && targetDealer && String(sourceDealer) === String(targetDealer)) {
    dealer = {
      source: await ensureDealerTransferOutReversal(sourceOrder, sourcePayment, {
        transferId,
        userId,
        session,
        targetOrder,
      }),
      target: await syncDealerLedgerForPaymentStatusTransition(
        targetOrder,
        targetPayment,
        "PENDING",
        "COLLECTED",
        {
          userId,
          session,
          descriptionOverride: `Order payment transfer in — order ${targetOrder.orderId ?? ""}`,
          metadataExtra: {
            ...transferMeta(transferId, "in", sourceOrder._id, sourceOrder.orderId),
            allowTransferIn: true,
          },
        }
      ),
    };
  } else {
    dealer = await syncDealerLedgerForDirectOrderPaymentTransfer(
      { sourceOrder, sourcePayment, targetOrder, targetPayment, transferId, userId },
      { session }
    );
    if (sourceDealer && dealer?.source?.action === "NONE") {
      dealer.source = await ensureDealerTransferOutReversal(sourceOrder, sourcePayment, {
        transferId,
        userId,
        session,
        targetOrder,
      });
    }
  }

  const central = await shadowFarmerTransferPair({
    transferId,
    amount,
    sourceOrder,
    targetOrder,
    userId,
  });

  return { farmer, dealer, central };
}

export async function syncDirectOrderPaymentTransferUndoLedgers(
  { sourceOrder, sourcePayment, targetOrder, targetPayment, transferId, userId, prevTargetStatus },
  { session } = {}
) {
  const amount = roundMoney(Math.abs(Number(targetPayment?.paidAmount || 0)));

  const farmer = await syncFarmerPlantTransferUndo({
    sourceOrder,
    sourcePayment,
    targetOrder,
    targetPayment,
    transferId,
    userId,
    session,
    prevTargetStatus,
  });

  const dealer = await syncDealerLedgerForDirectOrderPaymentTransferUndo(
    { sourceOrder, sourcePayment, targetOrder, targetPayment, userId },
    { session }
  );

  const central = [];
  try {
    const fs = await import("../modules/finance/integration/financeShadow.js");
    const tid = transferId || targetPayment?.orderPaymentTransferId;
    if (tid && amount > 0) {
      const sourceParty = await resolveFarmerIdentity(sourceOrder);
      const targetParty = await resolveFarmerIdentity(targetOrder);
      if (sourceParty.customerMobile) {
        fs.shadowFarmerPaymentTransfer({
          requestId: tid,
          direction: "CREDIT",
          amount,
          customerMobile: sourceParty.customerMobile,
          userId,
        });
        central.push({ party: "source", direction: "CREDIT" });
      }
      if (targetParty.customerMobile && prevTargetStatus === "COLLECTED") {
        fs.shadowFarmerPaymentTransfer({
          requestId: `${tid}:undo`,
          direction: "REVERSAL",
          amount,
          customerMobile: targetParty.customerMobile,
          userId,
        });
        central.push({ party: "target", direction: "REVERSAL" });
      }
    }
  } catch (err) {
    console.error("[Finance] shadow farmer transfer undo:", err?.message || err);
  }

  return { farmer, dealer, central };
}
