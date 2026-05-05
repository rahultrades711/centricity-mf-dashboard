"""
Screener Excel-to-JSON converter.

Validates an MF Screener Excel against data-contract/screener-v1.json,
then emits data/screener-YYYY-MM-DD.json matching the dashboard's expected shape.

Usage:
    python scripts/excel_to_json_screener.py <path-to-xlsx>
    python scripts/excel_to_json_screener.py data/MutualFund_Whitelisting_15Apr2026.xlsx

The build pipeline (GitHub Action, file-name-pattern routing) calls this on every
push that matches data/MutualFund_Whitelisting_*.xlsx. See CLAUDE.md §4.1.

No pandas dependency; openpyxl-only.
"""
from __future__ import annotations

import datetime as _dt
import json
import math
import re
import statistics as _stats
import sys
from collections import OrderedDict
from pathlib import Path
from typing import Any

import openpyxl
from openpyxl.utils import column_index_from_string, get_column_letter

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

REPO_ROOT = Path(__file__).resolve().parent.parent
CONTRACT_PATH = REPO_ROOT / "data-contract" / "screener-v1.json"
DATA_DIR = REPO_ROOT / "data"


# ---------------------------------------------------------------------------
# Schema-validation error
# ---------------------------------------------------------------------------

class SchemaError(RuntimeError):
    """Raised when the input Excel violates the contract."""


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _cell(ws, addr: str) -> Any:
    """Read a cell by 'A1' address."""
    m = re.match(r"^([A-Z]+)(\d+)$", addr)
    if not m:
        raise ValueError(f"Bad cell address: {addr!r}")
    col_letter, row = m.group(1), int(m.group(2))
    return ws.cell(row=row, column=column_index_from_string(col_letter)).value


def _safe_float(v: Any) -> float | None:
    if v is None or v == "":
        return None
    if isinstance(v, str):
        v = v.strip()
        if not v or v == "—" or v == "-":
            return None
        try:
            return float(v)
        except ValueError:
            return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _safe_int(v: Any) -> int | None:
    f = _safe_float(v)
    if f is None:
        return None
    return int(round(f))


def _safe_str(v: Any) -> str | None:
    if v is None:
        return None
    s = str(v).strip()
    return s if s else None


def _round(v: float | None, places: int = 4) -> float | None:
    if v is None:
        return None
    return round(v, places)


def _iso_date(v: Any) -> str | None:
    """Convert various date inputs to ISO YYYY-MM-DD."""
    if v is None:
        return None
    if isinstance(v, _dt.datetime):
        return v.date().isoformat()
    if isinstance(v, _dt.date):
        return v.isoformat()
    if isinstance(v, str):
        s = v.strip()
        # DD-MMM-YYYY (e.g., 28-Jul-2002)
        for fmt in ("%d-%b-%Y", "%d-%B-%Y", "%Y-%m-%d", "%d/%m/%Y", "%d-%m-%Y"):
            try:
                return _dt.datetime.strptime(s, fmt).date().isoformat()
            except ValueError:
                continue
    return None


def _display_date(iso: str | None) -> str | None:
    if iso is None:
        return None
    try:
        d = _dt.date.fromisoformat(iso)
    except ValueError:
        return None
    return d.strftime("%d %b %Y")


def _parse_warning_pct(s: str) -> float | None:
    """Extract trailing percentage from strings like '⚠️ 39.36%'."""
    m = re.search(r"(-?\d+(?:\.\d+)?)\s*%", s)
    if not m:
        return None
    return float(m.group(1))


def _classify_score(raw: Any) -> tuple[str, float | None, float | None]:
    """
    Returns (status, centricity_score_decimal, warning_pct).

    Ranked        : centricity_score_decimal = float, warning_pct = None
    1-3yr Warning : centricity_score_decimal = None,  warning_pct = float
    New Fund      : both None
    """
    if isinstance(raw, (int, float)) and not isinstance(raw, bool):
        return "Ranked", float(raw), None
    if isinstance(raw, str):
        s = raw.strip()
        if "New Fund" in s:
            return "New Fund Monitoring", None, None
        if s.startswith("⚠") or "⚠" in s:
            return "1-3yr Warning", None, _parse_warning_pct(s)
    # Fallback: unknown — treat as new-fund to avoid build failure but flag
    return "New Fund Monitoring", None, None


def _to_date(v: Any) -> _dt.date | None:
    if isinstance(v, _dt.datetime):
        return v.date()
    if isinstance(v, _dt.date):
        return v
    return None


def load_fund_nav(wb) -> tuple[dict[int, list[tuple[_dt.date, float]]], dict[int, str]]:
    """
    Stream 📈 Fund NAV once into memory.

    Returns:
        nav_by_amfi: { scheme_code(int) -> [ (date, nav), ... ] sorted ascending by date }
                     Only non-null NAVs included; only rows with a valid date.
        name_by_amfi: { scheme_code -> fund_name }
    """
    ws = wb["📈 Fund NAV"]
    rows = ws.iter_rows(values_only=True)
    row1 = next(rows)  # AMFI Code | <code> | <code> | ...
    row2 = next(rows)  # Fund Name | <name> | ...
    _ = next(rows)     # Date | None | ...

    # Build column index → AMFI code (skip col 0 which is the date column)
    col_to_amfi: dict[int, int] = {}
    name_by_amfi: dict[int, str] = {}
    for col_idx, code in enumerate(row1):
        if col_idx == 0:
            continue
        if code is None:
            continue
        try:
            amfi = int(code)
        except (TypeError, ValueError):
            continue
        col_to_amfi[col_idx] = amfi
        nm = row2[col_idx] if col_idx < len(row2) else None
        if nm is not None:
            name_by_amfi[amfi] = str(nm).strip()

    # Initialise per-AMFI lists
    nav_by_amfi: dict[int, list[tuple[_dt.date, float]]] = {a: [] for a in col_to_amfi.values()}

    for row in rows:
        if not row:
            continue
        d = _to_date(row[0])
        if d is None:
            continue
        for col_idx, amfi in col_to_amfi.items():
            if col_idx >= len(row):
                continue
            v = row[col_idx]
            if v is None:
                continue
            try:
                f = float(v)
            except (TypeError, ValueError):
                continue
            nav_by_amfi[amfi].append((d, f))

    # Sort each fund's series ascending by date (should already be, but be safe)
    for amfi in nav_by_amfi:
        nav_by_amfi[amfi].sort(key=lambda x: x[0])

    return nav_by_amfi, name_by_amfi


