#!/usr/bin/env python3
"""
Match rows in SALE (ALL) Excel to MongoDB orders by:
  farmer mobile number + farmer name (normalized; last 10 digits for phone).

The workbook may be encrypted — set SALE_EXCEL_PASSWORD in the environment.

Usage (from FINAL_NURSERY_BE, with .env containing PROD_MONGO_URL or MONGO_URL):
  export SALE_EXCEL_PASSWORD='your-password'
  ./.venv-sale/bin/python scripts/match_sale_sheet_orders.py "/path/to/SALE (ALL) 2026-2027.xlsx"

Optional second argument:
  - Path ending in .json  → also write summary JSON
  - Path ending in .xlsx  → write matched + unmatched sheets there
Always writes "<input_stem>_matched_unmatched.xlsx" next to the input unless second arg is .xlsx (that path).
"""
from __future__ import annotations

import io
import json
import os
import re
import sys
from pathlib import Path

# --- optional venv: pip install msoffcrypto-tool pandas openpyxl pymongo python-dotenv ---


def norm(s: str) -> str:
    if s is None or (isinstance(s, float) and str(s) == "nan"):
        return ""
    t = str(s).strip().lower()
    t = re.sub(r"\s+", " ", t)
    return t


def norm_mobile(v) -> str:
    """Digits only; use last 10 digits when length >= 10 (India)."""
    if v is None:
        return ""
    if isinstance(v, float):
        if str(v) == "nan" or (v != v):  # NaN
            return ""
        if abs(v - round(v)) < 1e-6:
            v = int(round(v))
        else:
            v = str(v)
    if isinstance(v, int):
        digits = re.sub(r"\D", "", str(v))
    else:
        s = str(v).strip()
        if not s or s.lower() == "nan":
            return ""
        digits = re.sub(r"\D", "", s)
    if not digits:
        return ""
    if len(digits) >= 10:
        return digits[-10:]
    return digits


HEADER_ALIASES = {
    "farmer": [
        "customer name",
        "farmer name",
        "farmer",
        "ग्राहक",
        "farmername",
        "cust name",
    ],
    "mobile": [
        "mo. no.",
        "mo no",
        "mobile no",
        "mobile number",
        "mobile",
        "phone",
        "phone no",
        "contact",
        "contact no",
        "cell",
        "मोबाइल",
        "mob",
        "tel",
    ],
}


def detect_columns(headers: list[str]) -> dict[str, int]:
    """Map role -> 0-based column index. Prefer longer / more specific aliases first."""
    hnorm = [norm(h) for h in headers]
    found: dict[str, int] = {}
    for role, aliases in HEADER_ALIASES.items():
        aliases_sorted = sorted(aliases, key=len, reverse=True)
        for i, h in enumerate(hnorm):
            if not h:
                continue
            for a in aliases_sorted:
                if h == a or h.startswith(a + " ") or h.endswith(" " + a):
                    found[role] = i
                    break
                if len(a) >= 4 and a in h:
                    found[role] = i
                    break
            if role in found:
                break
    if "farmer" not in found:
        for i, h in enumerate(hnorm):
            if h == "name":
                found["farmer"] = i
                break
    return found


def read_excel_rows(path: str, password: str | None) -> tuple[list[str], list[list]]:
    import msoffcrypto
    import pandas as pd

    raw = open(path, "rb")
    office = msoffcrypto.OfficeFile(raw)
    if office.is_encrypted():
        if not password:
            raise SystemExit(
                "Excel file is encrypted. Set environment variable SALE_EXCEL_PASSWORD."
            )
        office.load_key(password=password)
        buf = io.BytesIO()
        office.decrypt(buf)
        buf.seek(0)
        xl = pd.ExcelFile(buf)
    else:
        xl = pd.ExcelFile(path)

    sheet = xl.sheet_names[0]
    df = pd.read_excel(xl, sheet_name=sheet, header=0)
    df = df.dropna(how="all")
    headers = [str(c) for c in df.columns.tolist()]
    rows = df.values.tolist()
    return headers, rows


def load_order_map_mobile_name(uri: str) -> dict[tuple[str, str], list[int]]:
    """Map (norm_mobile_10_digit, norm_farmer_name) -> list of numeric orderId."""
    from pymongo import MongoClient

    client = MongoClient(uri)
    db = client.get_default_database()
    if db.name is None or db.name == "admin":
        raise SystemExit("Mongo URI must include database name, e.g. mongodb.net/nursery")

    orders = db["orders"]
    pipeline = [
        {
            "$match": {
                "dealerOrder": {"$ne": True},
                "farmer": {"$exists": True, "$ne": None},
            }
        },
        {"$lookup": {"from": "farmers", "localField": "farmer", "foreignField": "_id", "as": "f"}},
        {"$unwind": "$f"},
        {"$project": {"orderId": 1, "fn": "$f.name", "mob": "$f.mobileNumber"}},
    ]

    m: dict[tuple[str, str], list[int]] = {}
    for doc in orders.aggregate(pipeline, allowDiskUse=True):
        fn = norm(doc.get("fn") or "")
        mob = norm_mobile(doc.get("mob"))
        oid = doc.get("orderId")
        if not fn or not mob or oid is None:
            continue
        try:
            oi = int(oid)
        except (TypeError, ValueError):
            continue
        key = (mob, fn)
        m.setdefault(key, []).append(oi)

    client.close()
    return m


