/**
 * End-to-end test of employee cash in hand and cash deposits with slip photos,
 * against a throwaway local database that is dropped at the end.
 *
 * Usage: node scripts/test-banking-cashbook.mjs
 *        BANKING_TEST_MONGO_URL=mongodb://127.0.0.1:27017 node scripts/...
 */
import crypto from "crypto";
import mongoose from "mongoose";

const BASE = process.env.BANKING_TEST_MONGO_URL || "mongodb://127.0.0.1:27017";
const DB_NAME = `banking_cashbook_test_${Date.now()}`;
const ACCOUNT = "000405001234";
const DAY = 24 * 60 * 60 * 1000;
const PHOTO = "https://res.cloudinary.com/demo/image/upload/slip.jpg";

const daysAgo = (n) => {
  const d = new Date(Date.now() - n * DAY);
  d.setHours(12, 0, 0, 0);
  return d;
};
const ymd = (d) => d.toISOString().slice(0, 10);

process.env.BANKING_CASHBOOK_START_DATE = ymd(daysAgo(30));

const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

await mongoose.connect(`${BASE}/${DB_NAME}`);

const { default: AgriSalesOrder } = await import("../models/agriSalesOrder.model.js");
const { default: Order } = await import("../models/order.model.js");
const { default: BulkPayment } = await import("../models/bulkPayment.model.js");
const { default: ItarKharchEntry } = await import("../models/itarKharchEntry.model.js");
const { default: User } = await import("../models/user.model.js");
const { default: BankStatementEntry } = await import("../models/bankStatementEntry.model.js");
const { listEmployeeCashInHand, getEmployeeCashBook, cashInHandOf } = await import(
  "../modules/banking/services/cashInHand.service.js"
);
const { createCashDeposit, cancelCashDeposit, verifyCashDeposit, listCashDeposits } = await import(
  "../modules/banking/services/cashDeposit.service.js"
);

const A = new mongoose.Types.ObjectId();
const B = new mongoose.Types.ObjectId();
const ACCOUNTANT = new mongoose.Types.ObjectId();

async function agriOrder(createdBy, payments) {
  return AgriSalesOrder.create({
    orderNumber: `T-${crypto.randomUUID().slice(0, 8)}`,
    customerName: "Test Customer",
    customerMobile: "9999999999",
    productId: new mongoose.Types.ObjectId(),
    productName: "Test product",
    quantity: 1,
    unit: "pieces",
    rate: 100000,
    totalAmount: 100000,
    createdBy,
    payment: payments.map((p) => ({ paymentDate: daysAgo(2), modeOfPayment: "Cash", ...p })),
  });
}

