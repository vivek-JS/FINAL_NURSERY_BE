import mongoose from "mongoose";
import AppError from "../utility/appError.js";
import Dispatch from "../models/dispatch.model.js";
import FreightSlip from "../models/freightSlip.model.js";
import VehicleOwner from "../models/vehicleOwner.model.js";
import DriverPayment, { DRIVER_PAY_MODES } from "../models/driverPayment.model.js";
import { round2 } from "../utility/freightQuote.js";

const withSession = (q, session) => (session ? q.session(session) : q);

const userName = (u) =>
  u?.name || [u?.firstName, u?.lastName].filter(Boolean).join(" ") || u?.phoneNumber || "";

function normalizePayMode(mode) {
  const key = String(mode || "")
    .toUpperCase()
    .replace(/[\s/_-]/g, "");
  if (key === "CASH") return "CASH";
  if (key === "UPI") return "UPI";
  if (key === "CHEQUE") return "CHEQUE";
  if (key === "NEFT" || key === "NEFTRTGS" || key === "RTGS") return "NEFT";
  if (key === "OTHER") return "OTHER";
  return "";
}

function photoList(v) {
  if (Array.isArray(v)) return v.map((u) => String(u || "").trim()).filter(Boolean);
  if (typeof v === "string" && v.trim()) return [v.trim()];
  return [];
}

export function displaySlipNumber(raw) {
  return String(raw || "").replace(/^FS-/i, "").trim();
}

export function statusOf(amount, paid) {
  const due = round2(Number(amount) || 0);
  const got = round2(Number(paid) || 0);
  if (got <= 0) return "UNPAID";
  if (got + 0.009 < due) return "PARTIAL";
  return "PAID";
}

function shape(doc) {
  if (!doc) return null;
  const row = typeof doc.toObject === "function" ? doc.toObject() : { ...doc };
  const amount = round2(Number(row.amount) || 0);
  const paidAmount = round2(Number(row.paidAmount) || 0);
  const populatedSlip =
    row.freightSlipId && typeof row.freightSlipId === "object" && row.freightSlipId._id
      ? row.freightSlipId
      : row.freightSlip || null;
  const freightSlipId = populatedSlip
    ? String(populatedSlip._id)
    : row.freightSlipId
      ? String(row.freightSlipId)
      : null;
  return {
    ...row,
    id: String(row._id),
    freightSlipId,
    freightSlip: populatedSlip,
    dispatchId: row.dispatchId ? String(row.dispatchId) : "",
    slipNumber: displaySlipNumber(row.slipNumber),
    amount,
    paidAmount,
    due: round2(Math.max(0, amount - paidAmount)),
    status: statusOf(amount, paidAmount),
  };
}

export async function ensureDriverPayment({ dispatchId, dispatch, slip, user, session = null }) {
  const id = dispatchId || dispatch?._id;
  if (!id || !mongoose.isValidObjectId(String(id))) return null;

  const existing = await withSession(DriverPayment.findOne({ dispatchId: id }), session);
  if (existing) return shape(existing);

  const d =
    dispatch ||
    (await withSession(Dispatch.findById(id).select("transportId vehicleId vehicleName vehicleNumber ownerId driverId driverName driverMobile"), session).lean());
  if (!d) return null;

  const s =
    slip ||
    (await withSession(FreightSlip.findOne({ dispatchId: id }), session).lean());
  if (!s || s.status !== "FINAL") return null;

  const entry = s.final || s.tentative || {};
  let ownerName = "";
  if (d.ownerId) {
    const owner = await withSession(VehicleOwner.findById(d.ownerId).select("name"), session).lean();
    ownerName = owner?.name || "";
  }

  const [doc] = await DriverPayment.create(
    [
      {
        dispatchId: d._id || id,
        freightSlipId: s._id || null,
        slipNumber: displaySlipNumber(s.slipNumber) || s.slipNumber || "",
        slipDate: s.slipDate || s.createdAt || null,
        transportId: d.transportId || s.transportId || "",
        vehicleId: d.vehicleId || null,
        vehicleName: d.vehicleName || s.vehicleName || "",
        vehicleNumber: d.vehicleNumber || s.vehicleNumber || "",
        ownerId: d.ownerId || null,
        ownerName,
        driverId: d.driverId || null,
        driverName: d.driverName || s.driverName || "",
        driverMobile: d.driverMobile || s.driverMobile || "",
        amount: round2(Number(entry.totalAmount) || 0),
        paidAmount: 0,
        status: "UNPAID",
        finalizedAt: entry.at || new Date(),
        payments: [],
      },
    ],
    { session }
  );
  return shape(doc);
}

