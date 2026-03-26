/**
 * ICICI Bank API service - fetches transaction/statement data for reconciliation.
 * Configure via env: ICICI_BASE_URL, ICICI_API_KEY (or ICICI_CLIENT_ID, ICICI_CLIENT_SECRET).
 * When credentials are not set, returns empty array (reconciliation will match nothing).
 */

const normalizeUtr = (str) => (str || "").toString().trim().toUpperCase().replace(/\s+/g, "");
const normalizeAmount = (n) => Math.round(Number(n) * 100) / 100;

/**
 * Fetch credit transactions from ICICI for the given date range.
 * Expected to return array of { utrOrRef, amount, date, chequeNumber? }.
 * @param {Date} dateFrom
 * @param {Date} dateTo
 * @returns {Promise<Array<{ utrOrRef: string, amount: number, date: Date, chequeNumber?: string }>>}
 */
export async function fetchBankTransactions(dateFrom, dateTo) {
  const baseUrl = process.env.ICICI_BASE_URL;
  const apiKey = process.env.ICICI_API_KEY;

  if (!baseUrl || !apiKey) {
    console.warn("ICICI_BASE_URL or ICICI_API_KEY not set; returning empty bank transactions.");
    return [];
  }

  try {
    // TODO: Replace with actual ICICI Corporate API call (Transaction Enquiry / Statement API).
    return [];
  } catch (err) {
    console.error("ICICI fetchBankTransactions error:", err);
    throw err;
  }
}

/**
 * Generate QR for payment collection (ICICI UPI Collect / QR API).
 * @param {Object} params - { amount, referenceId, customerName, mobileNumber, orderId }
 * @returns {Promise<{ qrString?: string, qrImageBase64?: string, requestId?: string }>}
 */
export async function generateQR(params) {
  const { amount, referenceId, customerName, mobileNumber, orderId } = params || {};
  const baseUrl = process.env.ICICI_BASE_URL;
  const apiKey = process.env.ICICI_API_KEY;

  if (!baseUrl || !apiKey) {
    console.warn("ICICI_BASE_URL or ICICI_API_KEY not set; returning stub QR.");
    return { qrString: `upi://pay?pa=stub@icici&pn=${encodeURIComponent(customerName || "Customer")}&am=${amount}&tr=${referenceId}` };
  }

  try {
    // TODO: Replace with actual ICICI QR/Collect API call per their docs.
    return { qrString: `upi://pay?pa=stub@icici&pn=${encodeURIComponent(customerName || "Customer")}&am=${amount}&tr=${referenceId}` };
  } catch (err) {
    console.error("ICICI generateQR error:", err);
    throw err;
  }
}

export { normalizeUtr, normalizeAmount };
