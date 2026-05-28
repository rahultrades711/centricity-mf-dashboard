"""Phase 2.2 Part 2 — export BENCHMARK_JSON_RECONCILE_15May.csv for Cowork.

Pulls a curated sample from the reconverted screener JSON to verify the
benchmark integration: 4 USD-converted, several split-adjusted ETFs, a
couple of proxies, a couple of absents, and normal large-cap / hybrid funds.

Columns (per the Part-2 prompt):
  AMFI, fund, TE_json, TD_json, benchmark_matched_series, is_proxy,
  currency_adjusted, nav_split_status, sharpe_json

Output: C:/Claude Folder/Claude/Projects/Equity MF Screener/BENCHMARK_JSON_RECONCILE_15May.csv
"""
from __future__ import annotations

import csv
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SCREENER_JSON = REPO_ROOT / "data" / "screener-2026-05-15.json"
OUT_CSV = Path(r"C:/Claude Folder/Claude/Projects/Equity MF Screener/BENCHMARK_JSON_RECONCILE_15May.csv")

# Curated sample names — chosen to span every benchmark-match path:
USD_CONVERTED = [
    "Motilal Oswal S&P 500 Index Fund-Reg(G)",
    "ICICI Pru NASDAQ 100 Index Fund(G)",
    "ICICI Pru US Bluechip Equity Fund(G)",
    "Nippon India US Equity Opp Fund(G)",
]
SPLIT_ADJUSTED_ETFS = [
    "Quantum Nifty 50 ETF",
    "UTI Nifty 50 ETF",
    "Aditya Birla SL Nifty 50 ETF",
    "Motilal Oswal BSE Low Volatility ETF",
    "ICICI Pru Nifty 200 Momentum 30 ETF",
    "Nippon India ETF Nifty Midcap 150",
    "Edelweiss NIFTY Large Mid Cap 250 Index Fund-Reg(G)",
]
PROXIES = [
    "Mirae Asset BSE 200 Equal Weight ETF",  # EW structural exception (TE 4.52% < 5%)
    "HDFC BSE Sensex ETF",                    # BSE direct (PRI, not a proxy)
    "ICICI Pru BSE Midcap Select ETF",        # BSE Midcap proxy
]
ABSENTS = [
    "Mirae Asset Nifty MidSmallcap400 Momentum Quality 100 ETF",  # no rule matched
    "Groww Nifty India Railways PSU ETF",                          # no sensible proxy
    "Nippon India Japan Equity Fund(G)",                           # currency-mismatch
    "Nippon India Taiwan Equity Fund-Reg(G)",                      # currency-mismatch
]
NORMAL = [
    "SBI Nifty 50 ETF",                       # direct alias-fold, peer-anchor
    "ICICI Pru Nifty 50 ETF",                 # direct alias-fold
    "ICICI Pru Equity & Debt Fund(G)",        # ICICI Pru E&D — rank 1 anchor
    "HDFC Large Cap Fund(G)",                 # large-cap active
    "Parag Parikh Flexi Cap Fund-Reg(G)",     # flexi-cap active
]


def main() -> int:
    with open(SCREENER_JSON, encoding="utf-8") as f:
        data = json.load(f)
    by_name = {f["fund_name"]: f for f in data["funds"]}

    sections: list[tuple[str, list[str]]] = [
        ("USD-converted (currency_adjusted=True)", USD_CONVERTED),
        ("Split-adjusted ETFs (clean factor applied)", SPLIT_ADJUSTED_ETFS),
        ("Proxies / matched-proxy (EW exception, BSE-direct, BSE-proxy)", PROXIES),
        ("Absent (currency-mismatch / no rule / no sensible proxy)", ABSENTS),
        ("Normal funds (peer anchors + ICICI Pru E&D rank 1)", NORMAL),
    ]

    rows: list[dict] = []
    missing: list[str] = []
    for label, names in sections:
        for nm in names:
            f = by_name.get(nm)
            if f is None:
                missing.append(nm)
                continue
            rm = f.get("risk_metrics", {}) or {}
            rows.append({
                "AMFI": f["scheme_code"],
                "fund": f["fund_name"],
                "TE_json": f.get("tracking_error_3y_pct"),
                "TD_json": f.get("tracking_difference_3y_pct"),
                "benchmark_matched_series": f.get("benchmark_matched_series") or "",
                "is_proxy": "TRUE" if f.get("benchmark_is_proxy") else "FALSE",
                "currency_adjusted": "TRUE" if f.get("currency_adjusted") else "FALSE",
                "nav_split_status": f.get("nav_split_status") or "",
                "sharpe_json": rm.get("sharpe_3y"),
                "_sample_section": label,
                "_benchmark_match_status": f.get("benchmark_match_status") or "",
                "_category": f.get("category") or "",
            })

    if missing:
        print("[reconcile] WARNING: funds not found in JSON:", file=sys.stderr)
        for nm in missing:
            print(f"  - {nm!r}", file=sys.stderr)

    OUT_CSV.parent.mkdir(parents=True, exist_ok=True)
    headers = [
        "AMFI", "fund", "TE_json", "TD_json", "benchmark_matched_series",
        "is_proxy", "currency_adjusted", "nav_split_status", "sharpe_json",
        "_sample_section", "_benchmark_match_status", "_category",
    ]
    with open(OUT_CSV, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=headers)
        w.writeheader()
        for r in rows:
            w.writerow(r)

    # Integrity self-check (per the OneDrive truncation gotcha in the issues
    # catalogue — though we're now LOCAL so the gotcha is moot, the discipline
    # is the right habit).
    with open(OUT_CSV, encoding="utf-8-sig") as f:
        csv_rows = list(csv.DictReader(f))
    with open(OUT_CSV, "rb") as f:
        f.seek(-2, 2)
        tail = f.read()
    last = csv_rows[-1] if csv_rows else {}
    last_fields = sum(1 for v in last.values() if v not in (None, ""))
    print(f"[reconcile] wrote {OUT_CSV}", file=sys.stderr)
    print(f"  rows: {len(csv_rows)} | last-row populated fields: {last_fields}/{len(headers)} "
          f"| trailing bytes: {tail!r}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
