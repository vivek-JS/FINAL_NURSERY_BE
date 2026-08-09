import catchAsync from "../utility/catchAsync.js";
import AppError from "../utility/appError.js";
import generateResponse from "../utility/responseFormat.js";
import { generateAndSaveOrderDeliveryChallanPdf } from "../services/orderDeliveryChallanPdf.service.js";
import {
  getOrderUpdateUserContext,
  resolveUserForOrderUpdatePermissions,
} from "../utils/orderUpdatePermissions.js";

export const generateOrderDeliveryChallanPdf = catchAsync(async (req, res, next) => {
  const orderId = req.params.orderId || req.params.id;
  if (!orderId) {
    return next(new AppError("orderId is required", 400));
  }

  const perm = getOrderUpdateUserContext(
    resolveUserForOrderUpdatePermissions(req) || req.user
  );
  if (!perm.canEditOrderCore) {
    return next(new AppError("You are not allowed to generate delivery challan PDFs", 403));
  }

  const force =
    req.query.force === "1" ||
    req.query.force === "true" ||
    Boolean(req.body?.force);

  try {
    const data = await generateAndSaveOrderDeliveryChallanPdf(orderId, {
      force,
      generatedBy: req.user?._id || null,
    });
    const { ensureOrderDispatchWhatsAppOnce } = await import(
      "../services/orderDispatchWhatsApp.service.js"
    );
    const whatsappDispatch = await ensureOrderDispatchWhatsAppOnce(orderId, {
      allowManualResend: false,
    });
    res.status(200).json(
      generateResponse(
        "Success",
        force
          ? "Delivery challan PDF regenerated. Previous PDF kept in history."
          : "Delivery challan PDF ready",
        { ...data, whatsappDispatch }
      )
    );
  } catch (e) {
    return next(new AppError(e.message || "Failed to generate PDF", e.statusCode || 500));
  }
});
