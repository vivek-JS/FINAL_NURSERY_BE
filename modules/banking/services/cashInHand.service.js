/**
 * Cash in hand per employee.
 *
 * cash in hand = cash received (order + bulk payments in Cash, not rejected)
 *              − cash spent (itar kharch, except bank-deposit entries)
 *              − cash deposited to bank (cash book deposits, not cancelled)
 *
 * Counting starts at BANKING_CASHBOOK_START_DATE. Earlier cash was never
 * deposited through the cash book, so including it would show balances that
 * nobody actually holds.
 */

import mongoose from "mongoose";
import Order from "../../../models/order.model.js";
import AgriSalesOrder from "../../../models/agriSalesOrder.model.js";
import BulkPayment from "../../../models/bulkPayment.model.js";
import ItarKharchEntry from "../../../models/itarKharchEntry.model.js";
import User from "../../../models/user.model.js";
import CashBook from "../models/cashBook.model.js";

export const BANK_DEPOSIT_CATEGORIES = ["बँक जमा", "bank deposit", "Bank Deposit", "BANK DEPOSIT"];

const RECEIVED = ["COLLECTED", "BANK_VERIFIED"];
const OPEN = ["PENDING"];

export function cashbookStartDate() {
  const raw = process.env.BANKING_CASHBOOK_START_DATE || "2026-10-01";
  const d = new Date(`${String(raw).slice(0, 10)}T00:00:00+05:30`);
  return Number.isNaN(d.getTime()) ? new Date("2026-10-01T00:00:00+05:30") : d;
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function toObjectId(id) {
  if (!id) return null;
  if (id instanceof mongoose.Types.ObjectId) return id;
  return mongoose.Types.ObjectId.isValid(String(id)) ? new mongoose.Types.ObjectId(String(id)) : null;
}

/**
 * Cash payment rows on an order collection, one per row, with the employee who
 * holds the cash: whoever recorded the payment, else the order's sales person.
 */
function orderCashPipeline({ start, employeeId, fallbackFields }) {
  const holder = fallbackFields.reduceRight(
    (acc, field) => ({ $ifNull: [`$${field}`, acc] }),
    null
  );
  const pipeline = [
    { $match: { "payment.modeOfPayment": "Cash" } },
    { $unwind: "$payment" },
    {
      $match: {
        "payment.modeOfPayment": "Cash",
        "payment.paymentDate": { $gte: start },
        "payment.paymentStatus": { $in: [...RECEIVED, ...OPEN] },
        "payment.isWalletPayment": { $ne: true },
        "payment.isDiscount": { $ne: true },
        $and: [
          { $or: [{ "payment.mainPaymentId": null }, { "payment.mainPaymentId": { $exists: false } }] },
          {
            $or: [
              { "payment.transferredFromOrderId": null },
              { "payment.transferredFromOrderId": { $exists: false } },
            ],
          },
        ],
      },
    },
    {
      $project: {
        employee: { $ifNull: ["$payment.paymentRecordedBy", holder] },
        amount: "$payment.paidAmount",
        status: "$payment.paymentStatus",
        date: "$payment.paymentDate",
        paymentId: "$payment._id",
        orderNo: { $ifNull: ["$orderId", "$orderNumber"] },
        party: { $ifNull: ["$customerName", "$farmer.name"] },
      },
    },
  ];
  if (employeeId) pipeline.push({ $match: { employee: employeeId } });
  return pipeline;
}

async function loadMovements({ employeeId } = {}) {
  const start = cashbookStartDate();
  const emp = employeeId ? toObjectId(employeeId) : null;
  if (employeeId && !emp) return { start, rows: [] };

  const [plant, agri, bulk, spent, deposits] = await Promise.all([
    Order.aggregate(orderCashPipeline({ start, employeeId: emp, fallbackFields: ["salesPerson"] })),
    AgriSalesOrder.aggregate(
      orderCashPipeline({ start, employeeId: emp, fallbackFields: ["salesPerson", "createdBy"] })
    ),
    BulkPayment.find({
      modeOfPayment: "Cash",
      paymentDate: { $gte: start },
      ...(emp ? { createdBy: emp } : {}),
    })
      .select("totalAmount paymentStatus paymentDate createdBy remark")
      .lean(),
    ItarKharchEntry.find({ entryDate: { $gte: start }, ...(emp ? { createdBy: emp } : {}) })
      .select("amount category note entryDate createdBy")
      .lean(),
    CashBook.find({
      entryType: "CASH_IN",
      entryDate: { $gte: start },
      cancelledAt: null,
      depositedBy: emp ? emp : { $ne: null },
    })
      .select("amount entryDate depositedBy depositVerified slipNumber accountNumber slipPhotos")
      .lean(),
  ]);

  const rows = [];
  for (const p of [...plant.map((r) => ({ ...r, src: "PLANT" })), ...agri.map((r) => ({ ...r, src: "AGRI" }))]) {
    rows.push({
      kind: "RECEIVED",
      confirmed: RECEIVED.includes(p.status),
      employee: p.employee ? String(p.employee) : null,
      amount: Number(p.amount) || 0,
      date: p.date,
      refId: String(p.paymentId),
      title: p.orderNo != null ? `Order ${p.orderNo}` : "Order payment",
      detail: p.party || "",
      source: p.src,
      status: p.status,
    });
  }
  for (const b of bulk) {
    rows.push({
      kind: "RECEIVED",
      confirmed: b.paymentStatus === "ACCEPTED",
      employee: b.createdBy ? String(b.createdBy) : null,
      amount: Number(b.totalAmount) || 0,
      date: b.paymentDate,
      refId: String(b._id),
      title: "Bulk payment",
      detail: b.remark || "",
      source: "BULK",
      status: b.paymentStatus,
    });
  }
  for (const e of spent) {
    const bankNote = BANK_DEPOSIT_CATEGORIES.includes(String(e.category || "").trim());
    rows.push({
      kind: bankNote ? "NOTED_DEPOSIT" : "SPENT",
      employee: e.createdBy ? String(e.createdBy) : null,
      amount: Number(e.amount) || 0,
      date: e.entryDate,
      refId: String(e._id),
      title: e.category || "Expense",
      detail: e.note || "",
      source: "ITAR_KHARCH",
    });
  }
  for (const d of deposits) {
    rows.push({
      kind: "DEPOSITED",
      confirmed: Boolean(d.depositVerified),
      employee: d.depositedBy ? String(d.depositedBy) : null,
      amount: Number(d.amount) || 0,
      date: d.entryDate,
      refId: String(d._id),
      title: d.slipNumber ? `Bank deposit · slip ${d.slipNumber}` : "Bank deposit",
      detail: d.accountNumber || "",
      source: "CASH_BOOK",
      photos: d.slipPhotos || [],
    });
  }

  return { start, rows };
}

function emptySummary(employeeId) {
  return {
    employeeId,
    received: 0,
    receivedConfirmed: 0,
    receivedAwaiting: 0,
    spent: 0,
    deposited: 0,
    depositedVerified: 0,
    depositedUnverified: 0,
    notedDepositInApp: 0,
    cashInHand: 0,
    lastActivity: null,
  };
}

function addRow(s, r) {
  if (r.kind === "RECEIVED") {
    s.received += r.amount;
    if (r.confirmed) s.receivedConfirmed += r.amount;
    else s.receivedAwaiting += r.amount;
  } else if (r.kind === "SPENT") {
    s.spent += r.amount;
  } else if (r.kind === "DEPOSITED") {
    s.deposited += r.amount;
    if (r.confirmed) s.depositedVerified += r.amount;
    else s.depositedUnverified += r.amount;
  } else if (r.kind === "NOTED_DEPOSIT") {
    s.notedDepositInApp += r.amount;
  }
  const t = r.date ? new Date(r.date) : null;
  if (t && !Number.isNaN(t.getTime()) && (!s.lastActivity || t > s.lastActivity)) s.lastActivity = t;
}

function finish(s) {
  for (const k of [
    "received",
    "receivedConfirmed",
    "receivedAwaiting",
    "spent",
    "deposited",
    "depositedVerified",
    "depositedUnverified",
    "notedDepositInApp",
  ]) {
    s[k] = round2(s[k]);
  }
  s.cashInHand = round2(s.received - s.spent - s.deposited);
  return s;
}

/** Pure summary over movement rows (exported for tests). */
export function summarizeCashMovements(rows) {
  const byEmployee = new Map();
  for (const r of rows) {
    const key = r.employee || "UNKNOWN";
    if (!byEmployee.has(key)) byEmployee.set(key, emptySummary(r.employee || null));
    addRow(byEmployee.get(key), r);
  }
  return [...byEmployee.values()].map(finish);
}

async function attachUsers(list) {
  const ids = list.map((s) => toObjectId(s.employeeId)).filter(Boolean);
  const users = ids.length
    ? await User.find({ _id: { $in: ids } }).select("name phoneNumber jobTitle role").lean()
    : [];
  const byId = new Map(users.map((u) => [String(u._id), u]));
  return list.map((s) => {
    const u = s.employeeId ? byId.get(String(s.employeeId)) : null;
    return {
      ...s,
      name: u?.name || (s.employeeId ? "Unknown user" : "Not linked to an employee"),
      phoneNumber: u?.phoneNumber != null ? String(u.phoneNumber) : "",
      role: u?.jobTitle || u?.role || "",
    };
  });
}

export async function listEmployeeCashInHand() {
  const { start, rows } = await loadMovements();
  const list = await attachUsers(summarizeCashMovements(rows));
  list.sort((a, b) => b.cashInHand - a.cashInHand || b.received - a.received);
  const totals = {};
  for (const k of ["received", "receivedAwaiting", "spent", "deposited", "depositedUnverified", "cashInHand"]) {
    totals[k] = round2(list.reduce((sum, s) => sum + s[k], 0));
  }
  return { startDate: start, employees: list, totals };
}

/** One employee's cash book: summary plus every movement, newest first, with running balance. */
export async function getEmployeeCashBook(employeeId) {
  const emp = toObjectId(employeeId);
  if (!emp) return { ok: false, error: "Invalid employee" };
  const { start, rows } = await loadMovements({ employeeId: emp });
  const [summary] = await attachUsers([
    summarizeCashMovements(rows)[0] || finish(emptySummary(String(emp))),
  ]);

  const sorted = [...rows].sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0));
  let balance = 0;
  const entries = sorted.map((r) => {
    if (r.kind === "RECEIVED") balance += r.amount;
    else if (r.kind === "SPENT" || r.kind === "DEPOSITED") balance -= r.amount;
    return { ...r, balanceAfter: round2(balance) };
  });
  entries.reverse();
  return { ok: true, startDate: start, employee: summary, entries };
}

export async function cashInHandOf(employeeId) {
  const emp = toObjectId(employeeId);
  if (!emp) return null;
  const { rows } = await loadMovements({ employeeId: emp });
  const [s] = summarizeCashMovements(rows);
  return s ? s.cashInHand : 0;
}
