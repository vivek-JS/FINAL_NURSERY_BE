/**
 * Reassign plant orders from salesperson user "Gajanan P" (role DEALER) to
 * "Gajanan P (Gajanan Patil)" (role SALES). Same mechanics as
 * scripts/transfer-thirtha-agro-to-tirtha-agro.js (salesPerson / dealer refs).
 *
 *   node scripts/transfer-gajanan-p-orders-to-gajanan-patil.js --prod           # dry-run
 *   node scripts/transfer-gajanan-p-orders-to-gajanan-patil.js --prod --apply   # writes
 *
 * Uses PROD_MONGO_URL from .env only when --prod is passed.
 */
import dotenv from "dotenv";
import mongoose from "mongoose";
import Order from "../models/order.model.js";
import User from "../models/user.model.js";

dotenv.config();

const FROM = { name: "Gajanan P", role: "DEALER" };
const TO = { name: "Gajanan P (Gajanan Patil)", role: "SALES" };

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function buildDealerUpdate(existingOrder, oldSpUser, newUser) {
  const out = {};
  if (!existingOrder.dealerOrder) {
    if (newUser.jobTitle === "DEALER") {
      out.dealer = newUser._id;
    } else if (
      oldSpUser?.jobTitle === "DEALER" &&
      existingOrder.dealer &&
      String(existingOrder.dealer) === String(oldSpUser._id)
    ) {
      out.dealer = null;
    }
  }
  return out;
}

async function main() {
  if (!hasFlag("prod")) {
    console.error("Pass --prod to use PROD_MONGO_URL from .env (safety).");
    process.exit(1);
  }
  const mongoUrl = process.env.PROD_MONGO_URL;
  if (!mongoUrl) {
    console.error("PROD_MONGO_URL is not set in .env");
    process.exit(1);
  }

  const apply = hasFlag("apply");
  await mongoose.connect(mongoUrl);
  console.log("Connected:", mongoose.connection.host, "db:", mongoose.connection.name);

  const fromUser = await User.findOne({ name: FROM.name, role: FROM.role });
  const toUser = await User.findOne({ name: TO.name, role: TO.role });
  if (!fromUser) throw new Error(`User not found: ${FROM.name} (${FROM.role})`);
  if (!toUser) throw new Error(`User not found: ${TO.name} (${TO.role})`);
  if (String(fromUser._id) === String(toUser._id)) {
    console.error("From and to are the same user");
    process.exit(1);
  }

  console.log("From:", fromUser.name, fromUser.role, fromUser.jobTitle, fromUser._id);
  console.log("To:  ", toUser.name, toUser.role, toUser.jobTitle, toUser._id);

  const fromIds = [fromUser._id];
  const fromIdSet = new Set(fromIds.map((id) => String(id)));
  const fromById = new Map([[String(fromUser._id), fromUser]]);

  const query = {
    $or: [
      { salesPerson: { $in: fromIds } },
      { dealerOrder: true, dealer: { $in: fromIds } },
    ],
  };

  const total = await Order.countDocuments(query);
  console.log("Orders to transfer:", total);
  if (total === 0) {
    await mongoose.connection.close();
    return;
  }

  if (!apply) {
    const sample = await Order.find(query)
      .select("orderId dealerOrder orderStatus createdAt salesPerson dealer")
      .sort({ createdAt: -1 })
      .limit(20)
      .lean();
    console.log("\nSample (up to 20):");
    sample.forEach((o) =>
      console.log(
        `  orderId=${o.orderId} dealerOrder=${o.dealerOrder} sp=${o.salesPerson} dealer=${o.dealer ?? "-"}`
      )
    );
    console.log("\nDry-run only. Re-run with --apply to write.");
    await mongoose.connection.close();
    return;
  }

  let examined = 0;
  let updated = 0;
  const cursor = Order.find(query).cursor();

  for await (const order of cursor) {
    examined++;
    const obj = order.toObject ? order.toObject() : { ...order._doc };

    let oldForPatch = null;
    if (obj.salesPerson && fromIdSet.has(String(obj.salesPerson))) {
      oldForPatch = fromById.get(String(obj.salesPerson));
    } else if (obj.dealerOrder && obj.dealer && fromIdSet.has(String(obj.dealer))) {
      oldForPatch = fromById.get(String(obj.dealer));
    }
    if (!oldForPatch) {
      console.warn("Skip:", order.orderId, order._id);
      continue;
    }

    const setDoc = {};
    if (obj.salesPerson && fromIdSet.has(String(obj.salesPerson))) {
      setDoc.salesPerson = toUser._id;
    }
    if (obj.dealerOrder && obj.dealer && fromIdSet.has(String(obj.dealer))) {
      setDoc.dealer = toUser._id;
    }

    const preview = { ...obj, ...setDoc };
    Object.assign(setDoc, buildDealerUpdate(preview, oldForPatch, toUser));

    const parts = [];
    if (obj.salesPerson && fromIdSet.has(String(obj.salesPerson))) {
      parts.push(`salesPerson: ${FROM.name} → ${TO.name}`);
    }
    if (obj.dealerOrder && obj.dealer && fromIdSet.has(String(obj.dealer))) {
      parts.push(`dealer: ${FROM.name} → ${TO.name}`);
    }

    const primaryField = Object.prototype.hasOwnProperty.call(setDoc, "salesPerson")
      ? "salesPerson"
      : "dealer";

    const historyEntry = {
      field: primaryField,
      previousValue:
        primaryField === "dealer" ? obj.dealer ?? null : obj.salesPerson ?? null,
      newValue: primaryField === "dealer" ? setDoc.dealer ?? null : setDoc.salesPerson ?? null,
      changedBy: null,
      notes: `${parts.join("; ")} — prod transfer script`,
    };

    console.log(`APPLY orderId=${order.orderId} $set:`, JSON.stringify(setDoc));

    await Order.updateOne(
      { _id: order._id },
      { $set: setDoc, $push: { orderEditHistory: historyEntry } }
    );
    updated++;
  }

  console.log("---", `Updated ${updated}`, "---");
  await mongoose.connection.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
