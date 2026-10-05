/**
 * Shared, side-effect free matching of the paper shed stock against the system payload
 * (output of loadShedStockPayload). Matching is done on CANONICAL batch names (see batchNames.mjs),
 * so it already reflects the batch rename / merge.
 */
import { canonicalName } from "./batchNames.mjs";

export const TOL = 0.1;

export const ist = (v) => {
  if (!v) return null;
  const x = new Date(v);
  return Number.isNaN(x.getTime()) ? null : new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(x);
};
export const shiftDay = (day, n) => {
  const x = new Date(`${day}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};
export const short = (day) => (day ? `${day.slice(8)}/${day.slice(5, 7)}` : "-");
export const fmt = (n) => Number(n || 0).toLocaleString("en-IN");
export const pct = (delta, base) => (base > 0 ? (delta / base) * 100 : delta === 0 ? 0 : null);

export function flattenSystem(payload) {
  const lines = [];
  for (const shed of payload.sheds || []) {
    for (const b of shed.batches || []) {
      const canon = canonicalName(b.batchNumber);
      for (const l of b.lines || []) {
        lines.push({
          shed: shed.shed,
          batch: b.batchNumber, // current (old) master name
          canon, // name it will have after the rename / merge (null = not in the owner's list)
          batchId: String(b.batchId),
          inwardId: String(l.inwardId),
          lagwad: ist(l.lagwadDate),
          cavity: l.cavity,
          size: l.size,
          remaining: Number(l.remaining ?? 0),
          sowed: Number(l.sowed ?? 0),
          claimed: false,
        });
      }
    }
  }
  return lines;
}

function statusFor(paper, sys, hasSys) {
  if (paper === sys) return "OK";
  if (!hasSys && paper > 0) return "MISSING IN SYSTEM";
  if (paper === 0 && sys > 0) return "SYSTEM ONLY";
  return paper > sys ? "SYSTEM LOW" : "SYSTEM HIGH";
}

/**
 * @returns {{rows, shedTotals, sysLines, shedNames}}
 *  row.op is the machine readable instruction used by the apply script:
 *    { kind: "dated"|"loose"|"zero"|"move"|"skip-shed", delta, batch, lines, ... }
 */
export function reconcile(payload, PAPER, AS_ON) {
  const sysLines = flattenSystem(payload);
  const shedNames = [...new Set(sysLines.map((l) => l.shed))];
  const sysByShed = (s) => sysLines.filter((l) => l.shed === s);
  const shedKeyOf = (name) => shedNames.find((n) => n === name) ?? shedNames.find((n) => n.split("(").pop() === name.split("(").pop());

  const rows = [];
  const shedTotals = [];

  for (const paperShed of PAPER) {
    const sysShed = shedKeyOf(paperShed.shed);
    const pool = sysShed ? sysByShed(sysShed) : [];
    const paperSum = paperShed.lines.reduce((s, l) => s + l.qty, 0);

    // ---- dated paper lines
    for (const pl of paperShed.lines.filter((l) => l.kind === "dated")) {
      const cands = pool.filter((l) => l.canon === pl.batch && !l.claimed);
      let claimed = cands.filter((l) => pl.dates.includes(l.lagwad));
      let note = pl.note || "";
      if (!claimed.length) {
        const near = cands.filter((l) => pl.dates.some((d) => [-1, 1].includes((new Date(l.lagwad) - new Date(d)) / 864e5)));
        if (near.length) {
          claimed = near;
          note += ` | system date ${[...new Set(near.map((l) => short(l.lagwad)))].join(",")} is 1 day off paper`;
        }
      }
      let wrongShed = null;
      if (!claimed.length) {
        const elsewhere = sysLines.filter((l) => l.shed !== sysShed && l.canon === pl.batch && !l.claimed && pl.dates.includes(l.lagwad));
        if (elsewhere.length) {
          wrongShed = elsewhere;
          note += ` | system has this batch+date in ${[...new Set(elsewhere.map((l) => l.shed))].join(",")}`;
        }
      }
      claimed.forEach((l) => (l.claimed = true));
      const sys = claimed.reduce((s, l) => s + l.remaining, 0);
      const delta = pl.qty - sys;
      rows.push({
        shed: paperShed.shed,
        sysShed,
        type: "LAGWAD (dated)",
        item: `${pl.batch}  lagwad ${pl.dates.map(short).join(" + ")}`,
        paper: pl.qty,
        system: sys,
        diff: delta,
        diffPct: pct(delta, sys),
        within10: sys > 0 ? Math.abs(delta) / sys <= TOL : "",
        status: wrongShed ? "WRONG SHED IN SYSTEM" : statusFor(pl.qty, sys, claimed.length > 0),
        action: "",
        systemLines: claimed.map((l) => `${l.batch} ${short(l.lagwad)} = ${fmt(l.remaining)}`).join("; "),
        note: note.trim(),
        op: wrongShed
          ? {
              kind: "move",
              batch: pl.batch,
              lines: wrongShed,
              toShed: sysShed,
              delta: 0,
              then: { delta: pl.qty - wrongShed.reduce((s, l) => s + l.remaining, 0) },
            }
          : { kind: "dated", batch: pl.batch, delta, lines: claimed, pl },
      });
      if (wrongShed) wrongShed.forEach((l) => (l.claimed = true));
    }

    // ---- loose paper lines: one row per canonical batch (all its stock in this shed)
    const looseBatches = [...new Set(paperShed.lines.filter((l) => l.kind === "loose").map((l) => l.batch))];
    for (const b of looseBatches) {
      const pls = paperShed.lines.filter((l) => l.kind === "loose" && l.batch === b);
      const paper = pls.reduce((s, l) => s + l.qty, 0);
      const cands = pool.filter((l) => !l.claimed && l.canon === b);
      cands.forEach((l) => (l.claimed = true));
      const sys = cands.reduce((s, l) => s + l.remaining, 0);
      const delta = paper - sys;
      rows.push({
        shed: paperShed.shed,
        sysShed,
        type: "STOCK (no date)",
        item: `${b}  [${pls.map((l) => l.label).join(" + ")}]`,
        paper,
        system: sys,
        diff: delta,
        diffPct: pct(delta, sys),
        within10: sys > 0 ? Math.abs(delta) / sys <= TOL : "",
        status: statusFor(paper, sys, cands.length > 0),
        action: "",
        systemLines: cands.map((l) => `${l.batch}${l.lagwad ? " " + short(l.lagwad) : ""} = ${fmt(l.remaining)}`).join("; "),
        note: pls.map((l) => l.note).filter(Boolean).join(" | "),
        op: { kind: "loose", batch: b, delta, lines: cands, paperLines: pls },
      });
    }

    // ---- system stock in this shed that the paper never mentions
    for (const l of pool.filter((x) => !x.claimed && x.remaining > 0)) {
      rows.push({
        shed: paperShed.shed,
        sysShed,
        type: "NOT ON PAPER",
        item: `${l.canon || l.batch}${l.lagwad ? "  lagwad " + short(l.lagwad) : ""}  (now ${l.batch})`,
        paper: 0,
        system: l.remaining,
        diff: -l.remaining,
        diffPct: -100,
        within10: false,
        status: "SYSTEM ONLY",
        action: "",
        systemLines: `${l.batch}`,
        note: "",
        op: { kind: "zero", batch: l.canon || l.batch, delta: -l.remaining, lines: [l] },
      });
      l.claimed = true;
    }

    const sysTotal = pool.reduce((s, l) => s + l.remaining, 0);
    shedTotals.push({
      shed: paperShed.shed,
      sysShed,
      writtenTotal: paperShed.writtenTotal,
      paperLinesSum: paperSum,
      paperInternalGap: paperSum - paperShed.writtenTotal,
      system: sysTotal,
      diff: paperShed.writtenTotal - sysTotal,
      diffPct: pct(paperShed.writtenTotal - sysTotal, sysTotal),
    });
  }

  // sheds that exist in the system but are not on the paper
  const paperShedKeys = new Set(PAPER.map((p) => shedKeyOf(p.shed)));
  for (const s of shedNames) {
    if (paperShedKeys.has(s)) continue;
    const pool = sysByShed(s).filter((l) => l.remaining > 0);
    const sum = pool.reduce((a, l) => a + l.remaining, 0);
    shedTotals.push({ shed: `${s}  (NOT ON PAPER)`, sysShed: s, writtenTotal: 0, paperLinesSum: 0, paperInternalGap: 0, system: sum, diff: -sum, diffPct: sum ? -100 : 0 });
    for (const l of pool)
      rows.push({
        shed: `${s}  (NOT ON PAPER)`,
        sysShed: s,
        type: "NOT ON PAPER",
        item: `${l.canon || l.batch}${l.lagwad ? "  lagwad " + short(l.lagwad) : ""}  (now ${l.batch})`,
        paper: 0,
        system: l.remaining,
        diff: -l.remaining,
        diffPct: -100,
        within10: false,
        status: "SHED NOT ON PAPER",
        action: "",
        systemLines: l.batch,
        note: "",
        op: { kind: "skip-shed", batch: l.canon || l.batch, delta: -l.remaining, lines: [l] },
      });
  }

  return { rows, shedTotals, sysLines, shedNames };
}
