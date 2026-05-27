import { roundMoney } from "../domain/roundMoney.js";

/**
 * @typedef {Object} JournalLineDraft
 * @property {string} accountCode
 * @property {number} [debit]
 * @property {number} [credit]
 * @property {string} [partyType]
 * @property {string} [partyId]
 * @property {string} [sourceLineRef]
 * @property {Object} [metadata]
 */

export class JournalBuilder {
  constructor() {
    /** @type {JournalLineDraft[]} */
    this.lines = [];
  }

  addLine({ accountCode, debit = 0, credit = 0, partyType, partyId, sourceLineRef, metadata }) {
    const d = roundMoney(Math.abs(debit));
    const c = roundMoney(Math.abs(credit));
    if (d === 0 && c === 0) return this;
    if (d > 0 && c > 0) throw new Error("Line cannot have both debit and credit");
    this.lines.push({
      accountCode,
      debit: d,
      credit: c,
      partyType,
      partyId,
      sourceLineRef,
      metadata,
    });
    return this;
  }

  dr(accountCode, amount, extras = {}) {
    return this.addLine({ accountCode, debit: amount, ...extras });
  }

  cr(accountCode, amount, extras = {}) {
    return this.addLine({ accountCode, credit: amount, ...extras });
  }

  getTotals() {
    let totalDebit = 0;
    let totalCredit = 0;
    for (const l of this.lines) {
      totalDebit += l.debit || 0;
      totalCredit += l.credit || 0;
    }
    return {
      totalDebit: roundMoney(totalDebit),
      totalCredit: roundMoney(totalCredit),
    };
  }

  assertBalanced() {
    const { totalDebit, totalCredit } = this.getTotals();
    if (totalDebit !== totalCredit) {
      throw new Error(
        `Journal not balanced: debit=${totalDebit} credit=${totalCredit}`
      );
    }
    if (totalDebit === 0) {
      throw new Error("Journal has no lines");
    }
    return { totalDebit, totalCredit };
  }
}
