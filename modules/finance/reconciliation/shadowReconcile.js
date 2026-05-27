import LedgerLine from "../ledger/models/ledgerLine.model.js";
import LedgerReconciliationRun from "../ledger/models/ledgerReconciliationRun.model.js";
import FarmerPlantOrderLedgerEntry from "../../../models/farmerPlantOrderLedger.model.js";
import RamAgriCustomerLedgerEntry from "../../../models/ramAgriCustomerLedger.model.js";
import DealerLedgerEntry from "../../../models/dealerLedgerEntry.model.js";
import { ACCOUNT_CODES, PARTY_TYPES } from "../domain/constants.js";
import { roundMoney } from "../domain/roundMoney.js";
import { getRamAgriRunningBalanceAfterMobile } from "../../../utils/ramAgriLedgerHelper.js";
import {
  sortLedgerEntriesCanonical,
  computeOutstandingAfterChain,
} from "../../../utils/farmerPlantOrderLedgerHelper.js";

const EPS = 0.02;

async function centralPartyBalance(partyType, partyId, accountCode) {
  const lines = await LedgerLine.find({
    partyType,
    partyId: String(partyId),
    accountCode,
  }).lean();

  let balance = 0;
  for (const l of lines) {
    balance += (Number(l.debit) || 0) - (Number(l.credit) || 0);
  }
  return roundMoney(balance);
}

async function farmerSubLedgerBalance(customerMobile) {
  const docs = await FarmerPlantOrderLedgerEntry.find({
    customerMobile: String(customerMobile).trim(),
  }).lean();
  if (!docs.length) return 0;
  const sorted = sortLedgerEntriesCanonical(docs);
  const last = sorted[sorted.length - 1];
  if (last.outstandingAfter != null) return roundMoney(last.outstandingAfter);
  return computeOutstandingAfterChain(sorted);
}

async function dealerSubLedgerBalance(dealerId) {
  const docs = await DealerLedgerEntry.find({ dealer: dealerId })
    .sort({ entryDate: 1, createdAt: 1 })
    .lean();
  let running = 0;
  for (const d of docs) {
    if (d.refType === "ORDER_BOOKING") {
      running += Number(d.debit) || 0;
    } else if (d.refType === "ORDER_RECEIVABLE_PAYMENT") {
      running -= Number(d.credit) || 0;
    } else {
      running += (Number(d.debit) || 0) - (Number(d.credit) || 0);
    }
  }
  return roundMoney(Math.max(0, running));
}

export async function runShadowReconciliation({ tenantId = "default", sampleLimit = 200 } = {}) {
  const run = await LedgerReconciliationRun.create({
    tenantId,
    runDate: new Date(),
    domain: "ALL",
    status: "RUNNING",
    mismatches: [],
  });

  const mismatches = [];
  let totalChecked = 0;

  try {
    const farmerParties = await FarmerPlantOrderLedgerEntry.aggregate([
      { $group: { _id: "$customerMobile" } },
      { $limit: sampleLimit },
    ]);

    for (const row of farmerParties) {
      const mobile = row._id;
      if (!mobile) continue;
      totalChecked += 1;
      const central = await centralPartyBalance(
        PARTY_TYPES.FARMER,
        mobile,
        ACCOUNT_CODES.AR_FARMER
      );
      const sub = await farmerSubLedgerBalance(mobile);
      const delta = roundMoney(central - sub);
      if (Math.abs(delta) > EPS) {
        mismatches.push({
          partyType: "FARMER",
          partyId: mobile,
          centralBalance: central,
          subLedgerBalance: sub,
          delta,
          notes: "Farmer plant vs AR_FARMER",
        });
      }
    }

    const agriParties = await RamAgriCustomerLedgerEntry.aggregate([
      { $group: { _id: "$customerMobile" } },
      { $limit: sampleLimit },
    ]);

    for (const row of agriParties) {
      const mobile = row._id;
      if (!mobile) continue;
      totalChecked += 1;
      const central = await centralPartyBalance(
        PARTY_TYPES.AGRI_CUSTOMER,
        mobile,
        ACCOUNT_CODES.AR_AGRI
      );
      const sub = await getRamAgriRunningBalanceAfterMobile(mobile);
      const delta = roundMoney(central - sub);
      if (Math.abs(delta) > EPS) {
        mismatches.push({
          partyType: "AGRI_CUSTOMER",
          partyId: mobile,
          centralBalance: central,
          subLedgerBalance: sub,
          delta,
          notes: "Ram Agri vs AR_AGRI",
        });
      }
    }

    const dealerParties = await DealerLedgerEntry.aggregate([
      { $group: { _id: "$dealer" } },
      { $limit: sampleLimit },
    ]);

    for (const row of dealerParties) {
      const dealerId = row._id;
      if (!dealerId) continue;
      totalChecked += 1;
      const central = await centralPartyBalance(
        PARTY_TYPES.DEALER,
        String(dealerId),
        ACCOUNT_CODES.AR_DEALER
      );
      const sub = await dealerSubLedgerBalance(dealerId);
      const delta = roundMoney(central - sub);
      if (Math.abs(delta) > EPS) {
        mismatches.push({
          partyType: "DEALER",
          partyId: String(dealerId),
          centralBalance: central,
          subLedgerBalance: sub,
          delta,
          notes: "Dealer ledger vs AR_DEALER",
        });
      }
    }

    run.status = mismatches.length === 0 ? "PASSED" : "FAILED";
    run.totalChecked = totalChecked;
    run.mismatchCount = mismatches.length;
    run.mismatches = mismatches;
    run.completedAt = new Date();
    await run.save();

    return {
      runId: run._id,
      status: run.status,
      totalChecked,
      mismatchCount: mismatches.length,
      mismatches,
    };
  } catch (err) {
    run.status = "FAILED";
    run.completedAt = new Date();
    run.mismatches.push({
      partyType: "SYSTEM",
      partyId: "error",
      centralBalance: 0,
      subLedgerBalance: 0,
      delta: 0,
      notes: err.message,
    });
    await run.save();
    throw err;
  }
}
