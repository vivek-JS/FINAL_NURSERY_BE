/**
 * Reassign orders from dealer user "Thirtha Agro" (typo) → "Tirtha Agro".
 * Same rules as transfer-chhatrapati-nandurbar-dealers-to-chhtrapati-sales-sandip.js.
 *
 * Env: PROD_MONGO_URL | MONGO_URL | MONGODB_URI | DATABASE
 *
 *   node scripts/transfer-thirtha-agro-to-tirtha-agro.js           # dry-run
 *   node scripts/transfer-thirtha-agro-to-tirtha-agro.js --apply    # writes
 */
import dotenv from "dotenv";
import mongoose from "mongoose";
import Order from "../models/order.model.js";
import User from "../models/user.model.js";

dotenv.config();

const mongoUrl =
  process.env.PROD_MONGO_URL ||
  process.env.MONGO_URL ||
  process.env.MONGODB_URI ||
  process.env.DATABASE;

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
  if (!mongoUrl) {
    console.error("Missing Mongo URI");
    process.exit(1);
  }

  const apply = hasFlag("apply");
  await mongoose.connect(mongoUrl);
  console.log("Connected:", mongoose.connection.host, "db:", mongoose.connection.name);

  const fromUser = await User.findOne({ name: /^Thirtha Agro\s*$/i, role: "DEALER" });
  const toUser = await User.findOne({ name: /^Tirtha Agro\s*$/i, role: "DEALER" });
  if (!fromUser) throw new Error('DEALER "Thirtha Agro" not found');
  if (!toUser) throw new Error('DEALER "Tirtha Agro" not found');
  if (String(fromUser._id) === String(toUser._id)) {
    console.error("From and to are the same");
    process.exit(1);
  }

  console.log("From:", fromUser.name, fromUser._id);
  console.log("To:  ", toUser.name, toUser._id);

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
      parts.push(`salesPerson: Thirtha Agro → Tirtha Agro`);
    }
    if (obj.dealerOrder && obj.dealer && fromIdSet.has(String(obj.dealer))) {
      parts.push(`dealer: Thirtha Agro → Tirtha Agro`);
    }

    const primaryField = Object.prototype.hasOwnProperty.call(setDoc, "salesPerson")
      ? "salesPerson"
      : "dealer";

    const historyEntry = {
      field: primaryField,
      previousValue:
        primaryField === "dealer" ? obj.dealer ?? null : obj.salesPerson ?? null,
      newValue:
        primaryField === "dealer" ? setDoc.dealer ?? null : setDoc.salesPerson ?? null,
      changedBy: null,
      notes: `${parts.join("; ")} — spelling fix Thirtha → Tirtha`,
    };

    console.log(
      `${apply ? "APPLY" : "DRY"} orderId=${order.orderId} $set:`,
      JSON.stringify(setDoc)
    );

    if (apply) {
      await Order.updateOne(
        { _id: order._id },
        { $set: setDoc, $push: { orderEditHistory: historyEntry } }
      );
      updated++;
    }
  }

  console.log("---", apply ? `Updated ${updated}` : `Would update ${examined}`, "---");
  await mongoose.connection.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
