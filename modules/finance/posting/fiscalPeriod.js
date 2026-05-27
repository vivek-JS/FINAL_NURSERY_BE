import FiscalPeriod from "../ledger/models/fiscalPeriod.model.js";

export function periodKeyFromDate(date) {
  const d = new Date(date);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

export async function ensureFiscalPeriodForDate(entryDate, tenantId = "default") {
  const key = periodKeyFromDate(entryDate);
  let period = await FiscalPeriod.findOne({ tenantId, periodKey: key });
  if (!period) {
    const start = new Date(Date.UTC(parseInt(key.slice(0, 4), 10), parseInt(key.slice(5, 7), 10) - 1, 1));
    const end = new Date(Date.UTC(parseInt(key.slice(0, 4), 10), parseInt(key.slice(5, 7), 10), 0, 23, 59, 59, 999));
    period = await FiscalPeriod.create({
      tenantId,
      periodKey: key,
      startDate: start,
      endDate: end,
      isClosed: false,
    });
  }
  return period;
}

export async function assertPeriodOpen(entryDate, tenantId = "default") {
  const key = periodKeyFromDate(entryDate);
  const period = await FiscalPeriod.findOne({ tenantId, periodKey: key }).lean();
  if (period?.isClosed) {
    throw new Error(`Fiscal period ${key} is closed. Cannot post entries.`);
  }
}

export async function closeFiscalPeriod(periodKey, userId, tenantId = "default") {
  const period = await FiscalPeriod.findOneAndUpdate(
    { tenantId, periodKey },
    { isClosed: true, closedAt: new Date(), closedBy: userId },
    { new: true }
  );
  if (!period) throw new Error(`Fiscal period not found: ${periodKey}`);
  return period;
}
