import crypto from "crypto";
import mongoose from "mongoose";
import RateChangeRequest from "../models/rateChangeRequest.model.js";
import Order from "../models/order.model.js";
import User from "../models/user.model.js";
import generateResponse from "../utility/responseFormat.js";
import catchAsync from "../utility/catchAsync.js";
import { sendWhatsAppMessage, getAdminNumbersFromEnv } from "../services/whatsappAlertService.js";
import { normalizePhoneForWhitelist } from "../utils/agriLoadLinkSigner.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const isSuperAdminUser = (user) => {
  if (!user) return false;
  const role = String(user.role || "").toUpperCase().trim();
  const jt = String(user.jobTitle || "").toUpperCase().trim();
  return role === "SUPER_ADMIN" || role === "SUPERADMIN" || jt === "SUPER_ADMIN" || jt === "SUPERADMIN";
};

const generateToken = () => crypto.randomBytes(32).toString("hex");

const normalizePhone = (value = "") => {
  const digits = String(value).replace(/\D/g, "");
  if (digits.length >= 12 && digits.startsWith("91")) return digits.slice(2);
  if (digits.length === 10) return digits;
  return digits;
};

// ---------------------------------------------------------------------------
// Internal utility — called from factory.controller.js when intercepting a
// rate change by a non-super-admin user. Returns the saved request doc.
// ---------------------------------------------------------------------------

export async function createRateChangeRequest({ orderId, previousRate, requestedRate, requestedBy, notes = "", session = null }) {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

  const order = await Order.findById(orderId)
    .populate("farmer", "name mobileNumber")
    .session(session || null)
    .lean();

  const snapshot = {
    orderId: order?.orderId || null,
    farmerName: order?.orderFor?.name || order?.farmer?.name || "",
    farmerMobile: String(order?.orderFor?.mobileNumber || order?.farmer?.mobileNumber || ""),
    village: order?.orderFor?.village || "",
    plantName: order?.plantName || "",
    numberOfPlants: order?.numberOfPlants || null,
  };

  const requestDoc = await RateChangeRequest.create(
    [
      {
        orderId,
        requestedBy,
        previousRate,
        requestedRate,
        notes,
        approvalToken: token,
        tokenExpiresAt: expiresAt,
        orderSnapshot: snapshot,
      },
    ],
    session ? { session } : {}
  );

  const savedRequest = Array.isArray(requestDoc) ? requestDoc[0] : requestDoc;

  // Link pending request on the order
  await Order.findByIdAndUpdate(
    orderId,
    { pendingRateChangeRequestId: savedRequest._id },
    session ? { session } : {}
  );

  // Send WhatsApp alerts to all super admin numbers
  await sendRateChangeWhatsAppAlerts(savedRequest, snapshot, token);

  return savedRequest;
}

// ---------------------------------------------------------------------------
// WhatsApp alert — one message per super admin number, each with their phone
// embedded in the approval link so the backend can verify identity
// ---------------------------------------------------------------------------

