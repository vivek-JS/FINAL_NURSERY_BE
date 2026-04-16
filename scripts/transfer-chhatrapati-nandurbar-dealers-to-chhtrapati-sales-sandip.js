/**
 * Reassign orders from dealer users:
 *   - Chhatrapati Agro Nandurbar
 *   - Chhtrapati Agro N. (typo variant "Chjtrapati" is not in DB; matches Chhtrapati Agro N.)
 * to:
 *   - Chhtrapati Agro Sales (Sandip Patil)
 *
 * Matches orders where salesPerson is a source user, or dealerOrder with dealer = source.
 * Uses the same dealer-field rules as transfer-salesperson-chhtrapati-sales-to-sandip-sir.js.
 *
 * Env: PROD_MONGO_URL | MONGO_URL | MONGODB_URI | DATABASE
 *
 * Usage (from FINAL_NURSERY_BE):
 *   node scripts/transfer-chhatrapati-nandurbar-dealers-to-chhtrapati-sales-sandip.js           # dry-run
 *   node scripts/transfer-chhatrapati-nandurbar-dealers-to-chhtrapati-sales-sandip.js --apply # writes
 *
 * Optional overrides:
 *   --to-user-id <24hex>
 *   --from-user-id <24hex>   (single from; run twice if needed, or rely on defaults)
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

function argAfter(flag) {
  const i = process.argv.indexOf(flag);
  if (i === -1 || i + 1 >= process.argv.length) return null;
  return process.argv[i + 1];
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

const DEFAULT_FROM_NAME_PATTERNS = [
  /^Chhatrapati Agro Nandurbar\s*$/i,
  /^Chhtrapati Agro N\.?\s*$/i,
];

async function resolveFromUsers() {
  const singleId = argAfter("--from-user-id");
  if (singleId) {
    if (!mongoose.isValidObjectId(singleId)) throw new Error(`Invalid --from-user-id: ${singleId}`);
    const u = await User.findById(singleId);
    if (!u) throw new Error(`From user not found: ${singleId}`);
    return [u];
  }

  const out = [];
  for (const pat of DEFAULT_FROM_NAME_PATTERNS) {
    const list = await User.find({ name: pat, role: "DEALER" });
    if (list.length > 1) {
      throw new Error(
        `Multiple DEALER users for pattern ${pat}: ${list.map((x) => `${x.name} (${x._id})`).join("; ")}`
      );
    }
    if (list.length === 1) out.push(list[0]);
  }
  const dedup = [];
  const seen = new Set();
  for (const u of out) {
    const k = String(u._id);
    if (seen.has(k)) continue;
    seen.add(k);
    dedup.push(u);
  }
  if (dedup.length === 0) {
    throw new Error(
      "No source DEALER users found (Chhatrapati Agro Nandurbar / Chhtrapati Agro N.). Use --from-user-id."
    );
  }
  return dedup;
}

async function resolveToUser() {
  const id = argAfter("--to-user-id");
  if (id) {
    if (!mongoose.isValidObjectId(id)) throw new Error(`Invalid --to-user-id: ${id}`);
    const u = await User.findById(id);
    if (!u) throw new Error(`To user not found: ${id}`);
    return u;
  }
  const patterns = [
    /^Chhtrapati Agro Sales \(Sandip Patil\)\s*$/i,
    /^Chhatrapati Agro Sales \(Sandip Patil\)\s*$/i,
    /^ChhtrapatiAgro sales \(Sandip Patil\)\s*$/i,
  ];
  for (const pat of patterns) {
    const list = await User.find({ name: pat, role: "DEALER" });
    if (list.length === 1) return list[0];
    if (list.length > 1) {
      throw new Error(
        `Multiple to-users for ${pat}: ${list.map((u) => `${u.name} (${u._id})`).join("; ")}. Use --to-user-id.`
      );
    }
  }
  throw new Error(
    'No DEALER user "Chhtrapati Agro Sales (Sandip Patil)" (or spelling variant). Use --to-user-id.'
  );
}

async function main() {
  if (!mongoUrl) {
    console.error("Missing MONGO_URL / PROD_MONGO_URL / MONGODB_URI / DATABASE");
    process.exit(1);
  }

  const apply = hasFlag("apply");
  await mongoose.connect(mongoUrl);
  console.log("Connected:", mongoose.connection.host, "db:", mongoose.connection.name);

  const fromUsers = await resolveFromUsers();
  const toUser = await resolveToUser();

  console.log(
    "From users:",
    fromUsers.map((u) => `${u.name} (${u._id}) ${u.phoneNumber}`).join(" | ")
  );
  console.log("To user: ", `${toUser.name} (${toUser._id}) ${toUser.phoneNumber}`);

  const fromIds = fromUsers.map((u) => u._id);
  const fromById = new Map(fromUsers.map((u) => [String(u._id), u]));
  const fromIdSet = new Set(fromIds.map((id) => String(id)));

  const query = {
    $or: [
      { salesPerson: { $in: fromIds } },
      { dealerOrder: true, dealer: { $in: fromIds } },
    ],
  };

  const total = await Order.countDocuments(query);
  console.log("\nOrders matching transfer query:", total);
  if (total === 0) {
    console.log("Nothing to update.");
    await mongoose.connection.close();
    return;
  }

  const cursor = Order.find(query).cursor();
  let examined = 0;
  let updated = 0;

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
      console.warn("Skip order (no from-user match):", order.orderId, order._id);
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
    const dealerPatch = buildDealerUpdate(preview, oldForPatch, toUser);
    Object.assign(setDoc, dealerPatch);

    const parts = [];
    if (obj.salesPerson && fromIdSet.has(String(obj.salesPerson))) {
      parts.push(`salesPerson: ${oldForPatch.name} → ${toUser.name}`);
    }
    if (obj.dealerOrder && obj.dealer && fromIdSet.has(String(obj.dealer))) {
      parts.push(`dealer: ${oldForPatch.name} → ${toUser.name}`);
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
      notes: `${parts.join("; ")} — Chhatrapati/Nandurbar dealer lines → Chhtrapati Agro Sales (Sandip Patil)`,
    };

    console.log(
      `${apply ? "APPLY" : "DRY"} orderId=${order.orderId} _id=${order._id} dealerOrder=${order.dealerOrder} $set:`,
      JSON.stringify(setDoc)
    );

    if (apply) {
      await Order.updateOne(
        { _id: order._id },
        {
          $set: setDoc,
          $push: { orderEditHistory: historyEntry },
        }
      );
      updated++;
    }
  }

  console.log("\n--- Summary ---");
  console.log("Mode:", apply ? "APPLY" : "DRY-RUN");
  console.log("Examined:", examined);
  console.log(apply ? "Updated:" : "Would update:", apply ? updated : examined);

  await mongoose.connection.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
