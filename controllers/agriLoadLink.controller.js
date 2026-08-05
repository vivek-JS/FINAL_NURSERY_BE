import catchAsync from "../utility/catchAsync.js";
import AppError from "../utility/appError.js";
import generateResponse from "../utility/responseFormat.js";
import {
  previewAgriLoadLink,
  confirmAgriLoadViaLink,
  notifyAdminsAgriLoadConfirmed,
} from "../services/agriLoadLink.service.js";

const parseAgriOrdersParam = (value) =>
  String(value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

export const getAgriLoadLinkPreview = catchAsync(async (req, res) => {
  const orderRef = req.query.orderRef || req.query.orderNumber || "";
  const agriOrderNumbers = parseAgriOrdersParam(req.query.agriOrders);

  const preview = await previewAgriLoadLink({ orderRef, agriOrderNumbers });
  return res.status(200).json(generateResponse("Success", "Agri load preview", preview, undefined));
});

export const postAgriLoadLinkConfirm = catchAsync(async (req, res, next) => {
  const body = req.body || {};
  const query = req.query || {};
  const orderRef = body.orderRef || query.orderRef || body.orderNumber || query.orderNumber || "";
  const actorPhone = body.actorPhone || query.actorPhone || "";
  const agriOrderNumbers = parseAgriOrdersParam(
    body.agriOrders || query.agriOrders || ""
  );

  try {
    const summary = await confirmAgriLoadViaLink({
      orderRef,
      agriOrderNumbers,
      actorPhone,
    });
    await notifyAdminsAgriLoadConfirmed(summary);

    return res.status(200).json(
      generateResponse("Success", "Linked agri order(s) marked as loaded", summary, undefined)
    );
  } catch (err) {
    return next(new AppError(err.message || "Confirm failed", err.statusCode || 500));
  }
});

/** Legacy GET — redirect to frontend Yes/No page or JSON confirm for old links. */
export const markLinkedAgriLoadedViaLink = catchAsync(async (req, res, next) => {
  const { orderNumber, orderRef, actorPhone, confirm } = req.query || {};
  const ref = orderRef || orderNumber || "";

  if (String(confirm || "").toLowerCase() !== "1" && String(confirm || "").toLowerCase() !== "true") {
    const { buildAgriLoadConfirmPageUrl } = await import("../services/agriLoadLink.service.js");
    const pageUrl = buildAgriLoadConfirmPageUrl({
      orderRef: ref,
      actorPhone,
    });
    if (pageUrl) {
      return res.redirect(302, pageUrl);
    }
  }

  try {
    const summary = await confirmAgriLoadViaLink({
      orderRef: ref,
      actorPhone,
    });
    await notifyAdminsAgriLoadConfirmed(summary);

    const wantsJson =
      req.headers.accept?.includes("application/json") ||
      String(req.query.format || "").toLowerCase() === "json";

    if (wantsJson) {
      return res.status(200).json(
        generateResponse("Success", "Linked agri order(s) marked as loaded", summary, undefined)
      );
    }

    const markedLabel = [...(summary.marked || []), ...(summary.alreadyLoaded || [])].join(", ");
    return res
      .status(200)
      .type("text/html")
      .send(`<h3>Success: ${markedLabel || ref} marked as LOADED.</h3>`);
  } catch (err) {
    if (err.statusCode === 403) {
      return res.status(403).type("text/html").send("<h3>Not authorized for this action.</h3>");
    }
    if (err.statusCode === 404) {
      return res.status(404).type("text/html").send("<h3>Agri order not found.</h3>");
    }
    return next(new AppError(err.message || "Failed", err.statusCode || 500));
  }
});
