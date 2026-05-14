import { describe, it } from "node:test";
import assert from "node:assert";
import {
  getAgriOrderLines,
  rollupAgriLineItemsToRoot,
} from "../models/agriSalesOrder.model.js";

describe("AgriSalesOrder lineItems helpers", () => {
  it("getAgriOrderLines falls back to legacy root fields", () => {
    const lines = getAgriOrderLines({
      isRamAgriProduct: true,
      quantity: 5,
      rate: 10,
      productName: "Tomato",
      ramAgriVarietyId: "507f1f77bcf86cd799439011",
    });
    assert.equal(lines.length, 1);
    assert.equal(lines[0].quantity, 5);
    assert.equal(lines[0].lineTotal, 50);
    assert.equal(lines[0].productName, "Tomato");
  });

  it("getAgriOrderLines uses lineItems when present", () => {
    const lines = getAgriOrderLines({
      lineItems: [
        {
          productName: "A",
          quantity: 2,
          rate: 5,
          lineTotal: 10,
          isRamAgriProduct: true,
        },
        {
          productName: "B",
          quantity: 1,
          rate: 4,
          lineTotal: 4,
          isRamAgriProduct: true,
        },
      ],
    });
    assert.equal(lines.length, 2);
    assert.equal(lines[0].productName, "A");
  });

  it("rollupAgriLineItemsToRoot aggregates totals and multi-line label", () => {
    const doc = {
      lineItems: [
        {
          productName: "Crop A",
          quantity: 2,
          rate: 100,
          lineTotal: 200,
          isRamAgriProduct: true,
          ramAgriCropId: null,
          ramAgriVarietyId: null,
        },
        {
          productName: "Crop B",
          quantity: 1,
          rate: 50,
          lineTotal: 50,
          isRamAgriProduct: true,
          ramAgriCropId: null,
          ramAgriVarietyId: null,
        },
      ],
    };
    rollupAgriLineItemsToRoot(doc);
    assert.equal(doc.quantity, 3);
    assert.equal(doc.totalAmount, 250);
    assert.equal(doc.productName, "Multiple items (2)");
    assert.equal(doc.isRamAgriProduct, true);
  });

  it("rollupAgriLineItemsToRoot uses single-line product name", () => {
    const doc = {
      lineItems: [
        {
          productName: "Only one",
          quantity: 4,
          rate: 25,
          lineTotal: 100,
          isRamAgriProduct: false,
          productId: null,
          unit: "kg",
        },
      ],
    };
    rollupAgriLineItemsToRoot(doc);
    assert.equal(doc.productName, "Only one");
    assert.equal(doc.quantity, 4);
    assert.equal(doc.totalAmount, 100);
  });

  it("rollupAgriLineItemsToRoot sums fractional line quantities", () => {
    const doc = {
      lineItems: [
        {
          productName: "Crop A",
          quantity: 0.5,
          rate: 10,
          lineTotal: 5,
          isRamAgriProduct: true,
        },
        {
          productName: "Crop B",
          quantity: 0.25,
          rate: 8,
          lineTotal: 2,
          isRamAgriProduct: true,
        },
      ],
    };
    rollupAgriLineItemsToRoot(doc);
    assert.equal(doc.quantity, 0.75);
    assert.equal(doc.totalAmount, 7);
    assert.equal(doc.productName, "Multiple items (2)");
  });
});

/**
 * Keep in sync with `dispatchOrders` in agriSalesOrder.controller.js:
 * OFFICE mode requires non-empty trimmed `dispatchNotes`.
 */
function officeDispatchRequiresRemark(dispatchMode, dispatchNotes) {
  if (dispatchMode !== "OFFICE") return true;
  const n = dispatchNotes != null ? String(dispatchNotes).trim() : "";
  return n.length > 0;
}

/**
 * Must match `buildAgriLineItemsForCreate` in agriSalesOrder.controller.js (multi-line create/update).
 */
function agriLineItemQuantityAllowed(rawQty) {
  const qty = Number(rawQty);
  return !Number.isNaN(qty) && qty > 0;
}

describe("Agri line item quantity (create payload contract)", () => {
  it("allows fractional quantities greater than 0", () => {
    assert.equal(agriLineItemQuantityAllowed(0.5), true);
    assert.equal(agriLineItemQuantityAllowed("1.25"), true);
    assert.equal(agriLineItemQuantityAllowed(1), true);
  });

  it("rejects zero, negative, or NaN", () => {
    assert.equal(agriLineItemQuantityAllowed(0), false);
    assert.equal(agriLineItemQuantityAllowed(-1), false);
    assert.equal(agriLineItemQuantityAllowed(NaN), false);
    assert.equal(agriLineItemQuantityAllowed(""), false);
  });
});

describe("Agri OFFICE dispatch remark rule (contract)", () => {
  it("requires non-empty trimmed dispatchNotes when mode is OFFICE", () => {
    assert.equal(officeDispatchRequiresRemark("OFFICE", ""), false);
    assert.equal(officeDispatchRequiresRemark("OFFICE", "   "), false);
    assert.equal(officeDispatchRequiresRemark("OFFICE", "Shipped from desk"), true);
    assert.equal(officeDispatchRequiresRemark("VEHICLE", ""), true);
    assert.equal(officeDispatchRequiresRemark("COURIER", null), true);
  });
});

/**
 * Mirrors `agriCreateHasLineItems` in routes/agriSalesOrder.route.js — multi-line POST /create
 * must not require root quantity/productId/ramAgri* (those live on each lineItems[] row).
 */
function routeCreateExpectsRootSingleLineFields(body) {
  const multi =
    body &&
    typeof body === "object" &&
    Array.isArray(body.lineItems) &&
    body.lineItems.length > 0;
  return !multi;
}

describe("POST /inventory/agri-sales-orders/create route shape (multi-line)", () => {
  it("skips root single-line requirements when lineItems is non-empty", () => {
    assert.equal(
      routeCreateExpectsRootSingleLineFields({
        customerName: "A",
        customerMobile: "9123456789",
        lineItems: [{ isRamAgriProduct: true, quantity: 1, rate: 10 }],
      }),
      false
    );
  });

  it("requires root fields when no lineItems", () => {
    assert.equal(
      routeCreateExpectsRootSingleLineFields({
        customerName: "A",
        customerMobile: "9123456789",
        isRamAgriProduct: true,
      }),
      true
    );
  });
});
