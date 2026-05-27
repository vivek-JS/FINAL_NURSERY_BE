import ChartOfAccount from "../ledger/models/chartOfAccount.model.js";
import { DEFAULT_CHART_ACCOUNTS } from "./defaultAccounts.js";

/**
 * Idempotent seed of default chart of accounts.
 */
export async function seedChartOfAccounts(tenantId = "default") {
  const results = { created: 0, existing: 0 };
  for (const acct of DEFAULT_CHART_ACCOUNTS) {
    const exists = await ChartOfAccount.findOne({ tenantId, code: acct.code }).lean();
    if (exists) {
      results.existing += 1;
      continue;
    }
    await ChartOfAccount.create({ tenantId, ...acct });
    results.created += 1;
  }
  return results;
}