def load_benchmark_nav(wb) -> dict[str, list[tuple[_dt.date, float]]]:
    """Stream 📈 Benchmark NAV once into memory: { benchmark_name -> [ (date, nav), ... ] }."""
    ws = wb["📈 Benchmark NAV"]
    rows = ws.iter_rows(values_only=True)
    row1 = next(rows)  # Benchmark Name | <name> | ...
    _ = next(rows)     # Date | None | ...

    col_to_name: dict[int, str] = {}
    for col_idx, name in enumerate(row1):
        if col_idx == 0:
            continue
        if name is None:
            continue
        col_to_name[col_idx] = str(name).strip()

    bm_by_name: dict[str, list[tuple[_dt.date, float]]] = {n: [] for n in col_to_name.values()}

    for row in rows:
        if not row:
            continue
        d = _to_date(row[0])
        if d is None:
            continue
        for col_idx, name in col_to_name.items():
            if col_idx >= len(row):
                continue
            v = row[col_idx]
            if v is None:
                continue
            try:
                f = float(v)
            except (TypeError, ValueError):
                continue
            bm_by_name[name].append((d, f))

    for name in bm_by_name:
        bm_by_name[name].sort(key=lambda x: x[0])

    return bm_by_name


def _series_value_at_or_before(series: list[tuple[_dt.date, float]],
                               target: _dt.date) -> tuple[_dt.date | None, float | None]:
    """Bisect on a date-sorted series; return the latest (date, value) with date <= target."""
    if not series:
        return None, None
    # Binary search: rightmost index where series[i].date <= target
    lo, hi = 0, len(series) - 1
    if series[0][0] > target:
        return None, None
    if series[-1][0] <= target:
        return series[-1]
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if series[mid][0] <= target:
            lo = mid
        else:
            hi = mid - 1
    return series[lo]


def _trailing_return_pct(end_nav: float, start_nav: float, years: float) -> float | None:
    """Annualised CAGR as a percent (e.g. 12.34 for 12.34%)."""
    if end_nav is None or start_nav is None or start_nav <= 0 or years <= 0:
        return None
    try:
        cagr = (end_nav / start_nav) ** (1 / years) - 1
    except (ValueError, ZeroDivisionError, OverflowError):
        return None
    return round(cagr * 100, 4)


def _absolute_return_pct(end_nav: float, start_nav: float) -> float | None:
    """Simple period return as a percent (no annualisation)."""
    if end_nav is None or start_nav is None or start_nav <= 0:
        return None
    return round(((end_nav / start_nav) - 1) * 100, 4)


# ---------------------------------------------------------------------------
# Contract loading + validation
# ---------------------------------------------------------------------------

