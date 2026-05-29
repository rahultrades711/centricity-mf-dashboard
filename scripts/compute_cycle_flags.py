"""
compute_cycle_flags.py — Stage B A5 (2026-05-28)

Cycle-over-cycle diff: writes `cycle_flags` on every fund in the latest
`screener-*.json` by comparing each fund against its prior-cycle record.

Powers Home's Active Flags panel and the fund-detail "What Changed" section.
Per-fund flag fields (null/False unless the change crosses a threshold).
Thresholds + rules revised 2026-05-29 (Stage B 'E' round, E2):

    cycle_flags: {
        "manager_change":          {prior, current} | null   (_fl first+last fold:
                                       no flag when only the spelling drifts),
        "aum_cr_current":          float | null     (this cycle's AUM ₹ Cr),
        "aum_cr_prior":            float | null     (prior cycle's AUM ₹ Cr),
        "aum_change_cr":           float | null     (current - prior, ₹ Cr),
        "aum_change_pct":          float | null     (full %, NOT thresholded —
                                       the JS rule applies the ±20% gate so the
                                       threshold lives in ONE place),
        "return_1m_swing_pct":     float | null     (|pp| >= 10; informational
                                       only since E2 — no longer in the panel),
        "return_1y_swing_pct":     float | null     (|pp| >= 5, legacy consumer),
        "rank_change_in_category": int   | null     (|delta| >= 5, legacy consumer),
        "category_changed":        bool             (True when the ranking
                                       category differs prior vs current),
        "status_change":           {prior, current} | null,
        "is_new_in_cycle":         bool,
        "is_dropped_from_cycle":   bool   (always False on the latest JSON,
                                           kept for schema symmetry)
    }

The Home Active Flags PANEL (E2 rule v2) reads only manager_change OR
|aum_change_pct| >= 20. The 1-month return swing was DROPPED from the panel
(E2). aum_change_pct/cr fields are ALWAYS populated when both cycles carry an
AUM (so the flags table can show current / last-month / Δ for every flagged
fund, including manager-change-only rows). return_1y_swing_pct +
rank_change_in_category stay in the JSON for the What-Changed cards.
category_changed powers the What-Changed "Category Reclassified" card and the
gainers/losers exclusion (D9).

The script also reports cycle-level aggregates to stderr — new entrants,
dropped funds, manager-change count — so the operator can sanity-check
against the prior cycle.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = REPO_ROOT / "data"

# Stage B 'E' round E2 (2026-05-29): Active Flags panel rule v2 =
# manager_change OR |AUM change| >= 20%. AUM swing threshold 10 -> 20; the
# 1-month return swing is DROPPED from the panel (kept as an informational
# field). The AUM ±20% gate is applied JS-side (active-flags.js) off the
# always-on aum_change_pct, so AUM_SWING_THRESHOLD_PCT here is used ONLY for
# the stderr aggregate count — the persisted field is never thresholded.
AUM_SWING_THRESHOLD_PCT = 20.0
RETURN_1M_SWING_THRESHOLD_PP = 10.0
RETURN_1Y_SWING_THRESHOLD_PP = 5.0
RANK_CHANGE_THRESHOLD = 5


def _fl(name: str) -> str:
    """First+last name fold — strip dots/commas so "V. Srivatsa" == "V Srivatsa"
    and middle initials are ignored ("Amit Ganatra" == "Amit B. Ganatra").
    Mirrors excel_to_json_screener.py so a pure spelling drift between cycles
    does not trip a false manager_change (Stage B Partner-Review D2/D9)."""
    parts = (name or "").strip().split()
    if not parts:
        return ""

    def _strip(p):
        return p.lower().replace(".", "").replace(",", "").strip()

    if len(parts) == 1:
        return _strip(parts[0])
    return f"{_strip(parts[0])} {_strip(parts[-1])}"


def _latest_two() -> tuple[Path, Path]:
    """Return (latest_path, prior_path) by sorted filename desc."""
    files = sorted(DATA_DIR.glob("screener-*.json"), reverse=True)
    if len(files) < 2:
        raise SystemExit(
            "[cycle-flags] need ≥ 2 screener JSONs in data/; found "
            f"{len(files)}: {[f.name for f in files]}"
        )
    return files[0], files[1]


def _by_amfi(funds: list[dict]) -> dict[int, dict]:
    out: dict[int, dict] = {}
    for f in funds:
        code = f.get("scheme_code")
        if code is None:
            continue
        out[int(code)] = f
    return out


def _diff_one(current: dict, prior: dict | None) -> dict:
    """Compute the per-fund flag object."""
    flags: dict = {
        "manager_change": None,
        "aum_cr_current": current.get("aum_cr") if isinstance(current.get("aum_cr"), (int, float)) else None,
        "aum_cr_prior": None,
        "aum_change_cr": None,
        "aum_change_pct": None,
        "return_1m_swing_pct": None,
        "return_1y_swing_pct": None,
        "rank_change_in_category": None,
        "category_changed": False,
        "status_change": None,
        "is_new_in_cycle": prior is None,
        "is_dropped_from_cycle": False,
    }
    if prior is None:
        return flags

    # manager_change — _fl first+last fold so a spelling drift (e.g.
    # "V. Srivatsa" -> "V Srivatsa") is NOT a false manager change (D2/D9).
    cur_mgr = current.get("manager_name")
    pri_mgr = prior.get("manager_name")
    if cur_mgr and pri_mgr and _fl(cur_mgr) != _fl(pri_mgr):
        flags["manager_change"] = {"prior": pri_mgr, "current": cur_mgr}

    # AUM — always-on facts (current / prior / Δ ₹Cr / Δ %). The ±20% panel
    # gate is applied JS-side off aum_change_pct so the threshold lives once.
    cur_aum = current.get("aum_cr")
    pri_aum = prior.get("aum_cr")
    if isinstance(pri_aum, (int, float)):
        flags["aum_cr_prior"] = round(pri_aum, 2)
    if isinstance(cur_aum, (int, float)) and isinstance(pri_aum, (int, float)):
        flags["aum_change_cr"] = round(cur_aum - pri_aum, 2)
        if pri_aum > 0:
            flags["aum_change_pct"] = round((cur_aum - pri_aum) / pri_aum * 100.0, 2)

    # return_1m_swing_pct — 1-month point-to-point delta from the Monitor
    # overlay (monitor_returns.return_1m_pct); flag if |pp| >= 10.
    cur_r1m = (current.get("monitor_returns") or {}).get("return_1m_pct")
    pri_r1m = (prior.get("monitor_returns") or {}).get("return_1m_pct")
    if isinstance(cur_r1m, (int, float)) and isinstance(pri_r1m, (int, float)):
        pp1m = cur_r1m - pri_r1m
        if abs(pp1m) >= RETURN_1M_SWING_THRESHOLD_PP:
            flags["return_1m_swing_pct"] = round(pp1m, 2)

    # return_1y_swing_pct — raw percentage-point diff; flag if |pp| >= 5
    # (kept for the What-Changed cards; not part of the Active Flags rule).
    cur_r1 = (current.get("trailing_returns") or {}).get("return_1y_pct")
    pri_r1 = (prior.get("trailing_returns") or {}).get("return_1y_pct")
    if isinstance(cur_r1, (int, float)) and isinstance(pri_r1, (int, float)):
        pp = cur_r1 - pri_r1
        if abs(pp) >= RETURN_1Y_SWING_THRESHOLD_PP:
            flags["return_1y_swing_pct"] = round(pp, 2)

    # rank_change_in_category — current - prior; flag if |delta| >= 5. The
    # delta is meaningless when the category itself was redefined, so the
    # What-Changed gainers/losers cards exclude category_changed funds (D9).
    cur_rk = current.get("centricity_rank_in_category")
    pri_rk = prior.get("centricity_rank_in_category")
    if isinstance(cur_rk, int) and isinstance(pri_rk, int):
        delta = cur_rk - pri_rk
        if abs(delta) >= RANK_CHANGE_THRESHOLD:
            flags["rank_change_in_category"] = delta

    # category_changed — the ranking category differs between cycles (the
    # Apr->May taxonomy revisions, e.g. Sector-Thematic -> Value-Contra).
    # sebi_category is null in the JSON, so compare `category`.
    cur_cat = current.get("category")
    pri_cat = prior.get("category")
    if cur_cat and pri_cat and cur_cat != pri_cat:
        flags["category_changed"] = True

    # status_change
    cur_st = current.get("centricity_score_status")
    pri_st = prior.get("centricity_score_status")
    if cur_st and pri_st and cur_st != pri_st:
        flags["status_change"] = {"prior": pri_st, "current": cur_st}

    return flags


def run(latest_path: Path, prior_path: Path) -> dict:
    with open(latest_path, "r", encoding="utf-8") as f:
        latest = json.load(f)
    with open(prior_path, "r", encoding="utf-8") as f:
        prior = json.load(f)

    latest_funds = latest.get("funds", [])
    prior_funds = prior.get("funds", [])
    prior_by_amfi = _by_amfi(prior_funds)
    latest_amfis = {int(f["scheme_code"]) for f in latest_funds if f.get("scheme_code") is not None}

    new_count = 0
    dropped_count = 0
    # None-gated value flags (counted when not None)
    flag_counts: dict[str, int] = {
        "manager_change": 0,
        "return_1m_swing_pct": 0,
        "return_1y_swing_pct": 0,
        "rank_change_in_category": 0,
        "status_change": 0,
    }
    # aum_change_pct is always-on; count only those crossing the ±20% panel gate.
    aum_swing_count = 0
    category_changed_count = 0
    # Active Flags panel rule v2 (E2): manager_change OR |AUM change| >= 20%
    active_panel_count = 0

    for fund in latest_funds:
        code = fund.get("scheme_code")
        prior_fund = prior_by_amfi.get(int(code)) if code is not None else None
        flags = _diff_one(fund, prior_fund)
        fund["cycle_flags"] = flags
        if flags["is_new_in_cycle"]:
            new_count += 1
        for k in flag_counts:
            if flags[k] is not None:
                flag_counts[k] += 1
        acp = flags["aum_change_pct"]
        aum_swings = isinstance(acp, (int, float)) and abs(acp) >= AUM_SWING_THRESHOLD_PCT
        if aum_swings:
            aum_swing_count += 1
        if flags["category_changed"]:
            category_changed_count += 1
        if flags["manager_change"] is not None or aum_swings:
            active_panel_count += 1

    # Dropped funds — present in prior, absent in latest
    for code, _ in prior_by_amfi.items():
        if code not in latest_amfis:
            dropped_count += 1

    funds_with_any_flag = sum(
        1 for f in latest_funds if (
            any(f["cycle_flags"][k] is not None for k in flag_counts)
            or f["cycle_flags"]["category_changed"]
            or (isinstance(f["cycle_flags"]["aum_change_pct"], (int, float))
                and abs(f["cycle_flags"]["aum_change_pct"]) >= AUM_SWING_THRESHOLD_PCT)
        )
    )

    with open(latest_path, "w", encoding="utf-8") as f:
        json.dump(latest, f, ensure_ascii=False, indent=2, default=str)

    print(
        f"[cycle-flags] latest={latest_path.name}  prior={prior_path.name}\n"
        f"  new_in_cycle:     {new_count}\n"
        f"  dropped_from_cycle: {dropped_count} (reported, not persisted on latest)\n"
        f"  flag counts (notable changes only):\n"
        f"    manager_change (_fl-folded):             {flag_counts['manager_change']}\n"
        f"    aum_change |%|≥20 (panel gate):          {aum_swing_count}\n"
        f"    return_1m_swing_pct (|pp|≥10, info only): {flag_counts['return_1m_swing_pct']}\n"
        f"    return_1y_swing_pct (|pp|≥5, legacy):    {flag_counts['return_1y_swing_pct']}\n"
        f"    rank_change_in_category (|Δ|≥5, legacy): {flag_counts['rank_change_in_category']}\n"
        f"    category_changed:                        {category_changed_count}\n"
        f"    status_change:                           {flag_counts['status_change']}\n"
        f"  Active Flags panel v2 (mgr OR |AUM Δ|≥20%): {active_panel_count}\n"
        f"  funds with at least one non-null/true flag: {funds_with_any_flag}",
        file=sys.stderr,
    )
    return {
        "new_count": new_count,
        "dropped_count": dropped_count,
        "flag_counts": flag_counts,
        "aum_swing_count": aum_swing_count,
        "category_changed_count": category_changed_count,
        "active_panel_count": active_panel_count,
        "funds_with_any_flag": funds_with_any_flag,
    }


def main(argv: list[str] | None = None) -> int:
    argv = argv if argv is not None else sys.argv[1:]
    if argv:
        latest_path = Path(argv[0])
        prior_path = Path(argv[1]) if len(argv) > 1 else None
        if prior_path is None:
            _, prior_path = _latest_two()
    else:
        latest_path, prior_path = _latest_two()
    run(latest_path, prior_path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
