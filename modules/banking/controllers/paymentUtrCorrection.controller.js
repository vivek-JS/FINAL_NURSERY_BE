import catchAsync from "../../../utility/catchAsync.js";
import { correctPendingPaymentUtr } from "../services/paymentUtrCorrection.service.js";

/** POST /api/banking/payments/correct-utr — one correction, pending and not bank-checked. */
export const postCorrectPaymentUtr = catchAsync(async (req, res) => {
  const { source, orderMongoId, paymentId, utrNumber } = req.body || {};
  const result = await correctPendingPaymentUtr({
    source,
    orderMongoId,
    paymentId,
    utrNumber,
    user: req.user,
  });
  if (!result.ok) {
    return res.status(result.status || 400).json({ success: false, message: result.error });
  }
  return res.status(200).json({
    success: true,
    message: "UTR corrected. The previous value is kept on the payment.",
    data: result,
  });
});