def load_contract() -> dict:
    if not CONTRACT_PATH.exists():
        raise SchemaError(f"Contract not found at {CONTRACT_PATH}")
    with open(CONTRACT_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def validate_sheets(wb, contract: dict) -> dict:
    """Walk expected_sheets and header_anchors; raise SchemaError on any mismatch."""
    expected = contract["expected_sheets"]
    summary = {"sheets_validated": 0, "anchors_passed": 0, "anchors_failed": []}

    for sheet_name, spec in expected.items():
        if sheet_name.startswith("_"):
            continue
        if sheet_name not in wb.sheetnames:
            raise SchemaError(f"Required sheet missing: {sheet_name!r}")
        ws = wb[sheet_name]
        if ws.max_row < spec.get("min_rows", 0):
            raise SchemaError(
                f"Sheet {sheet_name!r}: max_row={ws.max_row} below min_rows={spec['min_rows']}"
            )
        if ws.max_column < spec.get("min_cols", 0):
            raise SchemaError(
                f"Sheet {sheet_name!r}: max_col={ws.max_column} below min_cols={spec['min_cols']}"
            )
        for anchor in spec.get("header_anchors", []):
            actual = _cell(ws, anchor["cell"])
            actual_s = "" if actual is None else str(actual).strip()
            if "expected_equals" in anchor:
                if actual_s != anchor["expected_equals"]:
                    summary["anchors_failed"].append(
                        f"{sheet_name}!{anchor['cell']} expected {anchor['expected_equals']!r} got {actual_s!r}"
                    )
                    continue
            elif "expected_contains" in anchor:
                if anchor["expected_contains"] not in actual_s:
                    summary["anchors_failed"].append(
                        f"{sheet_name}!{anchor['cell']} expected to contain {anchor['expected_contains']!r} got {actual_s!r}"
                    )
                    continue
            elif "expected_starts_with" in anchor:
                if not actual_s.startswith(anchor["expected_starts_with"]):
                    summary["anchors_failed"].append(
                        f"{sheet_name}!{anchor['cell']} expected to start with {anchor['expected_starts_with']!r} got {actual_s!r}"
                    )
                    continue
            summary["anchors_passed"] += 1
        summary["sheets_validated"] += 1

    if summary["anchors_failed"]:
        raise SchemaError(
            "Header anchor mismatches:\n  - " + "\n  - ".join(summary["anchors_failed"])
        )
    return summary


def validate_weights(wb, contract: dict, summary: dict) -> float:
    ws = wb["🏠 Master"]
    weights = []
    for r in range(37, 56):  # rows 37-55 inclusive
        v = ws.cell(row=r, column=3).value
        if v is None:
            continue
        f = _safe_float(v)
        if f is not None:
            weights.append(f)
    total = round(sum(weights), 4)
    rules = contract.get("scoring_weights_locked", {})
    expected = rules.get("expected_sum_pct", 100)
    tol = rules.get("tolerance", 0.01)
    if abs(total - expected) > tol:
        raise SchemaError(
            f"Master Table 2 weights sum to {total}, expected {expected} (±{tol})."
        )
    summary["weights_total_pct"] = total
    return total


# ---------------------------------------------------------------------------
# Cycle metadata
# ---------------------------------------------------------------------------

def _parse_master_header_line(text: str) -> dict:
    """
    Parse the Master A2 banner — e.g.:
      'Universe: 676 funds, 26 categories | NAV through 15-Apr-2026 | Master cutoff: 31-Mar-2026 | Rf=4.5% p.a.'
    """
    out = {"total_funds": None, "category_count": None,
           "cycle_date": None, "master_cutoff_date": None,
           "rf_rate_annual": None, "rf_rate_display": None}
    if not text:
        return out
    s = str(text).strip()

    m = re.search(r"(\d+)\s+funds", s)
    if m:
        out["total_funds"] = int(m.group(1))
    m = re.search(r"(\d+)\s+categor", s)
    if m:
        out["category_count"] = int(m.group(1))
    m = re.search(r"NAV through\s+([0-9]{1,2}[- ][A-Za-z]+[- ][0-9]{4})", s)
    if m:
        out["cycle_date"] = _iso_date(m.group(1).replace(" ", "-"))
    m = re.search(r"Master cutoff:\s*([0-9]{1,2}[- ][A-Za-z]+[- ][0-9]{4})", s)
    if m:
        out["master_cutoff_date"] = _iso_date(m.group(1).replace(" ", "-"))
    m = re.search(r"Rf\s*=\s*([0-9]+(?:\.[0-9]+)?)\s*%", s)
    if m:
        pct = float(m.group(1))
        out["rf_rate_annual"] = round(pct / 100, 6)
        out["rf_rate_display"] = f"{pct}% p.a."
    return out


def _cycle_label(iso: str) -> str:
    d = _dt.date.fromisoformat(iso)
    suffix = "U1" if d.day <= 10 else "U2"
    return f"{suffix} {d.strftime('%b %Y')}"


def build_cycle_meta(wb, source_filename: str, summary: dict, contract: dict) -> dict:
    ws = wb["🏠 Master"]
    parsed = _parse_master_header_line(_cell(ws, "A2"))

    # Categories (Table 1, rows 6..31)
    categories: list[dict] = []
    eq = set(contract["categories"]["equity"])
    hb = set(contract["categories"]["hybrid"])
    for r in range(6, 32):
        name = _safe_str(ws.cell(row=r, column=1).value)
        if not name:
            continue
        sub_class = "Equity" if name in eq else ("Hybrid" if name in hb else "Equity")
        top_score = ws.cell(row=r, column=4).value
        categories.append({
            "name": name,
            "sub_class": sub_class,
            "fund_count": _safe_int(ws.cell(row=r, column=2).value),
            "top_fund_name": _safe_str(ws.cell(row=r, column=3).value),
            "top_score": _safe_float(top_score) if isinstance(top_score, (int, float)) else None,
            "benchmark": _safe_str(ws.cell(row=r, column=5).value),
        })

    # AMC scores (Table 4, rows 66..91, two-column layout A|B and D|E)
    amc_scores: list[dict] = []
    for r in range(66, 92):
        for amc_col, score_col in ((1, 2), (4, 5)):
            amc = _safe_str(ws.cell(row=r, column=amc_col).value)
            score = ws.cell(row=r, column=score_col).value
            if amc and score is not None:
                amc_scores.append({"amc": amc, "score": _safe_int(score)})

    # Scoring weights (Table 2, rows 37..55)
    weights: list[dict] = []
    for r in range(37, 56):
        param = _safe_str(ws.cell(row=r, column=1).value)
        if not param:
            continue
        weights.append({
            "parameter": param,
            "unit": _safe_str(ws.cell(row=r, column=2).value),
            "weight_pct": _safe_float(ws.cell(row=r, column=3).value),
            "direction": "Higher" if "Higher" in (str(ws.cell(row=r, column=4).value or "")) else "Lower",
        })

    cycle_date = parsed["cycle_date"]
    if not cycle_date:
        # Fall back to parsing the filename
        m = re.search(r"(\d{1,2})([A-Za-z]{3})(\d{4})", source_filename)
        if m:
            cycle_date = _iso_date(f"{m.group(1)}-{m.group(2)}-{m.group(3)}")

    if not cycle_date:
        raise SchemaError("Unable to determine cycle_date from Master A2 or filename.")

    return {
        "cycle_date": cycle_date,
        "cycle_label": _cycle_label(cycle_date),
        "as_on_display": _display_date(cycle_date),
        "total_funds": parsed["total_funds"],
        "category_count": parsed["category_count"],
        "categories": categories,
        "rf_rate_annual": parsed["rf_rate_annual"],
        "rf_rate_display": parsed["rf_rate_display"],
        "master_cutoff_date": parsed["master_cutoff_date"],
        "source_dates": {
            "screener": cycle_date,
            "analytics": None,  # v1.x
            "monitor": None,    # v1.x
        },
        "amc_scores": amc_scores,
        "scoring_weights": weights,
        "schema_version": "screener-v1",
        "generated_at": _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds"),
        "source_file": source_filename,
    }


# ---------------------------------------------------------------------------
# Fund records
# ---------------------------------------------------------------------------

def _read_data_tuple(row: tuple) -> dict:
    """Parse one streamed row tuple from 📋 Data."""
    pad = list(row) + [None] * (24 - len(row))
    g = lambda c: pad[c - 1]
    return {
        "seq": _safe_int(g(1)),
        "fund_name": _safe_str(g(2)),
        "category": _safe_str(g(3)),
        "scheme_code": _safe_int(g(4)),
        "aum_cr": _safe_float(g(5)),
        "manager_name": _safe_str(g(6)),
        "manager_tenure_yrs": _safe_float(g(7)),
        "inception_date_iso": _iso_date(g(8)),
        "turnover_pct": _safe_float(g(9)),
        "benchmark": _safe_str(g(10)),
        "amc": _safe_str(g(11)),
        "amc_score": _safe_int(g(12)),
        "ter_pct": _safe_float(g(13)),
        "no_of_stocks": _safe_int(g(14)),
        "large_cap_pct": _safe_float(g(15)),
        "mid_cap_pct": _safe_float(g(16)),
        "small_cap_pct": _safe_float(g(17)),
        "others_pct": _safe_float(g(18)),
        "h_equity_pct": _safe_float(g(19)),
        "h_debt_pct": _safe_float(g(20)),
        "h_others_pct": _safe_float(g(21)),
        "h_ytm": _safe_float(g(22)),
        "h_mod_duration": _safe_float(g(23)),
        "h_avg_maturity": _safe_float(g(24)),
    }


def _read_cm_tuple(row: tuple) -> dict:
    """Parse one streamed CM row. Note: NO rounding applied here — the parameter_scores
    percentile compute requires full-precision inputs to avoid spurious ties at 4 dp.
    Display rounding happens later when populating record["cy_returns"] etc."""
    pad = list(row) + [None] * (36 - len(row))
    g = lambda c: pad[c - 1]
    return {
        "seq": _safe_int(g(1)),
        "univ_rank": _safe_int(g(2)),
        "fund_name": _safe_str(g(3)),
        "category": _safe_str(g(4)),
        "fund_tenure_yrs": _safe_float(g(5)),
        # CY returns: × 100 unit conversion only, no rounding
        "cy2022_pct": (lambda v: v * 100 if v is not None else None)(_safe_float(g(8))),
        "cy2023_pct": (lambda v: v * 100 if v is not None else None)(_safe_float(g(9))),
        "cy2024_pct": (lambda v: v * 100 if v is not None else None)(_safe_float(g(10))),
        "cy2025_pct": (lambda v: v * 100 if v is not None else None)(_safe_float(g(11))),
        "cy_ytd_pct": (lambda v: v * 100 if v is not None else None)(_safe_float(g(12))),
        "rolling_3y_avg_pct": _safe_float(g(13)),
        "consistency_pct": _safe_float(g(14)),
        "sharpe_3y": _safe_float(g(15)),
        "beta_3y": _safe_float(g(16)),
        "down_capture_3y_pct": _safe_float(g(17)),
        "up_capture_3y_pct": _safe_float(g(18)),
        "treynor_3y": _safe_float(g(19)),
        "overall_capture_3y_pct": _safe_float(g(20)),
        "score_raw": g(30),  # AD col 30
    }


def _stream_data_rows(wb) -> list[dict]:
    """Read 📋 Data start_row=5 onward via iter_rows; one dict per fund."""
    ws = wb["📋 Data"]
    out = []
    for i, row in enumerate(ws.iter_rows(values_only=True), start=1):
        if i < 5:
            continue  # header rows
        if not row or row[0] is None and row[1] is None and row[3] is None:
            continue
        out.append(_read_data_tuple(row))
    return out


def _stream_cm_rows(wb) -> list[dict]:
    """Read 📊 Computed Metrics start_row=4 onward via iter_rows."""
    ws = wb["📊 Computed Metrics"]
    out = []
    for i, row in enumerate(ws.iter_rows(values_only=True), start=1):
        if i < 4:
            continue
        if not row or row[0] is None and row[2] is None:
            continue
        out.append(_read_cm_tuple(row))
    return out


def _empty_analytics_pending() -> dict:
    return OrderedDict([
        ("top_10_holdings", None),
        ("sector_allocation", None),
        ("full_holdings", None),
        ("top_10_concentration_pct", None),
        ("top_3_sector_concentration_pct", None),
        ("manager_change_history", None),
        ("category_history", None),
        ("aum_trend", None),
        ("ter_trend", None),
        ("rank_history", None),
    ])


# ---------------------------------------------------------------------------
# Parameter-score computation (per-category percentile rank per parameter)
# ---------------------------------------------------------------------------

# Master Table 2 parameter name → fund-record value extractor.
# The CY-YTD parameter name is dynamic (e.g. 'CY2026 YTD'); resolved at runtime
# by 'YTD' substring match. All other names are exact matches against
# Master Table 2 col A in mf-whitelisting v3.7.
#
# IMPORTANT — Excel-quirk reproduction (locked in the contract under
# derived_fields_documentation.parameter_scores.excel_quirk_python_pasted_blanks_become_zero):
#
# Excel's category-sheet score formula uses COUNTIF/COUNT against ranges that
# inherit values from 📊 Computed Metrics. Two distinct sources of "None"
# behave differently in those COUNTIFs:
#
#   (a) PRESERVED-AS-EMPTY-STRING — CY-return cells (CM cols H-L) are Excel
#       formulas with `=IFERROR(...,"")`. When data is missing, the formula
#       returns the literal empty string "". Excel keeps "" as text;
#       COUNT excludes it; COUNTIF skips it. openpyxl reads None.
#       → No coercion needed; my Python's `if v is not None` filter matches
#       Excel's behaviour directly.
#
#   (b) COERCED-TO-ZERO — Two sub-cases produce numeric 0 in CM, which the
#       cat sheet inherits and COUNT/COUNTIF then include as 0:
#         * Python-pasted CM cols M..T (Rolling 3Y, Consistency, Sharpe, Beta,
#           Down/Up Capture, Treynor, Overall Capture) — for funds with
#           tenure < 3Y these cells are blank, and Excel's category-sheet
#           XLOOKUP coerces a blank-source-cell result to literal 0.
#         * XLOOKUP-from-Data CM cols G/U/V/W (Mgr Tenure, Turnover, TER,
#           AMC Score) — when the underlying Data cell is None, the CM
#           XLOOKUP itself materialises 0 in the CM cell (Excel coerces a
#           blank source cell to 0 in numeric context, even with a `""` 4th
#           arg, because that arg is for "not found", not "found but empty").
#
# To reproduce the stored centricity_score within ±0.0001, the peer pool for
# the 12 affected params substitutes None → 0. The subject fund's own value
# is left as-is; for Ranked funds the M-T params are always populated
# (otherwise they wouldn't be Ranked), and the G/U/V/W params have None at
# Data-source level for some funds (e.g. brand-new funds without a turnover
# figure) — those funds typically aren't Ranked anyway.
COERCE_NONE_TO_ZERO_PARAMS = frozenset({
    # Python-pasted CM cols M-T
    "Rolling 3Y Avg",
    "Consistency Score",
    "Sharpe Ratio",
    "Beta",
    "Down Capture",
    "Up Capture",
    "Treynor Ratio",
    "Overall Capture",
    # XLOOKUP-from-Data CM cols G/U/V/W
    "Mgr Tenure",
    "Portfolio Turnover",
    "TER (%)",
    "AMC Score",
})

# Extractors read from record["_raw_metrics"] when available (full precision —
# avoids spurious ties from 4-dp display rounding) and fall back to public fields.
def _r(r: dict, key: str, fallback):
    raw = r.get("_raw_metrics", {})
    if key in raw:
        return raw[key]
    return fallback(r)

PARAM_EXTRACTORS = {
    "Fund Tenure":         lambda r: _r(r, "fund_tenure_yrs",       lambda x: x["fund_tenure_yrs"]),
    "Fund AUM":            lambda r: _r(r, "aum_cr",                lambda x: x["aum_cr"]),
    "Mgr Tenure":          lambda r: _r(r, "manager_tenure_yrs",    lambda x: x["manager_tenure_yrs"]),
    "CY2022 Return":       lambda r: _r(r, "cy2022_pct",            lambda x: x["cy_returns"]["cy2022_pct"]),
    "CY2023 Return":       lambda r: _r(r, "cy2023_pct",            lambda x: x["cy_returns"]["cy2023_pct"]),
    "CY2024 Return":       lambda r: _r(r, "cy2024_pct",            lambda x: x["cy_returns"]["cy2024_pct"]),
    "CY2025 Return":       lambda r: _r(r, "cy2025_pct",            lambda x: x["cy_returns"]["cy2025_pct"]),
    "Rolling 3Y Avg":      lambda r: _r(r, "rolling_3y_avg_pct",    lambda x: x["rolling_3y_avg_pct"]),
    "Consistency Score":   lambda r: _r(r, "consistency_pct",       lambda x: x["consistency_pct"]),
    "Sharpe Ratio":        lambda r: _r(r, "sharpe_3y",             lambda x: x["risk_metrics"]["sharpe_3y"]),
    "Beta":                lambda r: _r(r, "beta_3y",               lambda x: x["risk_metrics"]["beta_3y"]),
    "Down Capture":        lambda r: _r(r, "down_capture_3y_pct",   lambda x: x["risk_metrics"]["down_capture_3y_pct"]),
    "Up Capture":          lambda r: _r(r, "up_capture_3y_pct",     lambda x: x["risk_metrics"]["up_capture_3y_pct"]),
    "Treynor Ratio":       lambda r: _r(r, "treynor_3y",            lambda x: x["risk_metrics"]["treynor_3y"]),
    "Overall Capture":     lambda r: _r(r, "overall_capture_3y_pct",lambda x: x["risk_metrics"]["overall_capture_3y_pct"]),
    "Portfolio Turnover":  lambda r: _r(r, "turnover_pct",          lambda x: x["turnover_pct"]),
    "TER (%)":             lambda r: _r(r, "ter_pct",               lambda x: x["ter_pct"]),
    "AMC Score":           lambda r: _r(r, "amc_score",
                                        lambda x: float(x["amc_score"]) if x.get("amc_score") is not None else None),
}


def _resolve_extractors(weights_meta: list[dict]) -> dict:
    """Match Master Table 2 parameter names to extractor lambdas, including
    the dynamic CY-YTD entry. The CY-YTD extractor also prefers _raw_metrics."""
    resolved: dict = dict(PARAM_EXTRACTORS)
    for w in weights_meta:
        name = w["parameter"]
        if name in resolved:
            continue
        if "YTD" in name:
            resolved[name] = lambda r: _r(
                r, "cy_ytd_pct", lambda x: x["cy_returns"]["cy_ytd_pct"]
            )
    return resolved


def compute_parameter_scores(funds: list[dict],
                             weights_meta: list[dict],
                             warnings: list[str]) -> None:
    """
    Reproduce the Excel category-sheet percentile-rank logic from
    mf-whitelisting/SKILL.md §4.2 from primitive metric values.

    Mutates each fund record in `funds`, adding a `parameter_scores` OrderedDict
    keyed by Master Table 2 parameter name. Values are 0–1 floats or None.

    Per the contract spec, all parameter_scores are None for funds where
    centricity_score_status != 'Ranked' (1-3yr Warning, New Fund Monitoring).
    """
    extractors = _resolve_extractors(weights_meta)
    direction_by_param = {w["parameter"]: w["direction"] for w in weights_meta}
    param_order = [w["parameter"] for w in weights_meta]

    # Sanity: every weight parameter has an extractor
    missing = [p for p in param_order if p not in extractors]
    if missing:
        raise SchemaError(
            "compute_parameter_scores: no extractor mapped for parameter(s) "
            + repr(missing) + ". Update PARAM_EXTRACTORS or add a YTD-style "
            "rule in _resolve_extractors."
        )

    # Group funds by category
    by_cat: dict[str, list[dict]] = {}
    for f in funds:
        by_cat.setdefault(f["category"], []).append(f)

    # Initialise parameter_scores on every fund (preserve param_order)
    for f in funds:
        f["parameter_scores"] = OrderedDict((p, None) for p in param_order)

    # Per (category, parameter): compute percentile pool, assign per-fund score.
    # For COERCE_NONE_TO_ZERO_PARAMS, replace None with 0.0 in the peer pool to
    # reproduce the Excel category-sheet XLOOKUP-of-blank-becomes-0 behaviour.
    for cat, cat_funds in by_cat.items():
        for param_name in param_order:
            ext = extractors[param_name]
            direction = direction_by_param[param_name]
            coerce_zero = param_name in COERCE_NONE_TO_ZERO_PARAMS

            # Build the peer pool as Excel sees it
            if coerce_zero:
                pool_values = [
                    (f, (ext(f) if ext(f) is not None else 0.0))
                    for f in cat_funds
                ]
            else:
                pool_values = [(f, ext(f)) for f in cat_funds]

            valid_pool = [v for (_, v) in pool_values if v is not None]
            if not valid_pool:
                continue
            n = len(valid_pool)

            # Per fund: percentile from the cat-sheet-equivalent value.
            # For coerced params the subject's own raw=None is also coerced to 0
            # (Excel cat-sheet shows 0 in that cell), so the fund participates
            # in its own percentile pool with value 0.
            for f in cat_funds:
                raw = ext(f)
                if raw is None and not coerce_zero:
                    continue  # CY-return None preserved as null score
                eff = 0.0 if (raw is None and coerce_zero) else raw
                count_le = sum(1 for x in valid_pool if x <= eff)
                if direction == "Higher":
                    f["parameter_scores"][param_name] = round(count_le / n, 6)
                else:  # "Lower"
                    f["parameter_scores"][param_name] = round((n - count_le + 1) / n, 6)

    # Final pass: nullify parameter_scores for non-Ranked funds
    for f in funds:
        if f["centricity_score_status"] != "Ranked":
            f["parameter_scores"] = OrderedDict((p, None) for p in param_order)


def verify_parameter_scores_match(funds: list[dict],
                                  weights_meta: list[dict],
                                  *,
                                  tolerance: float = 0.0001) -> dict:
    """
    For every Ranked fund, recompute the score from parameter_scores × weights
    and assert agreement with the stored centricity_score within `tolerance`.
    Raises SchemaError on the first material mismatch (or aggregates if many).

    Returns a summary dict with worst_diff and sample comparisons.
    """
    weight_by_param = {w["parameter"]: w["weight_pct"] for w in weights_meta}
    failures: list[str] = []
    worst_diff = 0.0
    samples: list[dict] = []

    for f in funds:
        if f["centricity_score_status"] != "Ranked":
            continue
        stored = f["centricity_score"]
        if stored is None:
            continue
        recomputed = 0.0
        for p, w_pct in weight_by_param.items():
            ps = f["parameter_scores"].get(p)
            if ps is None:
                continue  # NaN parameter drops from numerator (denom stays at 100)
            recomputed += ps * w_pct
        recomputed /= 100.0
        diff = abs(recomputed - stored)
        if diff > worst_diff:
            worst_diff = diff
        if diff > tolerance:
            failures.append(
                f"  - {f['fund_name']!r} (cat={f['category']}, "
                f"AMFI={f['scheme_code']}): stored={stored:.6f} recomputed={recomputed:.6f} "
                f"Δ={diff:.6f}"
            )
        samples.append({
            "fund_name": f["fund_name"],
            "category": f["category"],
            "scheme_code": f["scheme_code"],
            "stored": round(stored, 6),
            "recomputed": round(recomputed, 6),
            "diff": round(diff, 7),
        })

    if failures:
        head = failures[:10]
        more = "" if len(failures) <= 10 else f"\n  ... and {len(failures) - 10} more"
        raise SchemaError(
            f"parameter_scores recompute mismatch on {len(failures)} fund(s) "
            f"(tolerance ±{tolerance}). Worst Δ = {worst_diff:.6f}.\n"
            "Per the contract, this means the normalisation reproduction is wrong "
            "and the dashboard's weight-drawer recompute would diverge from Excel. "
            "Fix before commit.\n"
            + "\n".join(head) + more
        )

    return {
        "ranked_funds_verified": len(samples),
        "worst_diff": round(worst_diff, 7),
        "tolerance": tolerance,
    }


def _compute_derived_risk_3y(
    series: list[tuple[_dt.date, float]],
    cycle_date: _dt.date,
    target_3y_date: _dt.date,
    rf_annual: float | None,
    fund_tenure_yrs: float | None,
) -> dict:
    """
    Compute Sortino, annualised Std Dev, and Max Drawdown from the trailing
    3Y window of a fund's NAV series. Returns all-null when:
      - fund_tenure_yrs < 3
      - fewer than 30 daily observations in the window
      - rf_annual is null (Sortino requires it)
      - sample size for downside / dispersion is insufficient

    See data-contract/screener-v1.json → derived_fields_documentation.risk_metrics_3y_derived.
    """
    null_out = {"sortino_3y": None, "std_dev_3y_pct": None, "max_drawdown_3y_pct": None}
    if fund_tenure_yrs is None or fund_tenure_yrs < 3:
        return null_out
    if not series:
        return null_out

    # Slice the series to [target_3y_date, cycle_date] inclusive
    window = [(d, v) for (d, v) in series if target_3y_date <= d <= cycle_date]
    if len(window) < 30:
        return null_out

    navs = [v for _, v in window]

    # Daily simple returns from consecutive NAVs
    daily_returns: list[float] = []
    for i in range(1, len(navs)):
        prev = navs[i - 1]
        if prev <= 0:
            continue
        try:
            daily_returns.append(navs[i] / prev - 1.0)
        except (ZeroDivisionError, OverflowError):
            continue

    if len(daily_returns) < 2:
        return null_out

    out = {"sortino_3y": None, "std_dev_3y_pct": None, "max_drawdown_3y_pct": None}

    # Std Dev (annualised, %)
    try:
        s = _stats.stdev(daily_returns)  # sample, n-1
        out["std_dev_3y_pct"] = round(s * math.sqrt(252) * 100, 4)
    except _stats.StatisticsError:
        pass

    # Sortino (annualised) — requires Rf rate
    if rf_annual is not None:
        rf_daily = rf_annual / 252.0
        excess = [r - rf_daily for r in daily_returns]
        mean_excess = sum(excess) / len(excess)
        downside = [e for e in excess if e < 0]
        if len(downside) >= 2:
            try:
                d_std = _stats.stdev(downside)
                if d_std > 0:
                    out["sortino_3y"] = round(
                        (mean_excess * 252) / (d_std * math.sqrt(252)), 4
                    )
            except _stats.StatisticsError:
                pass

    # Max Drawdown (% of running peak; returned as negative)
    peak = navs[0]
    max_dd = 0.0
    for v in navs:
        if v > peak:
            peak = v
        if peak <= 0:
            continue
        dd = (v - peak) / peak  # ≤ 0
        if dd < max_dd:
            max_dd = dd
    out["max_drawdown_3y_pct"] = round(max_dd * 100, 4)

    return out


def _trailing_returns_from_series(series: list[tuple[_dt.date, float]],
                                  cycle_date: _dt.date,
                                  targets: dict[str, _dt.date]) -> dict:
    """Compute 1Y/3Y/5Y/SI from a pre-loaded NAV series."""
    out = {"return_1y_pct": None, "return_3y_pct": None,
           "return_5y_pct": None, "return_si_pct": None}
    if not series:
        return out
    end_d, end_v = _series_value_at_or_before(series, cycle_date)
    if end_v is None:
        return out
    for label, years in (("1Y", 1), ("3Y", 3), ("5Y", 5)):
        _, start_v = _series_value_at_or_before(series, targets[label])
        if start_v is None:
            continue
        if years == 1:
            out[f"return_{label.lower()}_pct"] = _absolute_return_pct(end_v, start_v)
        else:
            out[f"return_{label.lower()}_pct"] = _trailing_return_pct(end_v, start_v, years)
    # SI
    first_d, first_v = series[0]
    if first_v is not None and end_d is not None:
        days = (end_d - first_d).days
        if days >= 30:
            years_si = days / 365.25
            if years_si >= 1:
                out["return_si_pct"] = _trailing_return_pct(end_v, first_v, years_si)
            else:
                out["return_si_pct"] = _absolute_return_pct(end_v, first_v)
    return out


def build_funds(wb, contract: dict, cycle_meta: dict, warnings: list[str]) -> list[dict]:
    eq_set = set(contract["categories"]["equity"])
    hb_set = set(contract["categories"]["hybrid"])

    cycle_date = _dt.date.fromisoformat(cycle_meta["cycle_date"])
    targets = {
        "1Y": cycle_date.replace(year=cycle_date.year - 1),
        "3Y": cycle_date.replace(year=cycle_date.year - 3),
        "5Y": cycle_date.replace(year=cycle_date.year - 5),
    }

    print("[converter] streaming Fund NAV into memory...", file=sys.stderr)
    nav_by_amfi, _name_by_amfi = load_fund_nav(wb)
    print(f"[converter]   loaded {len(nav_by_amfi)} fund NAV series", file=sys.stderr)

    print("[converter] streaming Benchmark NAV into memory...", file=sys.stderr)
    bm_by_name = load_benchmark_nav(wb)
    print(f"[converter]   loaded {len(bm_by_name)} benchmark NAV series", file=sys.stderr)

    # Pre-compute benchmark returns once per benchmark
    bm_cache: dict[str, dict] = {}
    for name, series in bm_by_name.items():
        bm_cache[name] = _trailing_returns_from_series(series, cycle_date, targets)

    def benchmark_returns_for(name: str | None) -> dict:
        if not name:
            return {"return_1y_pct": None, "return_3y_pct": None, "return_5y_pct": None}
        if name in bm_cache:
            r = bm_cache[name]
            return {"return_1y_pct": r["return_1y_pct"], "return_3y_pct": r["return_3y_pct"],
                    "return_5y_pct": r["return_5y_pct"]}
        warnings.append(f"Benchmark not matched in 📈 Benchmark NAV row 1: {name!r}")
        bm_cache[name] = {"return_1y_pct": None, "return_3y_pct": None,
                          "return_5y_pct": None, "return_si_pct": None}
        return {"return_1y_pct": None, "return_3y_pct": None, "return_5y_pct": None}

    print("[converter] streaming 📋 Data + 📊 Computed Metrics into memory...", file=sys.stderr)
    data_rows = _stream_data_rows(wb)
    cm_rows = _stream_cm_rows(wb)
    if len(data_rows) != len(cm_rows):
        raise SchemaError(
            f"Row count mismatch: 📋 Data has {len(data_rows)} fund rows but "
            f"📊 Computed Metrics has {len(cm_rows)}. They must align 1:1."
        )
    print(f"[converter]   loaded {len(data_rows)} fund rows (Data + CM aligned)", file=sys.stderr)

    funds: list[dict] = []
    score_dist = {"Ranked": 0, "1-3yr Warning": 0, "New Fund Monitoring": 0}

    for idx, (d, cm) in enumerate(zip(data_rows, cm_rows)):
        if d["scheme_code"] is None and d["fund_name"] is None:
            break
        if d["scheme_code"] is None:
            warnings.append(f"📋 Data fund #{d['seq']}: missing AMFI code, fund={d['fund_name']!r}, skipped.")
            continue
        if cm["seq"] != d["seq"] or cm["fund_name"] != d["fund_name"]:
            raise SchemaError(
                f"Alignment mismatch at fund #{d['seq']}: "
                f"Data seq={d['seq']} name={d['fund_name']!r} | "
                f"CM seq={cm['seq']} name={cm['fund_name']!r}"
            )

        category = d["category"]
        if category in eq_set:
            sub_class = "Equity"
        elif category in hb_set:
            sub_class = "Hybrid"
        else:
            sub_class = "Equity"
            warnings.append(
                f"Unknown category {category!r} for fund {d['fund_name']!r}; defaulting sub_class=Equity."
            )

        status, score_dec, warn_pct = _classify_score(cm["score_raw"])
        score_dist[status] = score_dist.get(status, 0) + 1

        # Trailing returns + derived 3Y risk metrics from in-memory NAV series
        series = nav_by_amfi.get(d["scheme_code"])
        if series is None:
            warnings.append(
                f"AMFI {d['scheme_code']} ({d['fund_name']!r}) not found in 📈 Fund NAV row 1."
            )
            trailing = {"return_1y_pct": None, "return_3y_pct": None,
                        "return_5y_pct": None, "return_si_pct": None}
            derived_risk = {"sortino_3y": None, "std_dev_3y_pct": None,
                            "max_drawdown_3y_pct": None}
        else:
            trailing = _trailing_returns_from_series(series, cycle_date, targets)
            derived_risk = _compute_derived_risk_3y(
                series=series,
                cycle_date=cycle_date,
                target_3y_date=targets["3Y"],
                rf_annual=cycle_meta.get("rf_rate_annual"),
                fund_tenure_yrs=cm["fund_tenure_yrs"],
            )

        bm_ret = benchmark_returns_for(d["benchmark"])

        record = OrderedDict()
        record["scheme_code"] = d["scheme_code"]
        record["fund_name"] = d["fund_name"]
        record["category"] = category
        record["sub_category_class"] = sub_class
        record["amc"] = d["amc"]
        record["amc_score"] = d["amc_score"]
        record["benchmark"] = d["benchmark"]
        record["inception_date"] = d["inception_date_iso"]
        record["fund_tenure_yrs"] = _round(cm["fund_tenure_yrs"], 4)
        record["manager_name"] = d["manager_name"]
        record["manager_tenure_yrs"] = _round(d["manager_tenure_yrs"], 4)
        record["aum_cr"] = _round(d["aum_cr"], 4)
        record["ter_pct"] = _round(d["ter_pct"], 4)
        record["turnover_pct"] = _round(d["turnover_pct"], 4)
        record["no_of_stocks"] = d["no_of_stocks"]
        record["mcap_split"] = OrderedDict([
            ("large_pct", _round(d["large_cap_pct"], 4)),
            ("mid_pct", _round(d["mid_cap_pct"], 4)),
            ("small_pct", _round(d["small_cap_pct"], 4)),
            ("others_pct", _round(d["others_pct"], 4)),
        ])
        record["hybrid_extension"] = OrderedDict([
            ("equity_pct", _round(d["h_equity_pct"], 4)),
            ("debt_pct", _round(d["h_debt_pct"], 4)),
            ("others_pct_hybrid", _round(d["h_others_pct"], 4)),
            ("ytm", _round(d["h_ytm"], 4)),
            ("mod_duration_yrs", _round(d["h_mod_duration"], 4)),
            ("avg_maturity_yrs", _round(d["h_avg_maturity"], 4)),
        ])
        record["centricity_rank_overall"] = cm["univ_rank"]
        record["centricity_rank_in_category"] = None  # filled post-pass
        record["centricity_score"] = _round(score_dec, 6) if score_dec is not None else None
        record["centricity_score_status"] = status
        record["centricity_score_warning_pct"] = _round(warn_pct, 2) if warn_pct is not None else None
        record["cy_returns"] = OrderedDict([
            ("cy2022_pct", _round(cm["cy2022_pct"], 4)),
            ("cy2023_pct", _round(cm["cy2023_pct"], 4)),
            ("cy2024_pct", _round(cm["cy2024_pct"], 4)),
            ("cy2025_pct", _round(cm["cy2025_pct"], 4)),
            ("cy_ytd_pct", _round(cm["cy_ytd_pct"], 4)),
            ("cy_ytd_year", cycle_date.year),
        ])
        record["rolling_3y_avg_pct"] = _round(cm["rolling_3y_avg_pct"], 4)
        record["consistency_pct"] = _round(cm["consistency_pct"], 4)
        # Order matches Master Design Brief §5.3 Fund Detail Quants strip:
        # Sharpe | Sortino | Std Dev | Max DD | Beta | Treynor | Up/Down Capture
        record["risk_metrics"] = OrderedDict([
            ("sharpe_3y", _round(cm["sharpe_3y"], 4)),
            ("sortino_3y", derived_risk["sortino_3y"]),
            ("std_dev_3y_pct", derived_risk["std_dev_3y_pct"]),
            ("max_drawdown_3y_pct", derived_risk["max_drawdown_3y_pct"]),
            ("beta_3y", _round(cm["beta_3y"], 4)),
            ("treynor_3y", _round(cm["treynor_3y"], 4)),
            ("up_capture_3y_pct", _round(cm["up_capture_3y_pct"], 4)),
            ("down_capture_3y_pct", _round(cm["down_capture_3y_pct"], 4)),
            ("overall_capture_3y_pct", _round(cm["overall_capture_3y_pct"], 4)),
        ])
        record["trailing_returns"] = OrderedDict([
            ("return_1y_pct", trailing["return_1y_pct"]),
            ("return_3y_pct", trailing["return_3y_pct"]),
            ("return_5y_pct", trailing["return_5y_pct"]),
            ("return_si_pct", trailing["return_si_pct"]),
        ])
        record["benchmark_returns"] = OrderedDict([
            ("return_1y_pct", bm_ret.get("return_1y_pct")),
            ("return_3y_pct", bm_ret.get("return_3y_pct")),
            ("return_5y_pct", bm_ret.get("return_5y_pct")),
        ])
        # Alpha
        a3 = (trailing["return_3y_pct"] - bm_ret["return_3y_pct"]
              if trailing["return_3y_pct"] is not None and bm_ret.get("return_3y_pct") is not None
              else None)
        a5 = (trailing["return_5y_pct"] - bm_ret["return_5y_pct"]
              if trailing["return_5y_pct"] is not None and bm_ret.get("return_5y_pct") is not None
              else None)
        record["alpha"] = OrderedDict([
            ("alpha_3y_pct", _round(a3, 4) if a3 is not None else None),
            ("alpha_5y_pct", _round(a5, 4) if a5 is not None else None),
        ])
        record["verdict"] = None
        record["verdict_reasons"] = None
        record["analyst_note"] = None
        record["analytics_pending"] = _empty_analytics_pending()

        # Hidden full-precision metric values for parameter_scores percentile compute.
        # Stripped before JSON output.
        record["_raw_metrics"] = {
            "fund_tenure_yrs": cm["fund_tenure_yrs"],
            "aum_cr": d["aum_cr"],
            "manager_tenure_yrs": d["manager_tenure_yrs"],
            "cy2022_pct": cm["cy2022_pct"],
            "cy2023_pct": cm["cy2023_pct"],
            "cy2024_pct": cm["cy2024_pct"],
            "cy2025_pct": cm["cy2025_pct"],
            "cy_ytd_pct": cm["cy_ytd_pct"],
            "rolling_3y_avg_pct": cm["rolling_3y_avg_pct"],
            "consistency_pct": cm["consistency_pct"],
            "sharpe_3y": cm["sharpe_3y"],
            "beta_3y": cm["beta_3y"],
            "down_capture_3y_pct": cm["down_capture_3y_pct"],
            "up_capture_3y_pct": cm["up_capture_3y_pct"],
            "treynor_3y": cm["treynor_3y"],
            "overall_capture_3y_pct": cm["overall_capture_3y_pct"],
            "turnover_pct": d["turnover_pct"],
            "ter_pct": d["ter_pct"],
            "amc_score": float(d["amc_score"]) if d["amc_score"] is not None else None,
        }

        funds.append(record)

    # Compute centricity_rank_in_category post-pass
    by_cat: dict[str, list[dict]] = {}
    for f in funds:
        by_cat.setdefault(f["category"], []).append(f)
    for cat, lst in by_cat.items():
        ranked = [f for f in lst if f["centricity_score"] is not None]
        ranked.sort(key=lambda x: x["centricity_score"], reverse=True)
        for i, f in enumerate(ranked, start=1):
            f["centricity_rank_in_category"] = i

    return funds


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def convert(xlsx_path: Path) -> Path:
    if not xlsx_path.exists():
        raise SchemaError(f"Input file not found: {xlsx_path}")

    contract = load_contract()
    print(f"[converter] loaded contract: {CONTRACT_PATH.name} ({contract['contract_version']})", file=sys.stderr)

    wb = openpyxl.load_workbook(xlsx_path, read_only=True, data_only=True)
    print(f"[converter] opened workbook: {xlsx_path.name} ({len(wb.sheetnames)} sheets)", file=sys.stderr)

    # 1. Sheets + header anchors
    summary = validate_sheets(wb, contract)
    print(f"[converter] validated {summary['sheets_validated']} sheets, {summary['anchors_passed']} anchors passed", file=sys.stderr)

    # 2. Master Table 2 weights sum to 100
    weights_total = validate_weights(wb, contract, summary)
    print(f"[converter] Master Table 2 weights total: {weights_total}%", file=sys.stderr)

    # 3. Cycle metadata
    cycle_meta = build_cycle_meta(wb, xlsx_path.name, summary, contract)
    print(f"[converter] cycle: {cycle_meta['cycle_label']} | as on {cycle_meta['as_on_display']} | Rf {cycle_meta['rf_rate_display']}", file=sys.stderr)

    # 4. Funds
    warnings: list[str] = []
    funds = build_funds(wb, contract, cycle_meta, warnings)
    summary["fund_count"] = len(funds)
    print(f"[converter] built {len(funds)} fund records", file=sys.stderr)

    if cycle_meta.get("total_funds") not in (None, len(funds)):
        warnings.append(
            f"Cycle banner reports total_funds={cycle_meta['total_funds']} but {len(funds)} fund records were built."
        )

    # 5. Per-parameter normalised scores (powers the right-drawer weight reshuffling)
    print("[converter] computing parameter_scores (per-category percentile rank)...", file=sys.stderr)
    compute_parameter_scores(funds, cycle_meta["scoring_weights"], warnings)

    # 6. Verify recomputed score == stored centricity_score (±0.0001) for every Ranked fund
    verify_summary = verify_parameter_scores_match(
        funds, cycle_meta["scoring_weights"], tolerance=0.0001
    )
    summary["score_recompute_verified"] = verify_summary
    print(
        f"[converter]   verified {verify_summary['ranked_funds_verified']} ranked funds; "
        f"worst Δ = {verify_summary['worst_diff']:.7f} "
        f"(tolerance ±{verify_summary['tolerance']})",
        file=sys.stderr,
    )

    # Strip the hidden full-precision percentile-input dict before serialising
    for f in funds:
        f.pop("_raw_metrics", None)

    output = OrderedDict([
        ("contract_version", contract["contract_version"]),
        ("cycle_meta", cycle_meta),
        ("funds", funds),
        ("analytics_pending_fields", contract.get("v1_defaults_explicit_null", [])),
        ("schema_validation_summary", summary),
        ("converter_warnings", warnings[:200]),  # cap at 200 to keep JSON sane
    ])

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    out_path = DATA_DIR / f"screener-{cycle_meta['cycle_date']}.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2, default=str)
    print(f"[converter] wrote {out_path} ({out_path.stat().st_size:,} bytes)", file=sys.stderr)

    if warnings:
        print(f"[converter] {len(warnings)} warning(s) (showing first 5):", file=sys.stderr)
        for w in warnings[:5]:
            print(f"  - {w}", file=sys.stderr)

    return out_path


def main(argv: list[str] | None = None) -> int:
    argv = argv if argv is not None else sys.argv[1:]
    if not argv:
        print("usage: excel_to_json_screener.py <path-to-xlsx>", file=sys.stderr)
        return 2
    path = Path(argv[0])
    try:
        convert(path)
    except SchemaError as e:
        print(f"\nSCHEMA ERROR: {e}\n", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
