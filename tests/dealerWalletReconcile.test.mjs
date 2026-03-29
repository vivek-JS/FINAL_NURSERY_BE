import { describe, it } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import {
  computeDealerQuotaLineFromDerived,
  dealerWalletLineKey,
  overlayOrderDerivedQuotaOnPlantDetails,
} from "../utils/dealerWalletReconcile.js";

describe("dealerWalletReconcile", () => {
  describe("computeDealerQuotaLineFromDerived", () => {
    it("legacy full bookedQuantity with bulk-only orders yields full farmer availability", () => {
      const entry = { quantity: 100000, bookedQuantity: 100000 };
      const derivedRow = { bulkFromOrders: 100000, farmerBookedFromOrders: 0 };
      const out = computeDealerQuotaLineFromDerived(entry, derivedRow);
      assert.equal(out.fixedQty, 100000);
      assert.equal(out.farmerBookedFromOrders, 0);
      assert.equal(out.bulkFromOrders, 100000);
      assert.equal(out.availableForFarmerOrders, 100000);
    });

    it("farmer booked from orders reduces availability", () => {
      const entry = { quantity: 500, bookedQuantity: 500 };
      const derivedRow = { bulkFromOrders: 0, farmerBookedFromOrders: 200 };
      const out = computeDealerQuotaLineFromDerived(entry, derivedRow);
      assert.equal(out.fixedQty, 500);
      assert.equal(out.availableForFarmerOrders, 300);
    });

    it("fixedQty rises when orders imply more than stored quantity", () => {
      const entry = { quantity: 100, bookedQuantity: 100 };
      const derivedRow = { bulkFromOrders: 50, farmerBookedFromOrders: 80 };
      const out = computeDealerQuotaLineFromDerived(entry, derivedRow);
      assert.equal(out.fixedQty, 130);
      assert.equal(out.availableForFarmerOrders, 50);
    });
  });

  describe("dealerWalletLineKey", () => {
    it("matches ObjectId and string forms when toString matches", () => {
      const id = new mongoose.Types.ObjectId();
      const hex = id.toString();
      const k1 = dealerWalletLineKey(id, id, id);
      const k2 = dealerWalletLineKey(hex, hex, hex);
      assert.equal(k1, k2);
    });

    it("matches 24-char hex regardless of case", () => {
      const lower = "68fdf6d45832d541b274acfa";
      const upper = "68FDF6D45832D541B274ACFA";
      assert.equal(
        dealerWalletLineKey(upper, lower, lower),
        dealerWalletLineKey(lower, lower, lower)
      );
    });
  });

  describe("overlayOrderDerivedQuotaOnPlantDetails", () => {
    it("sets booked to 0 and remaining to full quantity when only bulk (no farmer quota)", () => {
      const plantType = new mongoose.Types.ObjectId();
      const subType = new mongoose.Types.ObjectId();
      const slotA = new mongoose.Types.ObjectId();
      const slotB = new mongoose.Types.ObjectId();

      const keyA = dealerWalletLineKey(plantType, subType, slotA);
      const keyB = dealerWalletLineKey(plantType, subType, slotB);

      const derivedMap = new Map([
        [keyA, { bulkFromOrders: 100000, farmerBookedFromOrders: 0 }],
        [keyB, { bulkFromOrders: 1600, farmerBookedFromOrders: 0 }],
      ]);

      const plantDetails = [
        {
          plantType,
          subType,
          plantName: "Banana",
          subtypeName: "G9",
          slotDetails: [
            {
              slotId: slotA,
              quantity: 100000,
              bookedQuantity: 100000,
              remainingQuantity: 0,
            },
            {
              slotId: slotB,
              quantity: 1600,
              bookedQuantity: 1600,
              remainingQuantity: 0,
            },
          ],
        },
      ];

      const out = overlayOrderDerivedQuotaOnPlantDetails(plantDetails, derivedMap);
      const plant = out[0];

      assert.equal(plant.slotDetails[0].bookedQuantity, 0);
      assert.equal(plant.slotDetails[0].remainingQuantity, 100000);
      assert.equal(plant.slotDetails[1].bookedQuantity, 0);
      assert.equal(plant.slotDetails[1].remainingQuantity, 1600);

      assert.equal(plant.totalQuantity, 101600);
      assert.equal(plant.totalBookedQuantity, 0);
      assert.equal(plant.totalRemainingQuantity, 101600);
    });

    it("caps farmer booked by slot quantity and updates plant totals", () => {
      const plantType = new mongoose.Types.ObjectId();
      const subType = new mongoose.Types.ObjectId();
      const slotId = new mongoose.Types.ObjectId();
      const key = dealerWalletLineKey(plantType, subType, slotId);

      const derivedMap = new Map([
        [key, { bulkFromOrders: 0, farmerBookedFromOrders: 800 }],
      ]);

      const plantDetails = [
        {
          plantType,
          subType,
          slotDetails: [
            {
              slotId,
              quantity: 500,
              bookedQuantity: 0,
              remainingQuantity: 500,
            },
          ],
        },
      ];

      const out = overlayOrderDerivedQuotaOnPlantDetails(plantDetails, derivedMap);
      const plant = out[0];

      assert.equal(plant.slotDetails[0].bookedQuantity, 500);
      assert.equal(plant.slotDetails[0].remainingQuantity, 0);
      assert.equal(plant.totalQuantity, 500);
      assert.equal(plant.totalBookedQuantity, 500);
      assert.equal(plant.totalRemainingQuantity, 0);
    });
  });
});
