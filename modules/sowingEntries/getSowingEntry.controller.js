import mongoose from "mongoose";
import Order from "../../models/order.model.js";
import "../../models/farmer.model.js";
import SowingEntry from "../../models/sowingEntry.model.js";
import { toSowingEntryListItem } from "./mapSowingEntry.js";
import {
  attributedOrderPlants,
  dispatchedOrdersForEntry,
  linkedOrdersForEntry,
} from "./linkedOrdersForEntry.js";

const ORDER_FIELDS = [
  "orderId",
  "name",
  "numberOfPlants",
  "additionalPlants",
  "sowingDone",
  "sowingDoneAt",
  "sowingDoneRequestId",
  "sowingPartialCover",
  "sowingCoverSources",
  "orderStatus",
  "deliveryDate",
  "orderBookingDate",
  "createdAt",
  "farmer",
].join(" ");

function oid(value) {
  const text = String(value || "").trim();
  return mongoose.Types.ObjectId.isValid(text) ? new mongoose.Types.ObjectId(text) : null;
}

/** One sowing entry plus the orders linked on that document. */
export async function getSowingEntryById(req, res) {
  const id = oid(req.params.id);
  if (!id) return res.status(400).json({ success: false, message: "Invalid entry id" });

  const doc = await SowingEntry.findById(id).lean();
  if (!doc) return res.status(404).json({ success: false, message: "Sowing entry not found" });

  const ids = [
    ...new Set(
      [...(doc.linkedOrderIds || []), ...(doc.dispatchedOrders || []).map((row) => row?.orderId)]
        .map((value) => String(value || ""))
        .filter(Boolean)
    ),
  ]
    .map((value) => oid(value))
    .filter(Boolean);
  const orders = ids.length
    ? await Order.find({ _id: { $in: ids } })
        .select(ORDER_FIELDS)
        .populate("farmer", "name mobileNumber")
        .lean()
    : [];

  return res.json({
    success: true,
    source: "sowingentries",
    item: {
      ...toSowingEntryListItem(doc, attributedOrderPlants(doc, orders)),
      createdAt: doc.createdAt || null,
      linkedOrders: linkedOrdersForEntry(doc, orders),
      dispatchedOrders: dispatchedOrdersForEntry(doc, orders),
    },
  });
}
