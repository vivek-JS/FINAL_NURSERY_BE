import catchAsync from "../../../utility/catchAsync.js";
import {
  PayoutError,
  getPayoutConfig,
  createPayout,
  approvePayout,
  rejectPayout,
  cancelPayout,
  refreshPayoutStatus,
  resendPayout,
  getPayout,
  listPayouts,
  payoutSummary,
} from "../services/iciciPayout.service.js";
import {
  approveBeneficiary,
  beneficiaryCounts,
  createBeneficiary,
  disableBeneficiary,
  listBeneficiaries,
  rejectBeneficiary,
} from "../services/iciciBeneficiary.service.js";

const HTTP_BY_CODE = {
  VALIDATION: 400,
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  SELF_APPROVAL: 403,
  BAD_STATE: 409,
  POSSIBLE_DUPLICATE: 409,
  DUPLICATE_BENEFICIARY: 409,
  BANK_NOT_CONFIGURED: 503,
};

/** Turn a PayoutError into a JSON response; anything else goes to the error handler. */
const handle = (fn) =>
  catchAsync(async (req, res, next) => {
    try {
      await fn(req, res, next);
    } catch (err) {
      if (!(err instanceof PayoutError)) throw err;
      // The web client only surfaces `message` and `errors`, so the duplicate
      // warning also travels as errors.duplicate.
      const errors = err.duplicate ? { ...(err.errors || {}), duplicate: err.message } : err.errors;
      return res.status(HTTP_BY_CODE[err.code] || 400).json({
        success: false,
        message: err.message,
        code: err.code,
        ...(errors ? { errors } : {}),
        ...(err.duplicate ? { duplicate: err.duplicate } : {}),
      });
    }
  });

/** GET /api/banking/payouts/config */
export const getPayoutsConfig = handle(async (req, res) => {
  res.status(200).json({ success: true, data: getPayoutConfig(req.user) });
});

/** GET /api/banking/payouts/summary */
export const getPayoutsSummary = handle(async (req, res) => {
  res.status(200).json({ success: true, data: await payoutSummary() });
});

/** GET /api/banking/payouts?view=approval|bank|done|all&search=&limit=&skip= */
export const getPayouts = handle(async (req, res) => {
  const { view, search, limit, skip } = req.query || {};
  const page = await listPayouts({ view, search, limit, skip });
  res.status(200).json({ success: true, data: page.items, ...page, items: undefined });
});

/** GET /api/banking/payouts/:id */
export const getPayoutById = handle(async (req, res) => {
  res.status(200).json({ success: true, data: await getPayout(req.params.id) });
});

/** POST /api/banking/payouts — maker */
export const postPayout = handle(async (req, res) => {
  const { confirmDuplicate, ...input } = req.body || {};
  const data = await createPayout(input, req.user, { confirmDuplicate: confirmDuplicate === true });
  res.status(201).json({ success: true, data });
});

/** POST /api/banking/payouts/:id/approve — checker */
export const postApprovePayout = handle(async (req, res) => {
  const data = await approvePayout(req.params.id, req.user, { note: req.body?.note });
  res.status(200).json({ success: true, data });
});

/** POST /api/banking/payouts/:id/reject — checker */
export const postRejectPayout = handle(async (req, res) => {
  const data = await rejectPayout(req.params.id, req.user, { reason: req.body?.reason });
  res.status(200).json({ success: true, data });
});

/** POST /api/banking/payouts/:id/cancel — maker */
export const postCancelPayout = handle(async (req, res) => {
  const data = await cancelPayout(req.params.id, req.user, { reason: req.body?.reason });
  res.status(200).json({ success: true, data });
});

/** POST /api/banking/payouts/:id/refresh */
export const postRefreshPayout = handle(async (req, res) => {
  const result = await refreshPayoutStatus(req.params.id, req.user);
  res.status(200).json({ success: true, data: result.payout, checked: result.checked, warning: result.warning });
});

/** POST /api/banking/payouts/:id/resend — checker, only when ICICI never answered */
export const postResendPayout = handle(async (req, res) => {
  const data = await resendPayout(req.params.id, req.user);
  res.status(200).json({ success: true, data });
});

/** GET /api/banking/beneficiaries?status=ACTIVE,PENDING_APPROVAL&search= */
export const getBeneficiaries = handle(async (req, res) => {
  const { status, search, limit, skip } = req.query || {};
  const [page, counts] = await Promise.all([
    listBeneficiaries({ status, search, limit, skip }),
    beneficiaryCounts(),
  ]);
  res.status(200).json({ success: true, data: page.items, ...page, items: undefined, counts });
});

/** POST /api/banking/beneficiaries — maker */
export const postBeneficiary = handle(async (req, res) => {
  res.status(201).json({ success: true, data: await createBeneficiary(req.body || {}, req.user) });
});

/** POST /api/banking/beneficiaries/:id/approve — checker */
export const postApproveBeneficiary = handle(async (req, res) => {
  const data = await approveBeneficiary(req.params.id, req.user, { note: req.body?.note });
  res.status(200).json({ success: true, data });
});

/** POST /api/banking/beneficiaries/:id/reject — checker */
export const postRejectBeneficiary = handle(async (req, res) => {
  const data = await rejectBeneficiary(req.params.id, req.user, { reason: req.body?.reason });
  res.status(200).json({ success: true, data });
});

/** POST /api/banking/beneficiaries/:id/disable — checker */
export const postDisableBeneficiary = handle(async (req, res) => {
  const data = await disableBeneficiary(req.params.id, req.user, { reason: req.body?.reason });
  res.status(200).json({ success: true, data });
});
