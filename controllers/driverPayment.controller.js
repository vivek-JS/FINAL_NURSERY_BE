import mongoose from "mongoose";
import catchAsync from "../utility/catchAsync.js";
import AppError from "../utility/appError.js";
import generateResponse from "../utility/responseFormat.js";
import { listDriverPayments, recordDriverPay } from "../services/driverPayment.service.js";

const ok = (res, message, data, code = 200) =>
  res.status(code).json(generateResponse("Success", message, data, undefined));

export const listPayments = catchAsync(async (req, res) => {
  const data = await listDriverPayments({
    status: req.query.status,
    search: req.query.search,
    page: req.query.page,
    limit: req.query.limit,
  });
  return ok(res, "Driver payments fetched", data);
});

export const addPay = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) return next(new AppError("Invalid driver payment id", 400));
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const row = await recordDriverPay({
      id,
      amount: req.body?.amount,
      receiptNumber: req.body?.receiptNumber,
      utrNumber: req.body?.utrNumber || req.body?.transactionId,
      chequeNumber: req.body?.chequeNumber,
      bankName: req.body?.bankName,
      receiptPayeeName: req.body?.receiptPayeeName,
      receiptPhoto: req.body?.receiptPhoto,
      paidAt: req.body?.paidAt || req.body?.paymentDate,
      mode: req.body?.mode || req.body?.modeOfPayment,
      note: req.body?.note || req.body?.remark,
      user: req.user,
      session,
    });
    await session.commitTransaction();
    return ok(res, "Driver payment recorded", row);
  } catch (err) {
    await session.abortTransaction();
    return next(err);
  } finally {
    session.endSession();
  }
});
