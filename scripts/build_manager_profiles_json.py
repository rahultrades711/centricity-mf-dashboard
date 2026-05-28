"""
build_manager_profiles_json.py — Stage B A4 (2026-05-28)

Rebuild `data/manager-profiles.json` from the canonical sources:
  1. `data/screener-<latest>.json`         (universe + manager_co_managers + manager_history per fund)
  2. `data/manager-history-<latest>.json`  (per-fund dated manager records with is_current flag)

Replaces the previous LinkedIn-free scraper output that surfaced only 1 manager
(`Sudip Suresh More`). The Manager Profiles page reads this JSON to render the
"Currently Managing" + "Previously Managed" lists for each manager.

Output schema:
  {
    "scraped_at":  "YYYY-MM-DD",
    "source":      "rebuilt from screener-<cycle> + manager-history-<date>",
    "managers": {
      "<Manager Name>": {
        "currently_managing": [
          {"amfi": "100356", "scheme_name": "...", "category": "...",
           "since": "YYYY-MM-DD", "tenure_yrs": 10.4},
          ...
        ],
        "previously_managed": [
          {"amfi": "...", "scheme_name": "...", "category": "...",
           "started": "...", "ended": "...", "tenure_yrs": ...},
          ...
        ]
      },
      ...
    }
  }

Inclusion rules (catalogue §7.2 + Stage B kickoff lock 2026-05-28):
- `currently_managing` entry — manager appears in the screener fund's
  `manager_co_managers` (so the lead-and-co list confirms her CURRENT role)
  AND the manager's `manager_history` entry for that fund has `end is null`
  (Morningstar confirms she's still active). Both signals required.
- `previously_managed` entry — `manager_history` has `end != null`. Sorted
  by `ended` desc.
- **Filter funds not in the current cycle's universe** (e.g. AMFI 148762
  SBI US Specific Eq Actv FoF is in manager-history but excluded from the
  1,249-fund screener) — omit from BOTH lists.

Manager keying:
- Use the spelling from the screener's `manager_co_managers` (A1's
  normalised form) when matching against the Morningstar manager-history
  entry. If a name differs by case only, prefer the screener spelling.
"""
from __future__ import annotations

import datetime as _dt
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = REPO_ROOT / "data"


def _latest(glob_pattern: str) -> Path | None:
    candidates = sorted(DATA_DIR.glob(glob_pattern), reverse=True)
    return candidates[0] if candidates else None


def _norm_name_key(name: str) -> str:
    """Loose-equality key for matching across spellings — case + whitespace folded."""
    if not name:
        return ""
    return " ".join(name.split()).strip().lower()


def build(
    screener_path: Path,
    manager_history_path: Path,
    out_path: Path,
) -> dict:
    with open(screener_path, "r", encoding="utf-8") as f:
        screener = json.load(f)
    with open(manager_history_path, "r", encoding="utf-8") as f:
        mh = json.load(f)

    # Active universe + fund index
    active_amfis: set[int] = set()
    fund_index: dict[int, dict] = {}
    for fund in screener.get("funds", []):
        amfi = fund.get("scheme_code")
        if amfi is None:
            continue
        active_amfis.add(amfi)
        fund_index[amfi] = fund

    # Manager spelling preferences (from screener.manager_co_managers — A1 normalised)
    # name_key (lowercased) -> canonical display name (first encountered)
    preferred_spelling: dict[str, str] = {}
    for fund in screener.get("funds", []):
        for nm in fund.get("manager_co_managers") or []:
            if not nm:
                continue
            k = _norm_name_key(nm)
            if k not in preferred_spelling:
                preferred_spelling[k] = nm

    # Walk manager-history; build per-manager lists
    managers: dict[str, dict] = {}
    skipped_out_of_universe = 0
    mh_funds = mh.get("funds", {})

    for amfi_str, fund_mh in mh_funds.items():
        try:
            amfi = int(amfi_str)
        except (TypeError, ValueError):
            continue
        if amfi not in active_amfis:
            skipped_out_of_universe += 1
            continue

        fund_rec = fund_index[amfi]
        co_managers_set = {
            _norm_name_key(nm) for nm in (fund_rec.get("manager_co_managers") or []) if nm
        }
        fund_name = fund_rec.get("fund_name")
        category = fund_rec.get("category")

        for entry in fund_mh.get("managers", []):
            name_raw = entry.get("name")
            if not name_raw:
                continue
            key = _norm_name_key(name_raw)
            # Prefer the screener's normalised spelling when available;
            # fall back to Morningstar's spelling
            display_name = preferred_spelling.get(key, name_raw)
            if display_name not in managers:
                managers[display_name] = {
                    "currently_managing": [],
                    "previously_managed": [],
                }
            bucket = managers[display_name]

            is_current_mh = entry.get("is_current") is True or entry.get("end") is None
            in_screener_co = key in co_managers_set

            if is_current_mh and in_screener_co:
                bucket["currently_managing"].append({
                    "amfi": str(amfi),
                    "scheme_name": fund_name,
                    "category": category,
                    "since": entry.get("start"),
                    "tenure_yrs": entry.get("tenure_years"),
                })
            elif not is_current_mh:
                bucket["previously_managed"].append({
                    "amfi": str(amfi),
                    "scheme_name": fund_name,
                    "category": category,
                    "started": entry.get("start"),
                    "ended": entry.get("end"),
                    "tenure_yrs": entry.get("tenure_years"),
                })
            # else: is_current per Morningstar but NOT in screener.manager_co_managers
            # → ambiguous / stale; omit per kickoff rule (both signals required)

    # Sort each manager's lists
    for prof in managers.values():
        prof["currently_managing"].sort(
            key=lambda x: x.get("tenure_yrs") or 0, reverse=True
        )
        prof["previously_managed"].sort(
            key=lambda x: x.get("ended") or "", reverse=True
        )

    # Drop managers with empty BOTH lists (none expected, but defensive)
    managers = {nm: prof for nm, prof in managers.items()
                if prof["currently_managing"] or prof["previously_managed"]}

    output = {
        "scraped_at": _dt.date.today().isoformat(),
        "source": (
            f"rebuilt from {screener_path.name} + {manager_history_path.name}"
        ),
        "managers": managers,
    }

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, separators=(",", ":"))

    print(
        f"[manager-profiles] managers: {len(managers)}; "
        f"out-of-universe AMFIs skipped: {skipped_out_of_universe}; "
        f"file: {out_path.name} ({out_path.stat().st_size:,} bytes)",
        file=sys.stderr,
    )
    return output


def main(argv: list[str] | None = None) -> int:
    argv = argv if argv is not None else sys.argv[1:]
    screener = Path(argv[0]) if argv else _latest("screener-*.json")
    mh = Path(argv[1]) if len(argv) > 1 else _latest("manager-history-*.json")
    if not screener or not screener.exists():
        print("[manager-profiles] no screener JSON found", file=sys.stderr)
        return 2
    if not mh or not mh.exists():
        print("[manager-profiles] no manager-history JSON found", file=sys.stderr)
        return 2
    out = DATA_DIR / "manager-profiles.json"
    build(screener, mh, out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
