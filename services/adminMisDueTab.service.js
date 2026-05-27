import { fetchAdminDailyMis } from "./adminDailyMis.service.js";
import { fetchAdminSalesMis } from "./adminMisBreakdown.service.js";
import { fetchAdminDealerMis } from "./adminMisBreakdown.service.js";

/**
 * Due-order MIS tab: pipeline delivery only + optional past-due backlog row.
 */
export async function fetchAdminDueMis(startDate, endDate, options = {}) {
  const { includeAllPastDue = false } = options;

  const [dailyResult, salesResult, dealerResult] = await Promise.all([
    fetchAdminDailyMis(startDate, endDate, {
      dueOnly: true,
      includeAllPastDue,
    }),
    fetchAdminSalesMis(startDate, endDate, {
      dueOnly: true,
      includeAllPastDue,
    }),
    fetchAdminDealerMis(startDate, endDate, {
      dueOnly: true,
      includeAllPastDue,
    }),
  ]);

  if (dailyResult.error) {
    return dailyResult;
  }

  return {
    data: {
      ...dailyResult.data,
      dueSummary: dailyResult.data.dueSummary,
      salesTable: salesResult.data?.rows ?? [],
      salesTotals: salesResult.data?.totals,
      dealerTable: dealerResult.data?.rows ?? [],
      dealerTotals: dealerResult.data?.totals,
      dueOnly: true,
      includeAllPastDue,
    },
  };
}