def row_to_dict(headers: list[str], row: list) -> dict:
    out = {}
    for i, h in enumerate(headers):
        v = row[i] if i < len(row) else None
        if hasattr(v, "isoformat"):
            v = v.isoformat()
        out[h] = v
    return out


def main() -> None:
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    xlsx_path = sys.argv[1]
    out_arg = sys.argv[2] if len(sys.argv) > 2 else None

    try:
        from dotenv import load_dotenv

        load_dotenv(Path(__file__).resolve().parent.parent / ".env")
    except ImportError:
        pass

    uri = os.environ.get("PROD_MONGO_URL") or os.environ.get("MONGO_URL") or os.environ.get("MONGODB_URI") or os.environ.get("DATABASE")
    if not uri:
        sys.exit("Set PROD_MONGO_URL or MONGO_URL in .env")

    password = os.environ.get("SALE_EXCEL_PASSWORD")

    headers, rows = read_excel_rows(xlsx_path, password)
    cols = detect_columns(headers)

    missing = [k for k in ("farmer", "mobile") if k not in cols]
    if missing:
        print("Could not auto-detect columns:", missing)
        print("Headers seen:", headers[:40])
        sys.exit(1)

    print("Using columns:", {k: headers[cols[k]] for k in cols})
    print("Match mode: mobile (10 digit) + farmer name")

    order_map = load_order_map_mobile_name(uri)
    keys = set(order_map.keys())

    matched_rows: list[dict] = []
    unmatched_rows: list[dict] = []
    matched = 0
    unmatched_samples: list[dict] = []
    data_rows = 0

    for row in rows:
        def cell(ci):
            if ci >= len(row):
                return None
            return row[ci]

        f = norm(cell(cols["farmer"]))
        mob = norm_mobile(cell(cols["mobile"]))
        if not f and not mob:
            continue
        data_rows += 1

        base = row_to_dict(headers, row)

        if not mob:
            rec = {
                **base,
                "_reason": "bad_or_missing_mobile",
                "_norm_farmer": f,
                "_norm_mobile": mob,
            }
            unmatched_rows.append(rec)
            if len(unmatched_samples) < 15:
                unmatched_samples.append({"reason": "bad_mobile", "farmer": f, "mobile": mob})
            continue

        if not f:
            rec = {
                **base,
                "_reason": "bad_or_missing_name",
                "_norm_farmer": f,
                "_norm_mobile": mob,
            }
            unmatched_rows.append(rec)
            if len(unmatched_samples) < 15:
                unmatched_samples.append({"reason": "bad_name", "farmer": f, "mobile": mob})
            continue

        key = (mob, f)
        if key in keys:
            oids = order_map.get(key, [])
            oid_str = ",".join(str(x) for x in sorted(set(oids))) if oids else ""
            matched_rows.append(
                {
                    **base,
                    "matched_order_id": oid_str,
                    "_norm_farmer": f,
                    "_norm_mobile": mob,
                }
            )
            matched += 1
        else:
            unmatched_rows.append(
                {
                    **base,
                    "_reason": "no_order_match_mobile_name",
                    "_norm_farmer": f,
                    "_norm_mobile": mob,
                }
            )
            if len(unmatched_samples) < 15:
                unmatched_samples.append({"reason": "no_order", "farmer": f, "mobile": mob})

    unmatched = data_rows - matched

    report = {
        "excelFile": xlsx_path,
        "sheetHeadersUsed": {k: headers[cols[k]] for k in cols},
        "matchMode": "mobile_and_name",
        "dataRowsScanned": data_rows,
        "matched": matched,
        "notMatched": unmatched,
        "mongoDistinctKeys": len(keys),
        "sampleUnmatched": unmatched_samples,
    }

    print(json.dumps(report, indent=2, ensure_ascii=False))

    import pandas as pd

    if out_arg and out_arg.lower().endswith(".json"):
        Path(out_arg).write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
        print("Wrote", out_arg)

    if out_arg and out_arg.lower().endswith(".xlsx"):
        out_xlsx = Path(out_arg)
    else:
        p = Path(xlsx_path)
        out_xlsx = p.parent / f"{p.stem}_matched_unmatched.xlsx"
    out_xlsx.parent.mkdir(parents=True, exist_ok=True)
    with pd.ExcelWriter(out_xlsx, engine="openpyxl") as writer:
        pd.DataFrame(matched_rows if matched_rows else [{"_note": "no matches"}]).to_excel(
            writer, sheet_name="matched", index=False
        )
        pd.DataFrame(unmatched_rows if unmatched_rows else [{"_note": "none"}]).to_excel(
            writer, sheet_name="unmatched", index=False
        )
    print("Wrote", out_xlsx.resolve())


if __name__ == "__main__":
    main()
