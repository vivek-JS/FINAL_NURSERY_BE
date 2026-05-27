import { describe, it } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";

describe("OrderEvent immutability", () => {
  it("schema blocks updateOne", async () => {
    const { default: OrderEvent } = await import(
      "../../modules/orderEvents/models/orderEvent.model.js"
    );
    const doc = new OrderEvent({
      orderDomain: "PLANT",
      orderId: new mongoose.Types.ObjectId(),
      eventType: "ORDER_CREATED",
      idempotencyKey: `test:immutability:${Date.now()}`,
      occurredAt: new Date(),
    });

    let err;
    try {
      await doc.validate();
      await OrderEvent.updateOne({ _id: doc._id }, { $set: { description: "hack" } });
    } catch (e) {
      err = e;
    }
    assert.ok(err, "expected updateOne to throw");
    assert.match(String(err.message), /immutable/i);
  });
});