try {
  console.log(`\nDatabase ${DB_NAME}\n`);

  await User.collection.insertMany([
    { _id: A, name: "Asha Cashier", phoneNumber: 9000000001, jobTitle: "CASHIER" },
    { _id: B, name: "Bala Sales", phoneNumber: 9000000002, jobTitle: "SALES" },
  ]);

  // A: agri cash payments recorded by A.
  await agriOrder(new mongoose.Types.ObjectId(), [
    { paidAmount: 10000, paymentStatus: "COLLECTED", paymentRecordedBy: A },
    { paidAmount: 2000, paymentStatus: "PENDING", paymentRecordedBy: A },
    { paidAmount: 500, paymentStatus: "REJECTED", paymentRecordedBy: A },
    { paidAmount: 3000, paymentStatus: "COLLECTED", paymentRecordedBy: A, modeOfPayment: "UPI" },
    { paidAmount: 9999, paymentStatus: "COLLECTED", paymentRecordedBy: A, paymentDate: daysAgo(60) },
  ]);
  // Agri order with no recorder falls back to the order's creator.
  await agriOrder(A, [{ paidAmount: 250, paymentStatus: "COLLECTED" }]);

  // B: plant order, no recorder, falls back to the sales person. Bulk-linked row is skipped.
  await Order.collection.insertOne({
    orderId: 91001,
    salesPerson: B,
    payment: [
      { _id: new mongoose.Types.ObjectId(), paidAmount: 4000, paymentStatus: "COLLECTED", modeOfPayment: "Cash", paymentDate: daysAgo(3) },
      { _id: new mongoose.Types.ObjectId(), paidAmount: 800, paymentStatus: "COLLECTED", modeOfPayment: "Cash", paymentDate: daysAgo(3), mainPaymentId: new mongoose.Types.ObjectId() },
      { _id: new mongoose.Types.ObjectId(), paidAmount: 600, paymentStatus: "PENDING", modeOfPayment: "Cash", paymentDate: daysAgo(3), transferredFromOrderId: new mongoose.Types.ObjectId() },
      { _id: new mongoose.Types.ObjectId(), paidAmount: 300, paymentStatus: "COLLECTED", modeOfPayment: "Cash", paymentDate: daysAgo(3), isDiscount: true },
    ],
  });

  // A: bulk cash payment (counted once, from the bulk record).
  await BulkPayment.create({
    totalAmount: 1500,
    paymentDate: daysAgo(1),
    modeOfPayment: "Cash",
    paymentStatus: "PENDING",
    allocations: [{ orderId: new mongoose.Types.ObjectId(), amount: 1500, orderType: "ORDER" }],
    createdBy: A,
  });

  // A: an expense, and a bank deposit noted in the cashier app (shown, not subtracted).
  await ItarKharchEntry.create([
    { category: "Tea", amount: 700, entryDate: daysAgo(1), createdBy: A },
    { category: "बँक जमा", amount: 5000, entryDate: daysAgo(1), createdBy: A },
  ]);

  const expectedA = 10000 + 2000 + 250 + 1500 - 700;
  check("A cash in hand", (await cashInHandOf(A)) === expectedA, `${await cashInHandOf(A)} vs ${expectedA}`);
  check("B cash in hand (sales person fallback, bulk/transfer/discount rows skipped)", (await cashInHandOf(B)) === 4000);

  const list = await listEmployeeCashInHand();
  const rowA = list.employees.find((e) => String(e.employeeId) === String(A));
  check("list shows A with name", rowA?.name === "Asha Cashier");
  check("A received / awaiting split", rowA?.received === 13750 && rowA?.receivedAwaiting === 3500, JSON.stringify(rowA));
  check("A app-noted bank deposit reported separately", rowA?.notedDepositInApp === 5000 && rowA?.spent === 700);
  check("totals add up", list.totals.cashInHand === expectedA + 4000, String(list.totals.cashInHand));

  const base = { entryDate: ymd(new Date()), accountNumber: ACCOUNT, slipNumber: "S-1", userId: ACCOUNTANT };
  const noPhoto = await createCashDeposit({ ...base, amount: 1000, employeeId: A });
  check("deposit needs a slip photo", !noPhoto.ok && /photo/i.test(noPhoto.error));
  const noEmp = await createCashDeposit({ ...base, amount: 1000, slipPhotos: [PHOTO] });
  check("deposit needs an employee", !noEmp.ok && /employee/i.test(noEmp.error));
  const tooMuch = await createCashDeposit({ ...base, amount: expectedA + 1, employeeId: A, slipPhotos: [PHOTO] });
  check("deposit above cash in hand is refused", !tooMuch.ok && tooMuch.code === "EXCEEDS_CASH_IN_HAND", tooMuch.error);
  const early = await createCashDeposit({ ...base, entryDate: ymd(daysAgo(45)), amount: 100, employeeId: A, slipPhotos: [PHOTO] });
  check("deposit dated before the cash book start is refused", !early.ok);

  const d1 = await createCashDeposit({ ...base, amount: 12000, employeeId: A, slipPhotos: [PHOTO] });
  check("valid deposit saved", d1.ok && d1.cashInHandAfter === expectedA - 12000, JSON.stringify(d1.error || d1.cashInHandAfter));
  check("deposit keeps photo and employee", d1.deposit?.slipPhotos?.[0] === PHOTO && String(d1.deposit?.depositedBy) === String(A));
  check("cash in hand reduced", (await cashInHandOf(A)) === expectedA - 12000);

  const over = await createCashDeposit({ ...base, amount: expectedA - 12000 + 1, employeeId: A, slipPhotos: [PHOTO] });
  check("second deposit limited by remaining cash", !over.ok);

  const c1 = await cancelCashDeposit(d1.deposit._id, { userId: ACCOUNTANT, reason: "wrong amount" });
  check("unverified deposit can be cancelled", c1.ok);
  check("cancel gives the cash back", (await cashInHandOf(A)) === expectedA);
  const vCancelled = await verifyCashDeposit(d1.deposit._id);
  check("cancelled deposit cannot be verified", !vCancelled.ok);
  check("cancelled deposit hidden from list", (await listCashDeposits({})).every((d) => String(d._id) !== String(d1.deposit._id)));

  const d2 = await createCashDeposit({ ...base, slipNumber: "S-2", amount: 12000, employeeId: A, slipPhotos: [PHOTO] });
  await BankStatementEntry.create({
    accountNumber: ACCOUNT,
    txnDate: new Date(),
    amount: 12000,
    narration: "BY CASH DEPOSIT",
    source: "IMPORT",
    entryHash: crypto.randomUUID(),
  });
  const v2 = await verifyCashDeposit(d2.deposit._id, { userId: ACCOUNTANT });
  check("deposit matched to bank credit", v2.ok && v2.matched === true);
  const c2 = await cancelCashDeposit(d2.deposit._id, { userId: ACCOUNTANT });
  check("verified deposit cannot be cancelled", !c2.ok);

  const listed = await listCashDeposits({ employeeId: A });
  check("deposit list shows employee name", listed[0]?.depositedBy?.name === "Asha Cashier");

  const book = await getEmployeeCashBook(A);
  check("employee cash book balance", book.ok && book.employee.cashInHand === expectedA - 12000);
  check(
    "running balance ends at cash in hand",
    book.entries[0]?.balanceAfter === expectedA - 12000,
    `${book.entries[0]?.balanceAfter}`
  );
  check("cash book lists every movement", book.entries.length === 7, String(book.entries.length));
} catch (err) {
  console.error(err);
  check("no exception", false, err.message);
} finally {
  await mongoose.connection.db.dropDatabase();
  await mongoose.disconnect();
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
