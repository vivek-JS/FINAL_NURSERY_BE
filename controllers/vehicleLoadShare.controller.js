import mongoose from "mongoose";
import catchAsync from "../utility/catchAsync.js";
import AppError from "../utility/appError.js";
import generateResponse from "../utility/responseFormat.js";
import { findDispatchActiveByIdOrTransport } from "../services/secondaryVehicleLoad.service.js";
import { appendVehicleLoadPhotos } from "../services/vehicleLoadPhotos.service.js";
import { scheduleEnsureOrderDispatchWhatsApp } from "../services/orderDispatchWhatsApp.service.js";

/** Photos for a load, saved after the load itself so the load response stays fast. */
export const postVehicleLoadPhotos = catchAsync(async (req, res, next) => {
  const doc = await findDispatchActiveByIdOrTransport(req.params.dispatchId);
  if (!doc) return next(new AppError("Vehicle dispatch not found", 404));
  const userId = req.user?._id || req.user?.id;
  const photoSave = await appendVehicleLoadPhotos({
    dispatchId: doc._id,
    files: req.files,
    plantsLoaded: req.body?.plantsLoaded,
    remarks: req.body?.remarks,
    performedBy: userId && mongoose.isValidObjectId(String(userId)) ? userId : undefined,
  });
  return res.status(200).json(
    generateResponse("Success", "Load photos saved", { photoUrls: photoSave.urls }, undefined)
  );
});

/** Queue the farmer dispatch WhatsApp for every order on this vehicle. Does not wait for WATI. */
export const postShootDispatchWhatsApp = catchAsync(async (req, res, next) => {
  const doc = await findDispatchActiveByIdOrTransport(req.params.dispatchId);
  if (!doc) return next(new AppError("Vehicle dispatch not found", 404));
  const orderIds = [
    ...new Set(
      (doc.orderDispatchDetails || [])
        .map((d) => String(d.orderId || "").trim())
        .filter((id) => mongoose.isValidObjectId(id))
    ),
  ];
  for (const orderId of orderIds) scheduleEnsureOrderDispatchWhatsApp(orderId);
  return res.status(200).json(
    generateResponse("Success", "Dispatch message queued", { orders: orderIds.length }, undefined)
  );
});
