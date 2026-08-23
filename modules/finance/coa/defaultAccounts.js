import { ACCOUNT_CODES, ACCOUNT_TYPES } from "../domain/constants.js";

/** Default tenant chart — PostgreSQL-ready field names */
export const DEFAULT_CHART_ACCOUNTS = [
  { code: ACCOUNT_CODES.AR_FARMER, name: "Accounts Receivable — Farmers", accountType: ACCOUNT_TYPES.ASSET, isControl: true, partyType: "FARMER" },
  { code: ACCOUNT_CODES.AR_AGRI, name: "Accounts Receivable — Agri Customers", accountType: ACCOUNT_TYPES.ASSET, isControl: true, partyType: "AGRI_CUSTOMER" },
  { code: ACCOUNT_CODES.AR_DEALER, name: "Accounts Receivable — Dealers", accountType: ACCOUNT_TYPES.ASSET, isControl: true, partyType: "DEALER" },
  { code: ACCOUNT_CODES.CASH, name: "Cash in Hand", accountType: ACCOUNT_TYPES.ASSET, isControl: false },
  { code: ACCOUNT_CODES.BANK_ICICI, name: "Bank — ICICI", accountType: ACCOUNT_TYPES.ASSET, isControl: false },
  { code: ACCOUNT_CODES.PAYMENT_CLEARING, name: "Payment Clearing", accountType: ACCOUNT_TYPES.ASSET, isControl: false },
  { code: ACCOUNT_CODES.CUSTOMER_ADVANCE, name: "Customer Advance", accountType: ACCOUNT_TYPES.LIABILITY, isControl: false },
  { code: ACCOUNT_CODES.SUSPENSE_BANK, name: "Bank Suspense", accountType: ACCOUNT_TYPES.LIABILITY, isControl: false },
  { code: ACCOUNT_CODES.DEALER_WALLET, name: "Dealer Wallet", accountType: ACCOUNT_TYPES.LIABILITY, isControl: true, partyType: "DEALER" },
  { code: ACCOUNT_CODES.SALES_PLANTS, name: "Sales — Plants", accountType: ACCOUNT_TYPES.INCOME, isControl: false },
  { code: ACCOUNT_CODES.SALES_AGRI, name: "Sales — Agri Inputs", accountType: ACCOUNT_TYPES.INCOME, isControl: false },
  { code: ACCOUNT_CODES.SALES_RETURN, name: "Sales Return", accountType: ACCOUNT_TYPES.INCOME, isControl: false },
  { code: ACCOUNT_CODES.SALES_DISCOUNT, name: "Sales Discount — Plants", accountType: ACCOUNT_TYPES.INCOME, isControl: false },
  { code: ACCOUNT_CODES.COMMISSION_EXPENSE, name: "Commission Expense", accountType: ACCOUNT_TYPES.EXPENSE, isControl: false },
  { code: ACCOUNT_CODES.TRANSPORT_EXPENSE, name: "Transport Expense", accountType: ACCOUNT_TYPES.EXPENSE, isControl: false },
];
