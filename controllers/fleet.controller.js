import mongoose from "mongoose";
import catchAsync from "../utility/catchAsync.js";
import AppError from "../utility/appError.js";
import generateResponse from "../utility/responseFormat.js";
import Dispatch from "../models/dispatch.model.js";

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tripVehicleCost(trip) {
  if (!trip) return null;
  const rent = Number(trip.rent) || 0;
  const other = Number(trip.otherCharges) || 0;
  if (rent === 0 && other === 0 && trip.kmRun == null) return null;
  return Math.round((rent + other) * 100) / 100;
}

function mapOwner(doc) {
  if (!doc) return null;
  return { _id: doc._id, name: doc.name || "", mobile: doc.mobile || "" };
}

function mapDriver(doc, dispatch) {
  if (doc?._id) {
    return { _id: doc._id, name: doc.name || "", mobile: doc.mobile || "" };
  }
  if (dispatch?.driverName) {
    return {
      _id: dispatch.driverId || null,
      name: dispatch.driverName,
      mobile: dispatch.driverMobile || "",
    };
  }
  return null;
}

function mapVehicle(doc, dispatch) {
  if (doc?._id) {
    return {
      _id: doc._id,
      name: doc.name || "",
      number: doc.number || "",
      capacity: doc.capacity ?? null,
    };
  }
  if (dispatch?.vehicleName || dispatch?.vehicleNumber) {
    return {
      _id: dispatch.vehicleId || null,
      name: dispatch.vehicleName || "",
      number: dispatch.vehicleNumber || "",
      capacity: null,
    };
  }
  return null;
}

function mapTrip(doc) {
  if (!doc) return null;
  return {
    _id: doc._id,
    tripNumber: doc.tripNumber || "",
    status: doc.status || "",
    kmRun: doc.kmRun ?? null,
    rent: doc.rent ?? null,
    otherCharges: doc.otherCharges ?? null,
    tripRemark: doc.tripRemark || "",
    startDate: doc.startDate,
    endDate: doc.endDate,
    totalPlants: doc.totalPlants ?? 0,
    totalCrates: doc.totalCrates ?? 0,
    vehicleCostTotal: tripVehicleCost(doc),
  };
}

function mapOrders(orderIds = []) {
  return orderIds.map((o) => ({
    _id: o._id,
    orderId: o.orderId,
    orderStatus: o.orderStatus,
    numberOfPlants: o.numberOfPlants,
    freightCharges: Math.max(0, Number(o.freightCharges) || 0),
    farmerName: o.farmer?.name || "",
    village: o.farmer?.village || "",
    mobile: o.farmer?.mobileNumber || "",
  }));
}

/**
 * Paginated dispatch + trip + fleet assignment ledger for the Fleet module.
 * GET /api/v1/fleet/ledger?page&limit&transportStatus&search
 */
export const getFleetLedger = catchAsync(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const search = String(req.query.search || "").trim();
  const transportStatus = String(req.query.transportStatus || "").trim();

  const filter = { isDeleted: false };
  if (transportStatus) {
    filter.transportStatus = transportStatus;
  }
  if (search) {
    const rx = new RegExp(escapeRegex(search), "i");
    filter.$or = [
      { transportId: rx },
      { vehicleNumber: rx },
      { vehicleName: rx },
      { driverName: rx },
      { routeId: rx },
      { routeNotes: rx },
    ];
  }

  const [items, total] = await Promise.all([
    Dispatch.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate("ownerId", "name mobile")
      .populate("driverId", "name mobile")
      .populate("vehicleId", "name number capacity")
      .populate("tripId")
      .populate({
        path: "orderIds",
        select:
          "orderId orderStatus numberOfPlants freightCharges farmer",
        populate: { path: "farmer", select: "name village mobileNumber" },
      })
      .lean(),
    Dispatch.countDocuments(filter),
  ]);

  const data = items.map((d) => {
    const orders = mapOrders(d.orderIds);
    const freightTotal = orders.reduce((s, o) => s + o.freightCharges, 0);
    const trip = mapTrip(d.tripId);
    return {
      dispatchId: d._id,
      transportId: d.transportId,
      name: d.name || "",
      transportStatus: d.transportStatus || "PENDING",
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
      routeId: d.routeId || "",
      routeNotes: d.routeNotes || "",
      driverRemark: d.driverRemark || "",
      vehicleRemark: d.vehicleRemark || "",
      returnedPlants: d.returnedPlants ?? 0,
      damagedPlants: d.damagedPlants ?? 0,
      owner: mapOwner(d.ownerId),
      driver: mapDriver(d.driverId, d),
      vehicle: mapVehicle(d.vehicleId, d),
      trip,
      orderCount: orders.length,
      orders,
      freightTotal: Math.round(freightTotal * 100) / 100,
      vehicleCostTotal: trip?.vehicleCostTotal ?? null,
    };
  });

  return res.status(200).json(
    generateResponse(
      "Success",
      "Fleet ledger fetched successfully",
      {
        data,
        pagination: {
          total,
          page,
          limit,
          pages: Math.max(1, Math.ceil(total / limit) || 1),
        },
      },
      undefined
    )
  );
});

/**
 * Single dispatch row with full fleet + trip + orders (detail drawer).
 * GET /api/v1/fleet/ledger/:dispatchId
 */
export const getFleetLedgerByDispatchId = catchAsync(async (req, res, next) => {
  const { dispatchId } = req.params;
  if (!mongoose.isValidObjectId(dispatchId)) {
    return next(new AppError("Invalid dispatch id", 400));
  }

  const d = await Dispatch.findOne({ _id: dispatchId, isDeleted: false })
    .populate("ownerId", "name mobile notes")
    .populate("driverId", "name mobile licenseNumber bankName accountNumber ifscCode")
    .populate("vehicleId", "name number capacity vehicleType")
    .populate("tripId")
    .populate({
      path: "orderIds",
      select:
        "orderId orderStatus numberOfPlants freightCharges rate deliveryDate farmer plantName",
      populate: [
        { path: "farmer", select: "name village mobileNumber" },
        { path: "plantName", select: "name" },
      ],
    })
    .lean();

  if (!d) {
    return next(new AppError("Dispatch not found", 404));
  }

  const orders = (d.orderIds || []).map((o) => ({
    _id: o._id,
    orderId: o.orderId,
    orderStatus: o.orderStatus,
    numberOfPlants: o.numberOfPlants,
    rate: o.rate,
    deliveryDate: o.deliveryDate,
    freightCharges: Math.max(0, Number(o.freightCharges) || 0),
    farmerName: o.farmer?.name || "",
    village: o.farmer?.village || "",
    mobile: o.farmer?.mobileNumber || "",
    plantName: o.plantName?.name || "",
  }));

  const payload = {
    dispatchId: d._id,
    transportId: d.transportId,
    name: d.name || "",
    transportStatus: d.transportStatus || "PENDING",
    createdAt: d.createdAt,
    routeId: d.routeId || "",
    routeNotes: d.routeNotes || "",
    driverRemark: d.driverRemark || "",
    vehicleRemark: d.vehicleRemark || "",
    owner: mapOwner(d.ownerId),
    driver: mapDriver(d.driverId, d),
    vehicle: mapVehicle(d.vehicleId, d),
    trip: mapTrip(d.tripId),
    orders,
    freightTotal: orders.reduce((s, o) => s + o.freightCharges, 0),
  };

  return res
    .status(200)
    .json(generateResponse("Success", "Fleet dispatch detail fetched", payload, undefined));
});
