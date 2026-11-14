import mongoose from "mongoose";
import User from "../models/user.model.js";
import Dispatch from "../models/dispatch.model.js";
import AppError from "../utility/appError.js";
import { persistInboxOnce } from "../utility/notificationInbox.js";
import { sendFcmNotification } from "../utility/fcmPush.js";
import { sendCustomNotification } from "../utility/pushNotification.js";

export function jobOf(user) {
  return String(user?.jobTitle || user?.role || "")
    .toUpperCase()
    .replace(/[\s-]+/g, "_");
}

/** Shed dispatch employee. Not the dispatch manager. */
export function isDispatchEmployee(user) {
  return jobOf(user) === "DISPATCH";
}

/** Dispatch manager, secondary, admin, or super admin may assign a vehicle. */
export function canAssignDispatch(user) {
  const job = jobOf(user);
  return (
    job === "DISPATCH_MANAGER" ||
    job === "SECONDARY" ||
    job === "ADMIN" ||
    job === "SUPER_ADMIN" ||
    job === "SUPERADMIN"
  );
}

function assignsOwnTeam(user) {
  const job = jobOf(user);
  return job === "DISPATCH_MANAGER" || job === "SECONDARY";
}

function plantCount(dispatch) {
  const fromOrders = (dispatch.orderDispatchDetails || []).reduce(
    (sum, row) => sum + (Number(row.dispatchQuantity) || 0),
    0
  );
  if (fromOrders > 0) return fromOrders;
  return (dispatch.plantsDetails || []).reduce(
    (sum, row) => sum + (Number(row.quantity ?? row.totalPlants) || 0),
    0
  );
}

/**
 * Employees who can receive a vehicle.
 * Secondary and dispatch manager only see people who report to them.
 * Admin and super admin see every dispatch employee.
 */
export async function listDispatchAssignees(actor) {
  if (!canAssignDispatch(actor)) {
    throw new AppError("Only a dispatch manager or admin can assign vehicles", 403);
  }
  const filter = {
    isDisabled: { $ne: true },
    $or: [{ jobTitle: "DISPATCH" }, { role: "DISPATCH" }],
  };
  if (assignsOwnTeam(actor)) {
    filter.reportsTo = actor._id;
  }
  const rows = await User.find(filter)
    .select("name phoneNumber")
    .sort({ name: 1 })
    .lean();
  return rows.map((row) => ({
    _id: row._id,
    name: row.name,
    phoneNumber: row.phoneNumber,
  }));
}

/** Dispatch employees may open only vehicles assigned to them. Everyone else is unchanged. */
export async function assertDispatchVisible(user, dispatchId) {
  if (!isDispatchEmployee(user)) return;
  const raw = String(dispatchId || "").trim();
  if (!raw) throw new AppError("This vehicle is not assigned to you", 403);
  const query = {
    isDeleted: { $ne: true },
    assignedTo: user._id,
  };
  if (mongoose.isValidObjectId(raw)) query._id = raw;
  else query.transportId = raw;
  const doc = await Dispatch.findOne(query).select("_id").lean();
  if (!doc) throw new AppError("This vehicle is not assigned to you", 403);
}

async function notifyAssignee(employee, dispatch) {
  const title = "गाडी तुमच्याकडे · Vehicle assigned";
  const plants = plantCount(dispatch);
  const where = [dispatch.vehicleNumber, dispatch.driverName].filter(Boolean).join(" · ");
  const body = [
    dispatch.transportId ? `#${dispatch.transportId}` : "",
    where,
    plants > 0 ? `${plants} plants` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const data = {
    dispatchId: String(dispatch._id),
    transportId: String(dispatch.transportId || ""),
    kind: "dispatch_assigned",
  };
  await persistInboxOnce({
    userId: employee._id,
    title,
    body: body || "Vehicle assigned",
    type: "dispatch_assigned",
    data,
    dedupeKey: `dispatch:${dispatch._id}:assigned:${employee._id}:${Date.now()}`,
  });
  const pushData = { type: "dispatch_assigned", ...data };
  if (employee.fcmToken) {
    try {
      await sendFcmNotification({
        token: employee.fcmToken,
        title,
        body: body || "Vehicle assigned",
        data: pushData,
      });
    } catch (err) {
      console.error("[dispatchAssign] fcm failed:", err?.message || err);
    }
  }
  if (!employee.expoPushToken) return;
  try {
    await sendCustomNotification(employee.expoPushToken, title, body || "Vehicle assigned", pushData);
  } catch (err) {
    console.error("[dispatchAssign] push failed:", err?.message || err);
  }
}

export async function assignVehicleDispatch({ dispatchId, userId, actor }) {
  if (!canAssignDispatch(actor)) {
    throw new AppError("Only a dispatch manager or admin can assign vehicles", 403);
  }
  if (!mongoose.isValidObjectId(String(dispatchId || ""))) {
    throw new AppError("Vehicle dispatch not found", 404);
  }
  if (!mongoose.isValidObjectId(String(userId || ""))) {
    throw new AppError("Choose a dispatch employee", 400);
  }

  const employee = await User.findOne({
    _id: userId,
    isDisabled: { $ne: true },
    $or: [{ jobTitle: "DISPATCH" }, { role: "DISPATCH" }],
  })
    .select("name phoneNumber reportsTo expoPushToken fcmToken")
    .lean();
  if (!employee) throw new AppError("That person is not a dispatch employee", 400);
  if (assignsOwnTeam(actor) && String(employee.reportsTo || "") !== String(actor._id)) {
    throw new AppError("You can only assign employees who report to you", 403);
  }

  const dispatch = await Dispatch.findOne({ _id: dispatchId, isDeleted: { $ne: true } });
  if (!dispatch) throw new AppError("Vehicle dispatch not found", 404);

  const assignedAt = new Date();
  const changed = await Dispatch.findOneAndUpdate(
    {
      _id: dispatch._id,
      isDeleted: { $ne: true },
      assignedTo: { $ne: employee._id },
    },
    {
      $set: {
        assignedTo: employee._id,
        assignedBy: actor._id,
        assignedAt,
      },
    }
  );
  if (changed) {
    dispatch.assignedAt = assignedAt;
    await notifyAssignee(employee, dispatch);
  }

  return {
    dispatchId: dispatch._id,
    assignedTo: { _id: employee._id, name: employee.name },
    assignedToName: employee.name,
    assignedAt: dispatch.assignedAt,
  };
}
