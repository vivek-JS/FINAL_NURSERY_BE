/**
 * Lightweight verification of farmer-plant payment transition policy.
 *
 * This does NOT touch MongoDB; it only asserts that the policy matrix
 * matches the expected CREDIT / REVERSAL / NONE outcomes.
 *
 * Usage:
 *   node scripts/verify-farmer-plant-ledger-transition-policy.js
 */
import {
  getFarmerPlantPaymentTransitionAction,
} from "../utils/farmerPlantOrderLedgerHelper.js";

function assertEq(actual, expected, label) {
  if (actual !== expected) {
    console.error(`[FAIL] ${label}: expected ${expected}, got ${actual}`);
    process.exit(1);
  }
  console.log(`[OK] ${label}`);
}

function main() {
  // Product rules requested by user.
  assertEq(
    getFarmerPlantPaymentTransitionAction("PENDING", "COLLECTED"),
    "CREDIT",
    "PENDING -> COLLECTED => CREDIT"
  );
  assertEq(
    getFarmerPlantPaymentTransitionAction("COLLECTED", "PENDING"),
    "REVERSAL",
    "COLLECTED -> PENDING => REVERSAL"
  );
  assertEq(
    getFarmerPlantPaymentTransitionAction("COLLECTED", "REJECTED"),
    "REVERSAL",
    "COLLECTED -> REJECTED => REVERSAL"
  );
  assertEq(
    getFarmerPlantPaymentTransitionAction("REJECTED", "PENDING"),
    "NONE",
    "REJECTED -> PENDING => NONE"
  );
  assertEq(
    getFarmerPlantPaymentTransitionAction("REJECTED", "COLLECTED"),
    "CREDIT",
    "REJECTED -> COLLECTED => CREDIT"
  );

  // Sanity: same-status => NONE
  assertEq(
    getFarmerPlantPaymentTransitionAction("COLLECTED", "COLLECTED"),
    "NONE",
    "COLLECTED -> COLLECTED => NONE"
  );
}

main();

