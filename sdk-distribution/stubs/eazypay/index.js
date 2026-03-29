/**
 * Stub SdkClient for local npm install until you drop the real @icici/eazypay from ICICI.
 * Real SDK: replace this package (same import path @icici/eazypay) and keep SdkClient.execute API.
 *
 * Set EAZYPAY_USE_STUB=true in .env to return a fake UPI QR for UI testing without bank certs.
 * Do not use stub in production.
 */

export class SdkClient {
  /**
   * Assumption: real ICICI SDK uses an object parameter. Adjust keys to match your integration guide
   * (e.g. moduleName vs module, requestBody vs request).
   *
   * @param {object} opts
   * @param {string} [opts.module] - e.g. 'eazypay'
   * @param {string} [opts.moduleName]
   * @param {string} [opts.apiId]
   * @param {object} [opts.request]
   */
  static async execute(opts = {}) {
    if (process.env.EAZYPAY_USE_STUB === "true") {
      const req = opts.request || opts.body || {};
      const mid = req.merchantTranId || `STUB_${Date.now()}`;
      const amt = req.amount || "0.00";
      return {
        statusCode: 200,
        data: {
          merchantTranId: mid,
          qrString: `upi://pay?pa=stub@icici&pn=StubMerchant&am=${amt}&cu=INR&tn=${encodeURIComponent(req.billNumber || "")}&tr=${mid}`,
          respCode: "00",
          respDesc: "SUCCESS (STUB)",
        },
      };
    }

    throw new Error(
      "[ICICI EazyPay] Real SDK not configured: copy vendor @icici/eazypay over sdk-distribution/stubs/eazypay " +
        "or install from bank .tgz, set paths in .env, and remove EAZYPAY_USE_STUB. " +
        "For UI-only testing set EAZYPAY_USE_STUB=true."
    );
  }
}
