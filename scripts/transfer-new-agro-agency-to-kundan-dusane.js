/**
 * Reassign plant orders from salesperson "New agro agency" → dealer "New Agro Agency (Kundan Dusane)".
 * Sets salesPerson + dealer (when target jobTitle is DEALER) like factory updates; appends orderEditHistory.
 *
 * Env: PROD_MONGO_URL | MONGO_URL | MONGODB_URI | DATABASE
 *
 * Usage (from FINAL_NURSERY_BE):
 *   node scripts/transfer-new-agro-agency-to-kundan-dusane.js           # dry-run
 *   node scripts/transfer-new-agro-agency-to-kundan-dusane.js --apply   # writes
 *
 * Optional:
 *   --from-user-id <24hex>   --to-user-id <24hex>
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

async function resolveFromUser() {
  const id = argAfter("--from-user-id");
  if (id) {
    if (!mongoose.isValidObjectId(id)) throw new Error(`Invalid --from-user-id: ${id}`);
    const u = await User.findById(id);
    if (!u) throw new Error(`From user not found: ${id}`);
    return u;
  }
  const list = await User.find({ name: /^New agro agency\s*$/i });
  if (list.length !== 1) {
    throw new Error(
      `Expected exactly 1 user named "New agro agency", found ${list.length}. Use --from-user-id.`
    );
  }
  return list[0];
}

async function resolveToUser() {
  const id = argAfter("--to-user-id");
  if (id) {
    if (!mongoose.isValidObjectId(id)) throw new Error(`Invalid --to-user-id: ${id}`);
    const u = await User.findById(id);
    if (!u) throw new Error(`To user not found: ${id}`);
    return u;
  }
  const list = await User.find({
    name: /^New Agro Agency \(Kundan Dusane\)\s*$/i,
  });
  if (list.length !== 1) {
    throw new Error(
      `Expected exactly 1 user "New Agro Agency (Kundan Dusane)", found ${list.length}. Use --to-user-id.`
    );
  }
  return list[0];
}

async function main() {
  if (!mongoUrl) {
    console.error("Missing PROD_MONGO_URL / MONGO_URL / MONGODB_URI / DATABASE");
    process.exit(1);
  }

  const apply = hasFlag("apply");

  await mongoose.connect(mongoUrl);
  console.log("Connected:", mongoose.connection.host);

  const fromUser = await resolveFromUser();
  const toUser = await resolveToUser();

  if (String(fromUser._id) === String(toUser._id)) {
    console.error("From and to user are the same; nothing to do.");
    process.exit(1);
  }

  console.log("From:", fromUser.name, fromUser.phoneNumber, fromUser.jobTitle, fromUser._id);
  console.log("To:  ", toUser.name, toUser.phoneNumber, toUser.jobTitle, toUser._id);

  const cursor = Order.find({ salesPerson: fromUser._id }).cursor();
  let examined = 0;
  let wouldUpdate = 0;
  let updated = 0;

  const noteLabel =
    "bulk transfer New agro agency → New Agro Agency (Kundan Dusane)";

  for await (const order of cursor) {
    examined++;
    const oldName = fromUser.name;
    const newName = toUser.name;
    const dealerPatch = buildDealerUpdate(order, fromUser, toUser);
    const historyEntry = {
      field: "salesPerson",
      previousValue: order.salesPerson,
      newValue: toUser._id,
      changedBy: null,
      notes: `Sales person changed from ${oldName} to ${newName} (${noteLabel})`,
    };

    console.log(
      `${apply ? "APPLY" : "DRY"} orderId=${order.orderId} _id=${order._id} dealerOrder=${order.dealerOrder} dealer patch:`,
      JSON.stringify(dealerPatch)
    );

    if (apply) {
      await Order.updateOne(
        { _id: order._id },
        {
          $set: {
            salesPerson: toUser._id,
            ...dealerPatch,
          },
          $push: { orderEditHistory: historyEntry },
        }
      );
      updated++;
    } else {
      wouldUpdate++;
    }
  }

  console.log("\n--- Summary ---");
  console.log("Mode:", apply ? "APPLY" : "DRY-RUN");
  console.log("Orders with this salesPerson:", examined);
  console.log(apply ? "Updated:" : "Would update:", apply ? updated : wouldUpdate);

  await mongoose.connection.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
