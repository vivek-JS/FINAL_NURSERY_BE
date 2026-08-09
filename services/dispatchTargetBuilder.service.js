import mongoose from "mongoose";
import AppError from "../utility/appError.js";
import Order from "../models/order.model.js";
import PlantCms from "../models/plantCms.model.js";
import Tray from "../models/tray.model.js";

/** Server-side crate math — single source of truth for dispatch targets. */
export function calculateDispatchCrates({
  dispatchQuantity,
  cavityId,
  cavityName,
  cavitySize,
  numberPerCrate,
}) {
  const qty = Number(dispatchQuantity) || 0;
  const traySize = Number(cavitySize) || 0;
  const traysPerCrate = Number(numberPerCrate) || 0;

  if (qty <= 0 || traySize <= 0 || traysPerCrate <= 0) {
    return [];
  }

  const numberOfTrays = Math.floor(qty / traySize);
  const fullCrates = Math.floor(numberOfTrays / traysPerCrate);
  const plantsInFullCrates = fullCrates * traysPerCrate * traySize;
  const remainingPlants = Math.max(0, qty - plantsInFullCrates);

  const crateDetails = [];
  if (fullCrates > 0) {
    crateDetails.push({
      crateCount: fullCrates,
      plantCount: plantsInFullCrates,
    });
  }
  if (remainingPlants > 0) {
    crateDetails.push({
      crateCount: 1,
      plantCount: remainingPlants,
    });
  }
  if (!crateDetails.length) {
    return [];
  }

  return [
    {
      cavity: cavityId ? String(cavityId) : "",
      cavityName: cavityName || "",
      crateCount: crateDetails.reduce((sum, row) => sum + Number(row.crateCount || 0), 0),
      plantCount: crateDetails.reduce((sum, row) => sum + Number(row.plantCount || 0), 0),
      crateDetails,
    },
  ];
}

const toObjectId = (value) => {
  if (!value) return null;
  if (value instanceof mongoose.Types.ObjectId) return value;
  if (mongoose.isValidObjectId(String(value))) {
    return new mongoose.Types.ObjectId(String(value));
  }
  return null;
};

const buildPlantDispatchLabel = (plantCmsDoc, subtypeId) => {
  if (!plantCmsDoc?.name) return "Plant";
  const st = plantCmsDoc.subtypes?.find((s) => String(s?._id) === String(subtypeId));
  const sub = st?.name?.trim();
  return sub ? `${plantCmsDoc.name} -> ${sub}` : plantCmsDoc.name;
};

const mergeCrateRow = (existingCrates, incoming) => {
  if (!incoming?.cavity) {
    existingCrates.push(incoming);
    return;
  }
  const idx = existingCrates.findIndex(
    (c) => String(c.cavity) === String(incoming.cavity)
  );
  if (idx < 0) {
    existingCrates.push({ ...incoming });
    return;
  }
  const cur = existingCrates[idx];
  cur.crateCount = Number(cur.crateCount || 0) + Number(incoming.crateCount || 0);
  cur.plantCount = Number(cur.plantCount || 0) + Number(incoming.plantCount || 0);
  cur.crateDetails = [
    ...(Array.isArray(cur.crateDetails) ? cur.crateDetails : []),
    ...(Array.isArray(incoming.crateDetails) ? incoming.crateDetails : []),
  ];
};

/**
 * Rebuild plantsDetails + orderDispatchDetails with BE-calculated crates.
 * Keeps office shade assignments from client pickupDetails.
 */
