import mongoose from "mongoose";
import FinancialEvent from "../ledger/models/financialEvent.model.js";
import { EVENT_STATUS } from "../domain/constants.js";
import { seedChartOfAccounts } from "../coa/seedChartOfAccounts.js";
import { generateVoucherNo } from "../posting/voucherNumber.js";
import { createAndPostVoucher } from "../posting/postJournal.js";
import { buildJournalLines, voucherTypeForEvent } from "./buildJournalLines.js";
import { describeFinancialEvent } from "../domain/eventLabels.js";
import { DEFAULT_BRANCH_ID } from "../domain/constants.js";
import { withFinancePostLock } from "../posting/financePostLock.js";

let coaSeeded = false;

async function ensureCoa() {
  if (!coaSeeded) {
    await seedChartOfAccounts();
    coaSeeded = true;
  }
}

/**
 * Central ingest: idempotent financial event → voucher → journal → ledger lines.
 * Shadow mode: failures are logged but do not throw unless strict=true.
 */
export async function emitFinancialEvent({
  idempotencyKey,
  eventType,
  sourceDomain,
  sourceId,
  payload = {},
  entryDate = new Date(),
  branchId = DEFAULT_BRANCH_ID,
  tenantId = "default",
  createdBy,
  clientEventId,
  orderEventId,
  session,
  strict = false,
}) {
  if (!idempotencyKey || !eventType) {
    if (strict) throw new Error("emitFinancialEvent requires idempotencyKey and eventType");
    return null;
  }

  try {
    await ensureCoa();

    const existingQ = FinancialEvent.findOne({ tenantId, idempotencyKey });
    if (session) existingQ.session(session);
    const existing = await existingQ.lean();
    if (existing?.status === EVENT_STATUS.PROCESSED) {
      return { ...existing, skippedExisting: true };
    }
    if (existing?.status === EVENT_STATUS.REJECTED) {
      return existing;
    }
    // FAILED rows are retried on replay (idempotent key).

    let financialEvent = existing;
    if (!financialEvent) {
      const createPayload = {
        tenantId,
        idempotencyKey,
        eventType,
        sourceDomain,
        sourceId: sourceId ? String(sourceId) : undefined,
        payload,
        status: EVENT_STATUS.PENDING,
        clientEventId,
        createdBy,
        orderEventId,
      };
      if (session) {
        const [created] = await FinancialEvent.create([createPayload], { session });
        financialEvent = created.toObject();
      } else {
        financialEvent = (await FinancialEvent.create(createPayload)).toObject();
      }
    }

    const builtLines = buildJournalLines(eventType, payload);
    const lines = (builtLines || []).map((l) => ({
      ...l,
      metadata: {
        ...(l.metadata || {}),
        ...(payload.metadata || {}),
        eventType,
        ...(payload.direction != null ? { direction: payload.direction } : {}),
      },
      sourceLineRef: l.sourceLineRef || eventType,
    }));
    if (!lines?.length) {
      await FinancialEvent.updateOne(
        { _id: financialEvent._id },
        { status: EVENT_STATUS.REJECTED, errorMessage: "No journal lines for event" }
      );
      return financialEvent;
    }

    const voucherType = voucherTypeForEvent(eventType);
    const voucherNo = await generateVoucherNo(voucherType, tenantId);
    const partyType = payload.partyType;
    const partyId = payload.partyId || payload.customerMobile || payload.dealerId?.toString?.();

    const voucherDraft = {
      tenantId,
      voucherNo,
      voucherType,
      status: "DRAFT",
      branchId,
      entryDate: new Date(entryDate),
      partyType,
      partyId: partyId ? String(partyId) : undefined,
      sourceDomain,
      sourceRefs: sourceId ? [String(sourceId)] : [],
      description: payload.description || describeFinancialEvent(eventType, payload),
      financialEventId: financialEvent._id,
      metadata: { ...(payload.metadata || {}), eventType },
      createdBy,
    };

    const postOpts = { voucherDraft, lines, session };
    const postOnce = () => createAndPostVoucher(postOpts);
    let journalEntry;
    let voucher;
    const runPost = async () => {
      const result = await withFinancePostLock(postOnce);
      journalEntry = result.journalEntry;
      voucher = result.voucher;
    };
    await runPost();

    await FinancialEvent.updateOne(
      { _id: financialEvent._id },
      {
        status: EVENT_STATUS.PROCESSED,
        voucherId: voucher._id,
        journalEntryId: journalEntry._id,
        errorMessage: undefined,
      }
    );

    return {
      ...financialEvent,
      status: EVENT_STATUS.PROCESSED,
      voucherId: voucher._id,
      journalEntryId: journalEntry._id,
    };
  } catch (err) {
    console.error("[Finance] emitFinancialEvent failed:", idempotencyKey, err?.message || err);
    try {
      await FinancialEvent.updateOne(
        { tenantId, idempotencyKey },
        { status: EVENT_STATUS.FAILED, errorMessage: String(err?.message || err) }
      );
    } catch (_) {
      /* ignore */
    }
    if (strict) throw err;
    return null;
  }
}

/**
 * Awaitable shadow post (backfill / replay). Same idempotency keys as live shadow.
 */
export function emitFinancialEventShadowAwait(params) {
  return emitFinancialEvent({ ...params, strict: false });
}

/**
 * Fire-and-forget shadow post (never blocks domain transaction).
 */
export function emitFinancialEventShadow(params) {
  setImmediate(() => {
    emitFinancialEventShadowAwait(params).catch((e) => {
      console.error("[Finance] shadow post error:", e?.message || e);
    });
  });
}
