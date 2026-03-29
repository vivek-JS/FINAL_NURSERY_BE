import generateResponse from "../utility/responseFormat.js";
import {
  generateIciciDynamicQr,
  normalizeIciciError,
  saveIciciQrAuditRecord,
} from "../services/iciciQr.service.js";
import { checkPaymentStatus } from "../services/iciciStatus.service.js";
import Order from "../models/order.model.js";
import AgriSalesOrder from "../models/agriSalesOrder.model.js";
import IciciQrTransaction from "../models/iciciQrTransaction.model.js";

function matchesMerchantTranId(p, mtid) {
  const m = String(mtid).trim();
  return (
    (p.merchantTranId && String(p.merchantTranId).trim() === m) ||
    (p.qrReferenceId && String(p.qrReferenceId).trim() === m)
  );
}

/**
 * Apply EazyPay status API result to an embedded payment subdocument (QR flow).
 */
function applyTxnStatusToPayment(p, result) {
  p.bankRawResponse = result.raw ?? result;
  if (p.paymentStatus === "COLLECTED" || p.paymentStatus === "REJECTED") {
    return;
  }
  if (result.status === "SUCCESS") {
    p.bankVerificationStatus = "BANK_VERIFIED";
    p.bankVerificationSource = "TXN_STATUS_API";
    if (result.providerTxnId) {
      p.providerTxnId = String(result.providerTxnId);
    }
    p.paymentStatus = "BANK_VERIFIED";
    p.bankReconciliationConflict = false;
    return;
  }
  if (result.status === "FAILED" || result.status === "EXPIRED") {
    p.bankVerificationStatus = "VERIFY_FAILED";
    p.bankVerificationSource = "TXN_STATUS_API";
    return;
  }
  p.bankVerificationStatus = "PENDING";
}

/**
 * GET /api/payments/icici/status/:merchantTranId
 * Polls ICICI EazyPay status and updates Order / Agri payment rows + audit doc when matched.
 */
export async function getIciciPaymentStatus(req, res) {
  try {
    const { merchantTranId } = req.params;
    const result = await checkPaymentStatus(merchantTranId);
    const mtid = String(merchantTranId).trim();

    let orderUpdated = false;
    let agriUpdated = false;

    const order = await Order.findOne({
      payment: {
        $elemMatch: {
          $or: [{ merchantTranId: mtid }, { qrReferenceId: mtid }],
        },
      },
    });
    if (order) {
      for (const p of order.payment || []) {
        if (!matchesMerchantTranId(p, mtid)) continue;
        applyTxnStatusToPayment(p, result);
      }
      order.markModified("payment");
      await order.save();
      orderUpdated = true;
    }

    const agri = await AgriSalesOrder.findOne({
      payment: {
        $elemMatch: {
          $or: [{ merchantTranId: mtid }, { qrReferenceId: mtid }],
        },
      },
    });
    if (agri) {
      for (const p of agri.payment || []) {
        if (!matchesMerchantTranId(p, mtid)) continue;
        applyTxnStatusToPayment(p, result);
      }
      agri.markModified("payment");
      await agri.save();
      agriUpdated = true;
    }

    let auditUpdated = false;
    const audit = await IciciQrTransaction.findOne({ merchantTranId: mtid });
    if (audit) {
      if (result.status === "SUCCESS") audit.status = "PAID";
      else if (result.status === "EXPIRED") audit.status = "EXPIRED";
      else if (result.status === "FAILED") audit.status = "FAILED";
      audit.responsePayload = result.raw ?? result;
      await audit.save();
      auditUpdated = true;
    }

    const data = {
      status: result.status,
      merchantTranId: result.merchantTranId,
      providerTxnId: result.providerTxnId,
      amount: result.amount,
      orderUpdated,
      agriUpdated,
      auditUpdated,
    };

    return res.status(200).json(generateResponse("Success", "Status fetched", data, null));
  } catch (err) {
    const n = normalizeIciciError(err);
    return res
      .status(n.httpStatus)
      .json(generateResponse("Fail", n.message, null, { code: n.code }));
  }
}

/**
 * POST /api/payments/icici/qr
 * Body: { orderId, amount }
 */
export async function generateQr(req, res) {
  try {
    const { orderId, amount } = req.body;
    const result = await generateIciciDynamicQr({ orderId, amount });

    const data = {
      merchantTranId: result.merchantTranId,
      orderId: result.orderId,
      amount: result.amount,
      qrString: result.qrString,
      qrImageBase64: result.qrImageBase64,
      expiresAt: result.expiresAt,
    };

    await saveIciciQrAuditRecord({
      orderId: result.orderId,
      merchantTranId: result.merchantTranId,
      amount: Number(amount),
      context: "STANDALONE",
      qrPayload: { qrString: result.qrString, qrImageBase64: result.qrImageBase64 },
      requestPayload: result.requestPayload,
      responsePayload: result.raw,
      expiresAt: new Date(result.expiresAt),
    });

    return res.status(200).json(generateResponse("Success", "QR generated", data, null));
  } catch (err) {
    const n = normalizeIciciError(err);
    return res
      .status(n.httpStatus)
      .json(generateResponse("Fail", n.message, null, { code: n.code }));
  }
}