export async function rebuildDispatchTargets({ dispatchRequest, session }) {
  const splitDetails = Array.isArray(dispatchRequest.orderDispatchDetails)
    ? dispatchRequest.orderDispatchDetails
    : [];

  const orderIds = [
    ...new Set(
      [
        ...(dispatchRequest.orderIds || []),
        ...splitDetails.map((d) => d.orderId),
      ]
        .filter(Boolean)
        .map(String)
    ),
  ];

  if (!orderIds.length) {
    throw new AppError("At least one order is required", 400);
  }

  const orders = await Order.find({ _id: { $in: orderIds } })
    .populate({ path: "plantName", select: "name subtypes" })
    .session(session)
    .lean();

  const orderById = new Map(orders.map((o) => [String(o._id), o]));

  const cavityIds = [
    ...new Set(
      orders
        .map((o) => o.cavity)
        .filter((id) => id && mongoose.isValidObjectId(String(id)))
        .map(String)
    ),
  ];

  for (const plant of dispatchRequest.plantsDetails || []) {
    for (const pd of plant.pickupDetails || []) {
      if (pd?.cavity && mongoose.isValidObjectId(String(pd.cavity))) {
        cavityIds.push(String(pd.cavity));
      }
    }
    for (const cr of plant.crates || []) {
      if (cr?.cavity && mongoose.isValidObjectId(String(cr.cavity))) {
        cavityIds.push(String(cr.cavity));
      }
    }
  }

  const trays = cavityIds.length
    ? await Tray.find({ _id: { $in: [...new Set(cavityIds)] } })
        .select("_id name cavity numberPerCrate")
        .session(session)
        .lean()
    : [];
  const trayById = new Map(trays.map((t) => [String(t._id), t]));

  const rebuiltOrderDetails = splitDetails.map((row) => {
    const order = orderById.get(String(row.orderId));
    if (!order) {
      throw new AppError(`Order not found: ${row.orderId}`, 404);
    }
    const cavityId = order.cavity;
    const tray = cavityId ? trayById.get(String(cavityId)) : null;
    if (!tray) {
      throw new AppError(
        `Order ${order.orderId ?? row.orderId} has no valid cavity/tray`,
        400
      );
    }

    const dispatchQuantity = Number(row.dispatchQuantity) || 0;
    const crates = calculateDispatchCrates({
      dispatchQuantity,
      cavityId: tray._id,
      cavityName: tray.name || "",
      cavitySize: tray.cavity || 0,
      numberPerCrate: tray.numberPerCrate || 0,
    });

    const currentRemaining =
      order.remainingPlants != null && Number.isFinite(Number(order.remainingPlants))
        ? Number(order.remainingPlants)
        : Number(order.numberOfPlants || 0) + Number(order.additionalPlants || 0);

    return {
      ...row,
      orderId: toObjectId(row.orderId) || row.orderId,
      dispatchQuantity,
      remainingAfterDispatch: Math.max(0, currentRemaining - dispatchQuantity),
      isPartialDispatch: dispatchQuantity < currentRemaining,
      shedLoadedQuantity: Number(row.shedLoadedQuantity) || 0,
      originalDispatchQuantity:
        row.originalDispatchQuantity != null &&
        Number.isFinite(Number(row.originalDispatchQuantity))
          ? Number(row.originalDispatchQuantity)
          : dispatchQuantity,
      lastOfficeQtyDelta: Number(row.lastOfficeQtyDelta) || 0,
      ...(row.lastOfficeEditedAt ? { lastOfficeEditedAt: row.lastOfficeEditedAt } : {}),
      crates,
    };
  });

  dispatchRequest.orderDispatchDetails = rebuiltOrderDetails;

  const clientPlants = Array.isArray(dispatchRequest.plantsDetails)
    ? dispatchRequest.plantsDetails
    : [];

  if (clientPlants.length > 0) {
    dispatchRequest.plantsDetails = clientPlants.map((plant) => {
      const pickupByCavity = new Map();

      for (const pd of plant.pickupDetails || []) {
        const cid = String(pd.cavity || "");
        if (!cid) continue;
        if (!pickupByCavity.has(cid)) {
          pickupByCavity.set(cid, { lines: [], qty: 0 });
        }
        const bucket = pickupByCavity.get(cid);
        bucket.lines.push(pd);
        bucket.qty += Number(pd.quantity) || 0;
      }

      const pickupDetails = [];
      const crates = [];
      let totalPlants = 0;

      for (const [cid, { lines, qty }] of pickupByCavity.entries()) {
        const tray = trayById.get(cid);
        if (!tray) {
          throw new AppError(`Invalid cavity ${cid} on plant ${plant.name || ""}`, 400);
        }
        totalPlants += qty;

        for (const line of lines) {
          pickupDetails.push({
            ...line,
            shade: line.shade != null ? String(line.shade) : line.shade,
            shadeName: line.shadeName || "",
            cavity: toObjectId(line.cavity) || line.cavity,
            cavityName: line.cavityName || tray.name || "",
          });
        }

        const calc = calculateDispatchCrates({
          dispatchQuantity: qty,
          cavityId: tray._id,
          cavityName: tray.name || "",
          cavitySize: tray.cavity || 0,
          numberPerCrate: tray.numberPerCrate || 0,
        });

        for (const row of calc) {
          mergeCrateRow(crates, {
            ...row,
            cavity: toObjectId(tray._id) || tray._id,
          });
        }
      }

      // Office dispatch: no shed pickup — use client crates + plant quantity
      if (!pickupByCavity.size) {
        totalPlants = Number(plant.quantity) || Number(plant.totalPlants) || 0;
        for (const clientCrate of plant.crates || []) {
          if (!clientCrate?.cavity) continue;
          mergeCrateRow(crates, {
            ...clientCrate,
            cavity: toObjectId(clientCrate.cavity) || clientCrate.cavity,
          });
        }
      }

      if (!crates.length && totalPlants > 0) {
        const firstCavity = pickupByCavity.keys().next().value;
        const tray = firstCavity ? trayById.get(firstCavity) : null;
        if (tray) {
          const calc = calculateDispatchCrates({
            dispatchQuantity: totalPlants,
            cavityId: tray._id,
            cavityName: tray.name || "",
            cavitySize: tray.cavity || 0,
            numberPerCrate: tray.numberPerCrate || 0,
          });
          calc.forEach((row) =>
            mergeCrateRow(crates, {
              ...row,
              cavity: toObjectId(tray._id) || tray._id,
            })
          );
        }
      }

      const resolvedQty = totalPlants || Number(plant.quantity) || 0;
      let finalPickupDetails = pickupDetails.filter(
        (line) => Number(line?.quantity) > 0
      );
      if (!finalPickupDetails.length && resolvedQty > 0 && crates.length) {
        const cavityId = crates[0]?.cavity;
        const tray = cavityId ? trayById.get(String(cavityId)) : null;
        finalPickupDetails = [
          {
            shade: "AT_SHED_LOAD",
            shadeName: "Assigned at secondary shed",
            quantity: resolvedQty,
            cavity: toObjectId(cavityId) || cavityId,
            cavityName: tray?.name || crates[0]?.cavityName || "",
          },
        ];
      }

      return {
        ...plant,
        plantId: toObjectId(plant.plantId) || plant.plantId,
        subTypeId: toObjectId(plant.subTypeId) || plant.subTypeId,
        quantity: resolvedQty,
        totalPlants: resolvedQty || Number(plant.totalPlants) || 0,
        pickupDetails: finalPickupDetails,
        crates,
      };
    });
    return dispatchRequest;
  }

  const plantAggregate = new Map();

  for (const row of rebuiltOrderDetails) {
    const order = orderById.get(String(row.orderId));
    if (!order) continue;
    const plantId = String(order.plantName?._id || order.plantName || "");
    const subTypeId = String(order.plantSubtype || "");
    const key = `${plantId}:${subTypeId}`;
    const tray = order.cavity ? trayById.get(String(order.cavity)) : null;
    if (!plantId || !subTypeId || !tray) continue;

    if (!plantAggregate.has(key)) {
      plantAggregate.set(key, {
        plantId,
        subTypeId,
        plantCms: order.plantName,
        qty: 0,
        crates: [],
        pickupDetails: [],
      });
    }
    const agg = plantAggregate.get(key);
    agg.qty += Number(row.dispatchQuantity) || 0;

    const rowCrates = (row.crates || []).map((c) => ({
      ...c,
      cavity: toObjectId(c.cavity || tray._id) || tray._id,
    }));
    rowCrates.forEach((c) => mergeCrateRow(agg.crates, c));
  }

  if (!plantAggregate.size) {
    throw new AppError("plantsDetails or orderDispatchDetails required", 400);
  }

  dispatchRequest.plantsDetails = [...plantAggregate.values()].map((agg) => {
    const cavityId =
      agg.crates[0]?.cavity ||
      orderById.get(String(rebuiltOrderDetails[0]?.orderId))?.cavity;
    const tray = cavityId ? trayById.get(String(cavityId)) : null;
    const pickupDetails = agg.pickupDetails.length
      ? agg.pickupDetails
      : [
          {
            shade: "AT_SHED_LOAD",
            shadeName: "Assigned at secondary shed",
            quantity: agg.qty,
            cavity: toObjectId(cavityId),
            cavityName: tray?.name || agg.crates[0]?.cavityName || "",
          },
        ];
    return {
      name: buildPlantDispatchLabel(agg.plantCms, agg.subTypeId),
      id: `${agg.plantId}-${agg.subTypeId}`,
      plantId: toObjectId(agg.plantId),
      subTypeId: toObjectId(agg.subTypeId),
      quantity: agg.qty,
      totalPlants: agg.qty,
      pickupDetails,
      crates: agg.crates,
      driverName: dispatchRequest.driverName || "",
      driverMobile: dispatchRequest.driverMobile || "",
      vehicleName: dispatchRequest.vehicleName || "",
    };
  });

  return dispatchRequest;
}
