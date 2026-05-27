import ChartOfAccount from "../ledger/models/chartOfAccount.model.js";

const cache = new Map();

export async function getAccountByCode(code, tenantId = "default", session) {
  const key = `${tenantId}:${code}`;
  if (cache.has(key)) return cache.get(key);

  const q = ChartOfAccount.findOne({ tenantId, code, isActive: true });
  if (session) q.session(session);
  const doc = await q.lean();
  if (doc) cache.set(key, doc);
  return doc;
}

export async function requireAccountByCode(code, tenantId = "default", session) {
  const doc = await getAccountByCode(code, tenantId, session);
  if (!doc) {
    throw new Error(`Chart of accounts missing account code: ${code}. Run seedChartOfAccounts.`);
  }
  return doc;
}

export function clearAccountCache() {
  cache.clear();
}
