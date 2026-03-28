/**
 * Integration check: PATCH /api/v1/order/updateOrder changes orderStatus for a real user/order.
 * Usage: node scripts/test-dispatch-order-status-patch.js [orderId] [userId]
 * Requires: API on TEST_API_BASE (default http://127.0.0.1:8000), MONGO_URL in .env
 */
import dotenv from "dotenv";
dotenv.config();

import mongoose from "mongoose";
import Order from "../models/order.model.js";
import User from "../models/user.model.js";
import { generateTokenPair } from "../utility/jwtUtils.js";

const ORDER_ID = process.argv[2] || "6947dc54ddf3ed079d3b3000";
const USER_ID = process.argv[3] || "69476530ea2b4117c7270484";
const BASE = process.env.TEST_API_BASE || "http://127.0.0.1:8000";

async function main() {
  if (!process.env.MONGO_URL) {
    console.error("MONGO_URL missing");
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URL);

  const order = await Order.findById(ORDER_ID).lean();
  const user = await User.findById(USER_ID).lean();

  if (!order) {
    console.error("Order not found:", ORDER_ID);
    process.exit(1);
  }
  if (!user) {
    console.error("User not found:", USER_ID);
    process.exit(1);
  }

  console.log("--- Before ---");
  console.log("order.orderStatus:", order.orderStatus);
  console.log("user.role / jobTitle:", user.role, "/", user.jobTitle);

  const { accessToken } = generateTokenPair({
    _id: user._id.toString(),
    phoneNumber: user.phoneNumber,
    role: user.role,
    jobTitle: user.jobTitle,
    name: user.name,
  });

  const body = {
    id: ORDER_ID,
    orderStatus: "READY_FOR_DISPATCH",
  };

  const res = await fetch(`${BASE}/api/v1/order/updateOrder`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  });

  let json = {};
  try {
    json = await res.json();
  } catch {
    /* ignore */
  }

  console.log("\n--- PATCH response ---");
  console.log("HTTP", res.status);
  console.log("status (payload):", json.status);
  console.log("message:", json.message);
  if (json.rejectedFields?.length) {
    console.log("rejectedFields:", JSON.stringify(json.rejectedFields, null, 2));
  }
  console.log("data.orderStatus (from API):", json.data?.orderStatus);

  const after = await Order.findById(ORDER_ID).lean();
  console.log("\n--- After (DB read) ---");
  console.log("order.orderStatus:", after?.orderStatus);

  const changed = order.orderStatus !== after?.orderStatus;
  const isReady = after?.orderStatus === "READY_FOR_DISPATCH";
  console.log("\nRESULT:", changed ? "STATUS_CHANGED" : isReady ? "ALREADY_READY_FOR_DISPATCH" : "STATUS_UNCHANGED");

  const patchOk = res.status === 200 && json.status === "Success";
  const ok = patchOk && isReady;

  await mongoose.disconnect();
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