export async function listDriverPayments({ status, search, page = 1, limit = 50 } = {}) {
  const filter = {};
  const st = String(status || "").toUpperCase();
  if (["UNPAID", "PARTIAL", "PAID"].includes(st)) filter.status = st;

  const q = String(search || "").trim();
  if (q) {
    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filter.$or = [
      { slipNumber: rx },
      { transportId: rx },
      { vehicleNumber: rx },
      { vehicleName: rx },
      { ownerName: rx },
      { driverName: rx },
      { driverMobile: rx },
    ];
  }

  const skip = (Math.max(1, Number(page) || 1) - 1) * Math.min(100, Math.max(1, Number(limit) || 50));
  const take = Math.min(100, Math.max(1, Number(limit) || 50));

  const [rows, total, agg] = await Promise.all([
    DriverPayment.find(filter)
      .populate("freightSlipId")
      .sort({ finalizedAt: -1, createdAt: -1 })
      .skip(skip)
      .limit(take)
      .lean(),
    DriverPayment.countDocuments(filter),
    DriverPayment.aggregate([
      {
        $group: {
          _id: "$status",
          count: { $sum: 1 },
          amount: { $sum: "$amount" },
          paid: { $sum: "$paidAmount" },
        },
      },
    ]),
  ]);

  const summary = {
    unpaidCount: 0,
    unpaidSum: 0,
    partialCount: 0,
    partialSum: 0,
    paidCount: 0,
    paidSum: 0,
    dueSum: 0,
    totalCount: 0,
  };
  for (const row of agg) {
    const count = Number(row.count) || 0;
    const amount = round2(Number(row.amount) || 0);
    const paid = round2(Number(row.paid) || 0);
    summary.totalCount += count;
    if (row._id === "UNPAID") {
      summary.unpaidCount = count;
      summary.unpaidSum = amount;
      summary.dueSum = round2(summary.dueSum + amount - paid);
    } else if (row._id === "PARTIAL") {
      summary.partialCount = count;
      summary.partialSum = round2(amount - paid);
      summary.dueSum = round2(summary.dueSum + amount - paid);
    } else if (row._id === "PAID") {
      summary.paidCount = count;
      summary.paidSum = paid;
    }
  }

  return {
    rows: rows.map(shape),
    summary,
    pagination: {
      page: Math.max(1, Number(page) || 1),
      limit: take,
      total,
      totalPages: Math.max(1, Math.ceil(total / take)),
    },
  };
}

export async function recordDriverPay({
  id,
  amount,
  receiptNumber,
  utrNumber,
  chequeNumber,
  bankName,
  receiptPayeeName,
  receiptPhoto,
  paidAt,
  mode,
  note,
  user,
  session = null,
}) {
  if (!mongoose.isValidObjectId(String(id))) throw new AppError("Invalid driver payment id", 400);
  const doc = await withSession(DriverPayment.findById(id), session);
  if (!doc) throw new AppError("Driver payment not found", 404);

  const due = round2(Math.max(0, round2(doc.amount) - round2(doc.paidAmount)));
  if (due <= 0) throw new AppError("This slip is fully paid", 400);

  const payAmt = round2(Number(amount));
  if (!Number.isFinite(payAmt) || payAmt <= 0) throw new AppError("Enter a payment amount", 400);
  if (Math.abs(payAmt - due) > 0.009) {
    throw new AppError(`Amount is fixed to remaining due ${due}`, 400);
  }

  const receipt = String(receiptNumber || "").trim();
  const utr = String(utrNumber || "").trim();
  const when = paidAt ? new Date(paidAt) : new Date();
  if (Number.isNaN(when.getTime())) throw new AppError("Invalid payment date", 400);

  const payMode = normalizePayMode(mode) || "CASH";
  if (!DRIVER_PAY_MODES.includes(payMode)) throw new AppError("Invalid payment mode", 400);
  if (payMode === "UPI" && !utr) throw new AppError("UTR required for UPI", 400);

  doc.payments.push({
    amount: payAmt,
    receiptNumber: receipt,
    utrNumber: utr,
    chequeNumber: String(chequeNumber || "").trim(),
    bankName: String(bankName || "").trim(),
    receiptPayeeName: String(receiptPayeeName || "").trim(),
    receiptPhoto: photoList(receiptPhoto),
    paidAt: when,
    mode: payMode,
    note: String(note || "").trim(),
    paidBy: user?._id || null,
    paidByName: userName(user),
  });
  doc.paidAmount = round2((Number(doc.paidAmount) || 0) + payAmt);
  doc.status = statusOf(doc.amount, doc.paidAmount);
  await doc.save({ session });
  const out = doc.toObject();
  if (doc.freightSlipId) {
    const slip = await withSession(FreightSlip.findById(doc.freightSlipId), session).lean();
    if (slip) out.freightSlipId = slip;
  }
  return shape(out);
}
