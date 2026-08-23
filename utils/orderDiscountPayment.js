export const DISCOUNT_PAYMENT_MODE = "Discount";

export function isDiscountPayment(payment) {
  if (!payment) return false;
  if (payment.isDiscount === true) return true;
  return String(payment.modeOfPayment || "").trim() === DISCOUNT_PAYMENT_MODE;
}
