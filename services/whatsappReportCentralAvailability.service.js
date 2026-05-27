import { runCentralReport } from "../utility/centralReportEngine/index.js";

/**
 * Slot availability for WATI report wizard — same source as dashboard / Admin MIS stock tab.
 * @param {{ year?: number, month?: string, plantId?: string, search?: string, onlyAvailable?: boolean|string }} filters
 */
export async function fetchCentralAvailabilityReport(filters = {}) {
  const year = Number(filters.year) || new Date().getFullYear();
  const startYmd = `${year}-01-01`;
  const endYmd = `${year}-12-31`;

  const result = await runCentralReport("slot-availability", startYmd, endYmd, {
    year,
    month: filters.month,
    plantId: filters.plantId,
    search: filters.search,
    onlyAvailable: filters.onlyAvailable,
  });

  if (result.error) {
    throw new Error(result.error);
  }

  return result.data;
}
