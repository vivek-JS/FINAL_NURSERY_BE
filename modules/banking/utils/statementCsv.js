/**
 * Parser for bank statement exports an accountant downloads from net banking.
 *
 * Banks disagree on almost everything — column names, date order, whether a
 * credit is its own column or a sign — so this matches headers loosely and
 * normalises to the BankStatementEntry shape. Credits are positive, debits
 * negative, which is the sign convention the reconciliation engine expects.
 */

/** Split one CSV line, honouring "quoted, fields" and "" escapes. */
export function splitCsvLine(line) {
  const out = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === "," || ch === "\t") {
      out.push(field.trim());
      field = "";
    } else {
      field += ch;
    }
  }
  out.push(field.trim());
  return out;
}

const HEADER_ALIASES = {
  txnDate: ["txn date", "transaction date", "tran date", "date", "posting date", "value date"],
  narration: ["description", "narration", "particulars", "remarks", "transaction remarks", "details"],
  reference: [
    "ref no./cheque no.",
    "ref no/cheque no",
    "reference no",
    "ref no",
    "reference",
    "cheque no",
    "cheque number",
    "utr",
    "utr no",
    "rrn",
  ],
  debit: ["debit", "withdrawal", "withdrawal amt", "withdrawal amount", "dr", "debit amount"],
  credit: ["credit", "deposit", "deposit amt", "deposit amount", "cr", "credit amount"],
  amount: ["amount", "txn amount", "transaction amount"],
  balance: ["balance", "closing balance", "running balance", "available balance"],
};

function canonicalHeader(cell) {
  const key = String(cell || "")
    .toLowerCase()
    .replace(/[()₹]/g, "")
    .replace(/[\s_.]+/g, " ")
    .trim();
  if (!key) return null;

  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    if (aliases.includes(key)) return field;
  }
  // "withdrawal amt (inr)" and friends — fall back to a prefix match.
  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    if (aliases.some((a) => key.startsWith(a))) return field;
  }
  return null;
}

/**
 * Bank exports often carry a few preamble lines (account holder, address,
 * statement period) before the real header, so find the first row that maps
 * to a date column plus at least one money column.
 */
function findHeaderRow(rows) {
  for (let i = 0; i < Math.min(rows.length, 30); i += 1) {
    const mapped = rows[i].map(canonicalHeader);
    const hasDate = mapped.includes("txnDate");
    const hasMoney =
      mapped.includes("credit") || mapped.includes("debit") || mapped.includes("amount");
    if (hasDate && hasMoney) return { index: i, mapped };
  }
  return null;
}

/** "1,23,456.78" / "₹1,500.00 Cr" / "(250.00)" -> Number, or null. */
export function parseAmount(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s || s === "-" || s === "—") return null;

  let sign = 1;
  if (/^\(.*\)$/.test(s)) {
    sign = -1;
    s = s.slice(1, -1);
  }
  if (/\bdr\b/i.test(s)) sign = -1;
  s = s.replace(/\b[cd]r\b/gi, "");
  s = s.replace(/[₹$,\s]/g, "");
  if (s.startsWith("-")) {
    sign = -1;
    s = s.slice(1);
  }
  if (!s || !/^\d*\.?\d+$/.test(s)) return null;

  const n = Number(s);
  return Number.isFinite(n) ? sign * n : null;
}

const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/**
 * Indian bank exports are overwhelmingly day-first, so an ambiguous 03/04/2026
 * is read as 3 April. ISO (yyyy-mm-dd) is detected separately and kept exact.
 */
export function parseStatementDate(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;

  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    const d = new Date(Date.UTC(+iso[1], +iso[2] - 1, +iso[3]));
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const named = s.match(/^(\d{1,2})[-/\s]([A-Za-z]{3,})[-/\s](\d{2,4})/);
  if (named) {
    const month = MONTHS[named[2].slice(0, 3).toLowerCase()];
    if (month == null) return null;
    let year = Number(named[3]);
    if (year < 100) year += 2000;
    const d = new Date(Date.UTC(year, month, Number(named[1])));
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const numeric = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})/);
  if (numeric) {
    let year = Number(numeric[3]);
    if (year < 100) year += 2000;
    const day = Number(numeric[1]);
    const month = Number(numeric[2]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    const d = new Date(Date.UTC(year, month - 1, day));
    return Number.isNaN(d.getTime()) ? null : d;
  }

  return null;
}

/**
 * A UTR is a 12-digit (UPI/IMPS RRN) or 16-character alphanumeric (NEFT/RTGS)
 * token. Bank narrations bury it between slashes, e.g.
 * "UPI/CR/412345678901/RAHUL/HDFC". Pulled out so a payment's UTR can match
 * even when the reference column is blank.
 */
export function extractReference(reference, narration) {
  const ref = String(reference || "").trim();
  if (ref && ref !== "-") return ref;

  const text = String(narration || "");
  const tokens = text.split(/[\s/|,;:]+/).filter(Boolean);
  const utrLike = tokens.find(
    (t) => /^\d{12,22}$/.test(t) || /^[A-Z]{4}[A-Za-z0-9]{10,18}$/.test(t)
  );
  return utrLike || "";
}

/**
 * Parse a bank statement CSV/TSV export.
 *
 * @param {string} text raw file contents
 * @returns {{ ok: boolean, error?: string, rows: Array, skipped: Array }}
 */
export function parseStatementCsv(text) {
  const raw = String(text || "").replace(/^\uFEFF/, "");
  if (!raw.trim()) return { ok: false, error: "The file is empty", rows: [], skipped: [] };

  const lines = raw.split(/\r\n|\n|\r/).filter((l) => l.trim() !== "");
  const grid = lines.map(splitCsvLine);

  const header = findHeaderRow(grid);
  if (!header) {
    return {
      ok: false,
      error:
        "Could not find a header row with a date column and a credit, debit or amount column",
      rows: [],
      skipped: [],
    };
  }

  const columnOf = {};
  header.mapped.forEach((field, i) => {
    if (field && columnOf[field] == null) columnOf[field] = i;
  });

  const rows = [];
  const skipped = [];

  for (let i = header.index + 1; i < grid.length; i += 1) {
    const cells = grid[i];
    const lineNo = i + 1;
    const cell = (field) => (columnOf[field] == null ? "" : cells[columnOf[field]] ?? "");

    const txnDate = parseStatementDate(cell("txnDate"));
    if (!txnDate) {
      // Trailing totals and footers land here; only complain about rows that
      // look like they were meant to be transactions.
      if (cells.some((c) => parseAmount(c) != null)) {
        skipped.push({ line: lineNo, reason: "unreadable date", value: cell("txnDate") });
      }
      continue;
    }

    const credit = parseAmount(cell("credit"));
    const debit = parseAmount(cell("debit"));
    const plain = parseAmount(cell("amount"));

    let amount = null;
    if (credit != null && credit !== 0) amount = Math.abs(credit);
    else if (debit != null && debit !== 0) amount = -Math.abs(debit);
    else if (plain != null && plain !== 0) amount = plain;

    if (amount == null) {
      skipped.push({ line: lineNo, reason: "no credit or debit amount" });
      continue;
    }

    const narration = cell("narration");
    rows.push({
      txnDate,
      amount,
      referenceNumber: extractReference(cell("reference"), narration),
      narration,
      txnType: amount > 0 ? "CREDIT" : "DEBIT",
      balance: parseAmount(cell("balance")) ?? undefined,
    });
  }

  if (!rows.length) {
    return { ok: false, error: "No transaction rows could be read from the file", rows, skipped };
  }
  return { ok: true, rows, skipped };
}