async function sendRateChangeWhatsAppAlerts(request, snapshot, token) {
  try {
    const frontendUrl = String(
      process.env.FRONTEND_URL || process.env.PUBLIC_ACTION_BASE_URL || "https://erp.rambiotechplants.com"
    ).replace(/\/$/, "");

    const adminNumbers = getAdminNumbersFromEnv();
    if (adminNumbers.length === 0) {
      console.warn("[RateChangeRequest] No admin numbers configured — skipping WhatsApp alert");
      return;
    }

    await Promise.allSettled(
      adminNumbers.map(async (waId) => {
        // waId is formatted as 919876543210@c.us  — strip @c.us for URL param
        const phoneRaw = waId.replace("@c.us", "");
        const approvalUrl = `${frontendUrl}/rate-approval?token=${token}&phone=${encodeURIComponent(phoneRaw)}`;

        const farmerName = snapshot.farmerName || "—";
        const village = snapshot.village || "—";
        const plantName = snapshot.plantName || "—";
        const qty = snapshot.numberOfPlants ?? "—";
        const orderNo = snapshot.orderId ?? "—";

        const message = [
          "📋 *Rate Change Approval Request*",
          `Order #${orderNo} | ${farmerName}, ${village}`,
          `Plant: ${plantName} x ${qty}`,
          `Current Rate: ₹${request.previousRate} → Requested: ₹${request.requestedRate}`,
          "",
          "✅ Approve (valid 24 hrs):",
          approvalUrl,
        ].join("\n");

        await sendWhatsAppMessage(phoneRaw, message);
      })
    );
  } catch (err) {
    console.error("[RateChangeRequest] WhatsApp alert error:", err?.message || err);
  }
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/**
 * GET /api/v1/rate-change-requests
 * List all rate change requests (SUPER_ADMIN only).
 * Supports ?status=PENDING|APPROVED|REJECTED|EXPIRED&orderId=...
 */
export const getRateChangeRequests = catchAsync(async (req, res) => {
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  if (req.query.orderId && mongoose.isValidObjectId(req.query.orderId)) {
    filter.orderId = req.query.orderId;
  }

  const requests = await RateChangeRequest.find(filter)
    .sort({ createdAt: -1 })
    .limit(100)
    .populate("requestedBy", "name jobTitle role phoneNumber")
    .populate("approvedBy", "name jobTitle role")
    .populate("rejectedBy", "name jobTitle role")
    .populate("orderId", "orderId plantName orderFor farmer numberOfPlants rate")
    .lean();

  return res.status(200).json(
    generateResponse("success", "Rate change requests fetched", requests, null)
  );
});

/**
 * GET /api/v1/rate-change-requests/by-token/:token
 * Fetch a single request by approval token (used by the public approval page).
 * No JWT required — returns only safe fields.
 */
export const getRequestByToken = catchAsync(async (req, res) => {
  const { token } = req.params;
  if (!token) {
    return res.status(400).json(generateResponse("error", "Token is required", null, null));
  }

  const request = await RateChangeRequest.findOne({ approvalToken: token })
    .populate("requestedBy", "name jobTitle")
    .lean();

  if (!request) {
    return res.status(404).json(generateResponse("error", "Request not found", null, null));
  }

  const now = new Date();
  if (request.status === "PENDING" && now > new Date(request.tokenExpiresAt)) {
    await RateChangeRequest.findByIdAndUpdate(request._id, { status: "EXPIRED" });
    request.status = "EXPIRED";
  }

  // Return only safe fields (no token in response)
  const safe = {
    _id: request._id,
    status: request.status,
    previousRate: request.previousRate,
    requestedRate: request.requestedRate,
    tokenExpiresAt: request.tokenExpiresAt,
    orderSnapshot: request.orderSnapshot,
    requestedBy: request.requestedBy,
    createdAt: request.createdAt,
    rejectionReason: request.rejectionReason,
  };

  return res.status(200).json(generateResponse("success", "Request fetched", safe, null));
});

/**
 * PATCH /api/v1/rate-change-requests/:id/approve
 * Super admin approves via the UI (JWT-authenticated).
 */
export const approveViaUI = catchAsync(async (req, res) => {
  if (!isSuperAdminUser(req.user)) {
    return res.status(403).json(generateResponse("error", "Only Super Admin can approve rate changes", null, null));
  }

  const request = await RateChangeRequest.findById(req.params.id);
  if (!request) {
    return res.status(404).json(generateResponse("error", "Request not found", null, null));
  }

  if (request.status !== "PENDING") {
    return res.status(400).json(
      generateResponse("error", `Request is already ${request.status}`, null, null)
    );
  }

  if (new Date() > request.tokenExpiresAt) {
    await request.save(); // will not update status here — just informational
    return res.status(400).json(generateResponse("error", "Request has expired", null, null));
  }

  await applyRateChangeApproval(request, req.user._id, res);
});

/**
 * PATCH /api/v1/rate-change-requests/:id/reject
 * Super admin rejects via the UI (JWT-authenticated).
 */
export const rejectViaUI = catchAsync(async (req, res) => {
  if (!isSuperAdminUser(req.user)) {
    return res.status(403).json(generateResponse("error", "Only Super Admin can reject rate changes", null, null));
  }

  const { rejectionReason = "" } = req.body;
  const request = await RateChangeRequest.findById(req.params.id);
  if (!request) {
    return res.status(404).json(generateResponse("error", "Request not found", null, null));
  }

  if (request.status !== "PENDING") {
    return res.status(400).json(
      generateResponse("error", `Request is already ${request.status}`, null, null)
    );
  }

  request.status = "REJECTED";
  request.rejectedBy = req.user._id;
  request.rejectedAt = new Date();
  request.rejectionReason = rejectionReason;
  await request.save();

  // Clear pending flag on the order
  await Order.findByIdAndUpdate(request.orderId, { pendingRateChangeRequestId: null });

  return res.status(200).json(
    generateResponse("success", "Rate change request rejected", { requestId: request._id }, null)
  );
});

/**
 * POST /api/v1/rate-change-requests/approve-via-link
 * No JWT required. Body: { token, phone }
 * Backend checks: token valid + not expired + phone belongs to a SUPER_ADMIN user.
 */
export const approveViaToken = catchAsync(async (req, res) => {
  const { token, phone } = req.body;

  if (!token || !phone) {
    return res.status(400).json(generateResponse("error", "token and phone are required", null, null));
  }

  // Verify the phone belongs to a super admin
  const normalizedPhone = normalizePhone(phone);
  const superAdminUser = await User.findOne({
    phoneNumber: { $in: [Number(normalizedPhone), Number(`91${normalizedPhone}`)] },
  }).lean();

  if (!superAdminUser || !isSuperAdminUser(superAdminUser)) {
    return res.status(403).json(
      generateResponse("error", "This phone number is not authorized to approve rate changes", null, null)
    );
  }

  const request = await RateChangeRequest.findOne({ approvalToken: token });
  if (!request) {
    return res.status(404).json(generateResponse("error", "Invalid or expired link", null, null));
  }

  if (request.status !== "PENDING") {
    return res.status(400).json(
      generateResponse("error", `This request has already been ${request.status.toLowerCase()}`, null, null)
    );
  }

  if (new Date() > request.tokenExpiresAt) {
    request.status = "EXPIRED";
    await request.save();
    return res.status(400).json(generateResponse("error", "This approval link has expired (24-hour window passed)", null, null));
  }

  await applyRateChangeApproval(request, superAdminUser._id, res);
});

// ---------------------------------------------------------------------------
// Shared approval logic
// ---------------------------------------------------------------------------

async function applyRateChangeApproval(request, approvedByUserId, res) {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const order = await Order.findById(request.orderId).session(session);
    if (!order) {
      await session.abortTransaction();
      return res.status(404).json(generateResponse("error", "Order not found", null, null));
    }

    // Apply the rate
    const previousRate = order.rate;
    order.rate = request.requestedRate;

    // Append to orderEditHistory
    order.orderEditHistory = order.orderEditHistory || [];
    order.orderEditHistory.push({
      field: "rate",
      previousValue: previousRate,
      newValue: request.requestedRate,
      changedBy: approvedByUserId,
      notes: `Rate changed from ₹${previousRate} to ₹${request.requestedRate} (approved by Super Admin)`,
    });

    // Clear pending flag
    order.pendingRateChangeRequestId = null;

    await order.save({ session });

    // Mark request approved
    request.status = "APPROVED";
    request.approvedBy = approvedByUserId;
    request.approvedAt = new Date();
    await request.save({ session });

    await session.commitTransaction();

    return res.status(200).json(
      generateResponse(
        "success",
        `Rate change approved. Order rate updated to ₹${request.requestedRate}`,
        {
          requestId: request._id,
          orderId: order._id,
          newRate: request.requestedRate,
        },
        null
      )
    );
  } catch (err) {
    await session.abortTransaction();
    throw err;
  } finally {
    session.endSession();
  }
}
