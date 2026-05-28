"""
compute_cycle_flags.py — Stage B A5 (2026-05-28)

Cycle-over-cycle diff: writes `cycle_flags` on every fund in the latest
`screener-*.json` by comparing each fund against its prior-cycle record.

Powers Home's Active Flags panel and the fund-detail "What Changed" section.
Per-fund flag fields (entries are null unless the change crosses a threshold):

    cycle_flags: {
        "manager_change":          {prior, current} | null,
        "aum_swing_pct":           float | null     (|%| >= 20),
        "return_1y_swing_pct":     float | null     (|pp| >= 5),
        "rank_change_in_category": int   | null     (|delta| >= 5),
        "status_change":           {prior, current} | null,
        "is_new_in_cycle":         bool,
        "is_dropped_from_cycle":   bool   (always False on the latest JSON,
                                           kept for schema symmetry)
    }

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

AUM_SWING_THRESHOLD_PCT = 20.0
RETURN_SWING_THRESHOLD_PP = 5.0
RANK_CHANGE_THRESHOLD = 5


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
        "aum_swing_pct": None,
        "return_1y_swing_pct": None,
        "rank_change_in_category": None,
        "status_change": None,
        "is_new_in_cycle": prior is None,
        "is_dropped_from_cycle": False,
    }
    if prior is None:
        return flags

    # manager_change
    cur_mgr = current.get("manager_name")
    pri_mgr = prior.get("manager_name")
    if cur_mgr and pri_mgr and cur_mgr != pri_mgr:
        flags["manager_change"] = {"prior": pri_mgr, "current": cur_mgr}

    # aum_swing_pct — % change; flag if |pct| >= 20
    cur_aum = current.get("aum_cr")
    pri_aum = prior.get("aum_cr")
    if isinstance(cur_aum, (int, float)) and isinstance(pri_aum, (int, float)) and pri_aum > 0:
        pct = (cur_aum - pri_aum) / pri_aum * 100.0
        if abs(pct) >= AUM_SWING_THRESHOLD_PCT:
            flags["aum_swing_pct"] = round(pct, 2)

    # return_1y_swing_pct — raw percentage-point diff; flag if |pp| >= 5
    cur_r1 = (current.get("trailing_returns") or {}).get("return_1y_pct")
    pri_r1 = (prior.get("trailing_returns") or {}).get("return_1y_pct")
    if isinstance(cur_r1, (int, float)) and isinstance(pri_r1, (int, float)):
        pp = cur_r1 - pri_r1
        if abs(pp) >= RETURN_SWING_THRESHOLD_PP:
            flags["return_1y_swing_pct"] = round(pp, 2)

    # rank_change_in_category — current - prior; flag if |delta| >= 5
    cur_rk = current.get("centricity_rank_in_category")
    pri_rk = prior.get("centricity_rank_in_category")
    if isinstance(cur_rk, int) and isinstance(pri_rk, int):
        delta = cur_rk - pri_rk
        if abs(delta) >= RANK_CHANGE_THRESHOLD:
            flags["rank_change_in_category"] = delta

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
    flag_counts: dict[str, int] = {
        "manager_change": 0,
        "aum_swing_pct": 0,
        "return_1y_swing_pct": 0,
        "rank_change_in_category": 0,
        "status_change": 0,
    }

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

    # Dropped funds — present in prior, absent in latest
    for code, _ in prior_by_amfi.items():
        if code not in latest_amfis:
            dropped_count += 1

    funds_with_any_flag = sum(
        1 for f in latest_funds if any(
            f["cycle_flags"][k] is not None for k in flag_counts
        )
    )

    with open(latest_path, "w", encoding="utf-8") as f:
        json.dump(latest, f, ensure_ascii=False, indent=2, default=str)

    print(
        f"[cycle-flags] latest={latest_path.name}  prior={prior_path.name}\n"
        f"  new_in_cycle:     {new_count}\n"
        f"  dropped_from_cycle: {dropped_count} (reported, not persisted on latest)\n"
        f"  flag counts (notable changes only):\n"
        f"    manager_change:            {flag_counts['manager_change']}\n"
        f"    aum_swing_pct (|%|≥20):    {flag_counts['aum_swing_pct']}\n"
        f"    return_1y_swing_pct (|pp|≥5): {flag_counts['return_1y_swing_pct']}\n"
        f"    rank_change_in_category (|Δ|≥5): {flag_counts['rank_change_in_category']}\n"
        f"    status_change:             {flag_counts['status_change']}\n"
        f"  funds with at least one non-null flag: {funds_with_any_flag}",
        file=sys.stderr,
    )
    return {
        "new_count": new_count,
        "dropped_count": dropped_count,
        "flag_counts": flag_counts,
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
