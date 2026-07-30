/**
 * Deterministic regression test for services/transactionParser.js.
 * Feeds hardcoded OCR text blocks (one per bank/app, incl. Marathi/Hindi) and
 * asserts the key extracted fields. This validates the parser only — real
 * end-to-end image accuracy still needs manual verification with actual
 * screenshots after deploy.
 *
 * Run with: node scripts/test-ocr-samples.mjs
 */
import { parseTransaction } from "../services/transactionParser.js";

const cases = [
  {
    name: "Google Pay -> HDFC, plain UTR label",
    text: [
      "Google Pay",
      "₹1,250.00",
      "Paid to Ramesh Nursery",
      "Completed",
      "12 Jul 2026, 10:45 am",
      "UPI transaction ID: 123456789012",
      "UTR: 987654321098",
      "Bank: HDFC Bank",
    ].join("\n"),
    expect: { bank: "HDFC Bank", app: "Google Pay", status: "SUCCESS", amount: 1250, receiver: "Ramesh Nursery" },
  },
  {
    name: "PhonePe -> ICICI, RRN label",
    text: [
      "PhonePe",
      "Paid ₹850",
      "To Suresh Traders",
      "Transaction Successful",
      "UTR No: 456789123456",
      "ICICI Bank XX1234",
      "05/07/2026 14:20",
    ].join("\n"),
    expect: { bank: "ICICI Bank", app: "PhonePe", status: "SUCCESS", amount: 850, receiver: "Suresh Traders" },
  },
  {
    name: "Paytm -> SBI, UPI Ref No label",
    text: [
      "Paytm",
      "Payment Successful",
      "Amount: Rs. 2000",
      "Paid to Anita Farms",
      "UPI Ref No. 321654987321",
      "SBI Bank",
      "date: 2026-07-01 time: 09:15 AM",
    ].join("\n"),
    expect: { bank: "State Bank of India", app: "Paytm", status: "SUCCESS", amount: 2000, receiver: "Anita Farms" },
  },
  {
    name: "BHIM -> Axis Bank, Reference No label",
    text: [
      "BHIM UPI",
      "Rs 500 paid",
      "To: Vinod Kumar",
      "Reference No: 111222333444",
      "Axis Bank",
      "Status: SUCCESS",
      "20-06-2026 18:05",
    ].join("\n"),
    expect: { bank: "Axis Bank", app: "BHIM", status: "SUCCESS", amount: 500, receiver: "Vinod Kumar" },
  },
  {
    name: "Amazon Pay -> Kotak, Transaction ID label",
    text: [
      "Amazon Pay",
      "₹3,499",
      "Paid to Green Agro Store",
      "Transaction ID: 555666777888",
      "Kotak Mahindra Bank",
      "Payment done",
      "15 Aug 2026",
    ].join("\n"),
    expect: { bank: "Kotak Mahindra Bank", app: "Amazon Pay", status: "SUCCESS", amount: 3499, receiver: "Green Agro Store" },
  },
  {
    name: "Google Pay failed payment -> Canara Bank",
    text: [
      "Google Pay",
      "₹750",
      "To Farmer Seva Kendra",
      "Payment Failed",
      "UTR: 222333444555",
      "Canara Bank",
    ].join("\n"),
    expect: { bank: "Canara Bank", app: "Google Pay", status: "FAILED", amount: 750, receiver: "Farmer Seva Kendra" },
  },
  {
    name: "PhonePe pending -> Union Bank",
    text: [
      "PhonePe",
      "₹1,000",
      "To Mahesh Bhosale",
      "Payment Pending",
      "UTR: 999888777666",
      "Union Bank of India",
    ].join("\n"),
    expect: { bank: "Union Bank", app: "PhonePe", status: "PENDING", amount: 1000, receiver: "Mahesh Bhosale" },
  },
  {
    name: "Marathi (Devanagari digits) receipt -> IDBI",
    text: [
      "Google Pay",
      "₹१,५००",
      "प्राप्तकर्ता: संदीप पाटील",
      "यशस्वी",
      "UTR: १२३४५६७८९०१२",
      "IDBI Bank",
      "१२ जुलै २०२६",
    ].join("\n"),
    expect: { bank: "IDBI Bank", app: "Google Pay", amount: 1500 },
  },
  {
    name: "Hindi mixed receipt -> Bank of Baroda",
    text: [
      "Paytm",
      "राशि: ₹2,750",
      "प्रति: राज कुमार",
      "भुगतान सफल",
      "UPI Ref No. 135792468013",
      "Bank of Baroda",
    ].join("\n"),
    expect: { bank: "Bank of Baroda", app: "Paytm", amount: 2750 },
  },
  {
    name: "No labeled UTR, bare digit-run fallback",
    text: ["PhonePe", "₹430", "To Kisan Bhandar", "Success", "234567890123"].join("\n"),
    expect: { app: "PhonePe", status: "SUCCESS", amount: 430, utr: "234567890123" },
  },
  {
    name: "UPI ID extraction, sender via 'From' label",
    text: [
      "Google Pay",
      "From Ramesh Deshmukh",
      "ramesh.deshmukh@okhdfcbank",
      "₹600",
      "To Nursery ERP",
      "UTR: 345678901234",
    ].join("\n"),
    expect: { sender: "Ramesh Deshmukh", receiver: "Nursery ERP", upiId: "ramesh.deshmukh@okhdfcbank" },
  },
  {
    name: "Email in footer must NOT be mistaken for a UPI ID",
    text: [
      "PhonePe",
      "₹1,200",
      "To Nursery ERP",
      "UTR: 456789012345",
      "Support: help@phonepe.com",
    ].join("\n"),
    expect: { upiId: null },
  },
];

let passed = 0;
let failed = 0;

for (const testCase of cases) {
  const result = parseTransaction({ text: testCase.text });
  const mismatches = [];
  for (const [key, expected] of Object.entries(testCase.expect)) {
    if (result[key] !== expected) {
      mismatches.push(`${key}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(result[key])}`);
    }
  }

  if (mismatches.length === 0) {
    passed++;
    console.log(`PASS  ${testCase.name}`);
  } else {
    failed++;
    console.log(`FAIL  ${testCase.name}`);
    for (const m of mismatches) console.log(`        ${m}`);
  }
}

console.log(`\n${passed}/${cases.length} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
