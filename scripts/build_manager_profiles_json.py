"""
build_manager_profiles_json.py — Stage B A4 (2026-05-28)
                                + Cowork patch 2026-05-28 (Monitor-keyed canonical
                                  spelling with aka aliases)

Rebuild `data/manager-profiles.json` from canonical sources:
  1. `data/screener-<latest>.json`         (universe + manager_co_managers — Monitor spelling, A1 normalised)
  2. `data/manager-history-<latest>.json`  (per-fund dated manager records, Morningstar spelling)

Why the rewrite (Cowork audit 2026-05-28):
  After A1's switch to Monitor's "Fund Manager" spelling for the canonical
  manager_name, ~77 of 752 non-passive funds carried a screener `manager_name`
  whose exact-string lookup MISSED in this file because the profile keys came
  from the Morningstar long-form spelling. Examples:
      Monitor (A1 canon)        ↔   Morningstar long-form (old key)
      Amit Ganatra              ↔   Amit B. Ganatra
      V. Srivatsa               ↔   V Srivatsa
      Sachin Relekar            ↔   Sachin Anandrao Relekar
      Shibani Kurian            ↔   Shibani Sircar Kurian
      Renjith Sivaram           ↔   Renjith Sivaram Radhakrishnan
      Ennettee Fernandes        ↔   Ennette Fernandes
  Because `js/manager-profiles.js` does exact-string `_byName.has(fromUrl)`
  for the URL `?manager=` param, clicking the lead-manager link on these
  funds opened the empty state — defeating B1's central UX win for the very
  population A1 was designed to surface.

Fix: profile keys are now the Monitor spelling (from screener's
`manager_co_managers`) whenever a Morningstar manager can be matched to a
Monitor co-manager on the same fund. Per profile, an `aka` array carries the
Morningstar long-forms. A top-level `aliases` map (`{long_form: canonical}`)
gives the UI a flat lookup table so both the lead spelling and the
Morningstar spelling resolve to the same profile.

Matching strategy (per-fund pass):
  • Exact name match (case-insensitive, whitespace-folded) wins first.
  • Surname match (last whitespace-separated token, lowercased) is the
    fallback for current managers only.
  • Past managers (Morningstar `end != null`) where the surname doesn't
    appear in any current Monitor co-list across all funds stay keyed by
    Morningstar's spelling — they're not on any current Monitor sheet so
    there's no Monitor canonical to fold into.

Output schema:
  {
    "scraped_at":  "YYYY-MM-DD",
    "source":      "rebuilt from screener-<cycle> + manager-history-<date>",
    "aliases":     { "Amit B. Ganatra": "Amit Ganatra", ... },
    "managers": {
      "<Canonical Name>": {
        "aka":                 ["Amit B. Ganatra", ...],   // Morningstar long-forms
        "currently_managing":  [{amfi, scheme_name, category, since, tenure_yrs}, ...],
        "previously_managed":  [{amfi, scheme_name, category, started, ended, tenure_yrs}, ...]
      },
      ...
    }
  }

Inclusion rules (catalogue §7.2 + Stage B kickoff lock 2026-05-28):
  - `currently_managing` — Morningstar `is_current` AND a Monitor co-manager
    match on the same fund. Both signals required (the kickoff explicitly
    excludes the "Morningstar-current but not screener-listed" case).
  - `previously_managed` — Morningstar `end != null`. Sorted by `ended` desc.
  - Filter funds not in the current cycle's universe (e.g. AMFI 148762).
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


def _norm(s: str) -> str:
    """Lowercase + collapse internal whitespace. Empty string for None."""
    if not s:
        return ""
    return " ".join(str(s).split()).strip().lower()


def _surname(s: str) -> str:
    """Last whitespace-separated token, lowercased. Empty string for None."""
    if not s:
        return ""
    parts = str(s).strip().split()
    return parts[-1].lower() if parts else ""


def _fl(name: str) -> str:
    """First+last fold (mirrors excel_to_json_screener.py) so a fund's lead
    `manager_name` matches the canonical co-manager spelling even across
    middle-initial / dot drift ("Amit Ganatra" == "Amit B. Ganatra")."""
    parts = (name or "").strip().split()
    if not parts:
        return ""
    def _s(p):
        return p.lower().replace(".", "").replace(",", "").strip()
    return _s(parts[0]) if len(parts) == 1 else f"{_s(parts[0])} {_s(parts[-1])}"


# ---------------------------------------------------------------------------
# Canonical-source override (Stage B Partner-Review D3, 2026-05-28/29).
# See mf-issues-solutions SKILL.md §7.9.
#
# Some managers' CO-manager attribution cannot be resolved from the pipeline's
# canonical sources:
#   • MF Monitor carries only the LEAD (one Fund Manager column per sheet; no
#     "Fund Manager 2/3" co-manager column exists — verified 2026-05-29).
#   • Morningstar's LIVE "Manager Name" datapoint (OF015) is ALSO lead-only.
#   • The full co-manager list comes ONLY from the Morningstar manager-history
#     EXPORT, which is stale for ICICI's dedicated overseas FM Sharmila D'Silva
#     ("D'Mello") — it carries `end=null` on funds ICICI has since reassigned,
#     so it over-counts her at 33 in-universe (real book ≈ 16 schemes per
#     ICICI factsheets / web, of which ~3 are off-universe FoFs).
#
# This override pins (a) the off-universe overseas FoFs she manages that are
# NOT in the screener universe (name + AUM, ₹ Cr — live Morningstar Fund Size
# OF009, 2026-05), and optionally (b) `current_in_universe_amfis` to gate her
# in-universe co_managed to her confirmed current funds. When (b) is None the
# builder keeps the Morningstar-export set and STAMPS a `_needs_partner_prune`
# flag on the profile so the residual is visible (the exact in-universe prune
# needs partner confirmation — no pipeline source can derive it).
MANAGER_OVERRIDES: dict[str, dict] = {
    "Sharmila D'Silva": {
        # "D'Mello" is the same person (live Morningstar OF015 returns
        # "Sharmila D'Silva"; aggregators/AMC notices use "D'Mello"). Register
        # both so URL deep-links resolve either spelling (D5).
        "aka_extra": ["Sharmila D'Mello", "Sharmila Dmello", "Sharmila D Mello"],
        "off_universe_overseas": [
            {"scheme_name": "ICICI Pru Global Advantage Fund (FOF)", "aum_cr": 390, "role": "lead"},
            {"scheme_name": "ICICI Pru Passive Multi-Asset Fund of Fund", "aum_cr": 1538, "role": "co"},
            {"scheme_name": "ICICI Pru Global Stable Equity Fund (FOF)", "aum_cr": 88, "role": "co"},
        ],
        "current_in_universe_amfis": None,  # PENDING partner confirmation
    },
}


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

    # Universe-wide Monitor name set (for past-manager fold-in check)
    universe_monitor_names: dict[str, str] = {}  # norm -> canonical (Monitor spelling)
    universe_monitor_surnames: dict[str, str] = {}  # surname -> canonical (first encountered)
    for fund in screener.get("funds", []):
        for nm in fund.get("manager_co_managers") or []:
            if not nm:
                continue
            k = _norm(nm)
            if k not in universe_monitor_names:
                universe_monitor_names[k] = nm
            sk = _surname(nm)
            if sk and sk not in universe_monitor_surnames:
                universe_monitor_surnames[sk] = nm

    managers: dict[str, dict] = {}
    aliases: dict[str, str] = {}  # alternate-spelling -> canonical key
    skipped_out_of_universe = 0
    monitor_matches = {"exact": 0, "surname": 0, "none": 0}

    def _get_bucket(canonical: str) -> dict:
        if canonical not in managers:
            managers[canonical] = {
                "aka": [],
                "currently_managing": [],
                "previously_managed": [],
            }
        return managers[canonical]

    def _add_aka(canonical: str, alt: str) -> None:
        if alt == canonical:
            return
        bucket = _get_bucket(canonical)
        if alt not in bucket["aka"]:
            bucket["aka"].append(alt)
        aliases[alt] = canonical

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
        co_managers = [n for n in (fund_rec.get("manager_co_managers") or []) if n]
        co_norm = {_norm(n): n for n in co_managers}
        co_surname = {_surname(n): n for n in co_managers if _surname(n)}

        for entry in fund_mh.get("managers", []):
            ms_name_raw = entry.get("name")
            if not ms_name_raw:
                continue
            ms_norm = _norm(ms_name_raw)
            ms_surname = _surname(ms_name_raw)
            is_current = entry.get("is_current") is True or entry.get("end") is None

            # Match priority: exact name → surname (current only) → fall back to Morningstar spelling.
            canonical: str
            match_kind: str
            if ms_norm in co_norm:
                canonical = co_norm[ms_norm]
                match_kind = "exact"
            elif is_current and ms_surname and ms_surname in co_surname:
                canonical = co_surname[ms_surname]
                match_kind = "surname"
            elif ms_norm in universe_monitor_names:
                # Past manager whose name (verbatim) is a current Monitor lead
                # on some OTHER fund — fold this past entry into the Monitor
                # canonical so the profile aggregates current + past correctly.
                canonical = universe_monitor_names[ms_norm]
                match_kind = "exact"
            elif (not is_current) and ms_surname and ms_surname in universe_monitor_surnames:
                # Past manager whose surname matches a current Monitor lead
                # elsewhere — fold past entry under the Monitor canonical.
                canonical = universe_monitor_surnames[ms_surname]
                match_kind = "surname"
            else:
                canonical = ms_name_raw
                match_kind = "none"

            if match_kind != "none":
                _add_aka(canonical, ms_name_raw)
            monitor_matches[match_kind] += 1

            bucket = _get_bucket(canonical)
            in_co = (ms_norm in co_norm) or (is_current and ms_surname in co_surname)

            if is_current and in_co:
                bucket["currently_managing"].append({
                    "amfi": str(amfi),
                    "scheme_name": fund_rec.get("fund_name"),
                    "category": fund_rec.get("category"),
                    "since": entry.get("start"),
                    "tenure_yrs": entry.get("tenure_years"),
                })
            elif not is_current:
                bucket["previously_managed"].append({
                    "amfi": str(amfi),
                    "scheme_name": fund_rec.get("fund_name"),
                    "category": fund_rec.get("category"),
                    "started": entry.get("start"),
                    "ended": entry.get("end"),
                    "tenure_yrs": entry.get("tenure_years"),
                })

        # Cowork patch — additionally fold Monitor leads that have NO matching
        # Morningstar entry on this fund. They get an empty currently_managing
        # row so the click-through resolves to a real profile (tenure data is
        # missing because Morningstar doesn't have a record yet — e.g. brand-
        # new fund launches before the Morningstar refresh).
        ms_norms_on_fund = {_norm(e.get("name")) for e in fund_mh.get("managers", []) if e.get("name")}
        ms_surnames_on_fund = {_surname(e.get("name")) for e in fund_mh.get("managers", []) if e.get("name")}
        for mn in co_managers:
            mn_norm = _norm(mn)
            mn_surname = _surname(mn)
            if mn_norm in ms_norms_on_fund or (mn_surname and mn_surname in ms_surnames_on_fund):
                continue  # already covered
            bucket = _get_bucket(mn)
            bucket["currently_managing"].append({
                "amfi": str(amfi),
                "scheme_name": fund_rec.get("fund_name"),
                "category": fund_rec.get("category"),
                "since": None,
                "tenure_yrs": None,
            })

    # Cowork patch — final pass for screener funds NOT in manager-history at
    # all (new launches Morningstar hasn't covered yet — e.g. JioBlackRock
    # Direct Plans, Wealth Company, Unifi, etc.). Ensure every Monitor lead
    # has at least an empty profile entry so the click-through resolves.
    for fund in screener.get("funds", []):
        amfi = fund.get("scheme_code")
        if amfi is None:
            continue
        amfi_str = str(amfi)
        if amfi_str in mh_funds:
            continue  # already covered in the main pass
        for mn in (fund.get("manager_co_managers") or []):
            if not mn:
                continue
            bucket = _get_bucket(mn)
            # Avoid duplicate insertion if this Monitor lead is on multiple
            # universe-missing-from-Morningstar funds
            if not any(c.get("amfi") == amfi_str for c in bucket["currently_managing"]):
                bucket["currently_managing"].append({
                    "amfi": amfi_str,
                    "scheme_name": fund.get("fund_name"),
                    "category": fund.get("category"),
                    "since": None,
                    "tenure_yrs": None,
                })

    # ---- D4: de-dupe + enrich with aum_cr + split into Main (lead) / Co ----
    # A fund is "main" for a manager iff that manager is the fund's LEAD
    # (screener `manager_name`), matched via the _fl first+last fold; otherwise
    # the manager is in manager_co_managers but not the lead -> "co".
    for canonical, prof in managers.items():
        canon_fl = _fl(canonical)
        # de-dupe currently_managing by amfi (a fund may be appended across
        # passes); keep the entry that carries tenure data.
        seen: dict[str, dict] = {}
        for c in prof["currently_managing"]:
            amfi = c.get("amfi")
            fund = fund_index.get(int(amfi)) if amfi else None
            c["aum_cr"] = fund.get("aum_cr") if fund else None
            prev = seen.get(amfi)
            if prev is None or (c.get("tenure_yrs") is not None and prev.get("tenure_yrs") is None):
                seen[amfi] = c
        prof["currently_managing"] = list(seen.values())
        for p in prof["previously_managed"]:
            amfi = p.get("amfi")
            fund = fund_index.get(int(amfi)) if amfi else None
            p["aum_cr"] = fund.get("aum_cr") if fund else None

        main_managed, co_managed = [], []
        for c in prof["currently_managing"]:
            amfi = c.get("amfi")
            fund = fund_index.get(int(amfi)) if amfi else None
            is_lead = bool(fund) and _fl(fund.get("manager_name")) == canon_fl
            (main_managed if is_lead else co_managed).append(c)
        prof["main_managed"] = main_managed
        prof["co_managed"] = co_managed

    # ---- D3: apply documented canonical overrides (D'Silva etc.) ----
    for canonical, ov in MANAGER_OVERRIDES.items():
        prof = managers.get(canonical)
        if not prof:
            continue
        keep = ov.get("current_in_universe_amfis")
        if keep is not None:  # gate in-universe co to the confirmed current set
            keepset = {str(a) for a in keep}
            moved = [c for c in prof["currently_managing"] if c.get("amfi") not in keepset]
            prof["currently_managing"] = [c for c in prof["currently_managing"] if c.get("amfi") in keepset]
            prof["main_managed"] = [c for c in prof["main_managed"] if c.get("amfi") in keepset]
            prof["co_managed"] = [c for c in prof["co_managed"] if c.get("amfi") in keepset]
            for c in moved:  # demote pruned current funds to previously_managed
                prof["previously_managed"].append({
                    "amfi": c.get("amfi"), "scheme_name": c.get("scheme_name"),
                    "category": c.get("category"), "started": c.get("since"),
                    "ended": None, "tenure_yrs": c.get("tenure_yrs"),
                    "aum_cr": c.get("aum_cr"), "_source": "override-prune",
                })
        else:
            # No pipeline source can prune her co-attribution (Monitor + live
            # Morningstar are lead-only). Flag the residual for partner review.
            prof["_needs_partner_prune"] = True
        if ov.get("off_universe_overseas"):
            prof["off_universe_overseas"] = ov["off_universe_overseas"]
        for alt in ov.get("aka_extra", []):  # register extra spellings as aliases
            if alt != canonical:
                if alt not in prof["aka"]:
                    prof["aka"].append(alt)
                aliases[alt] = canonical

    # ---- Sort (AUM desc for D5 display) + AUM totals + counts (D4) ----
    def _aum(x):
        return x.get("aum_cr") or 0
    for prof in managers.values():
        prof["currently_managing"].sort(key=_aum, reverse=True)
        prof["main_managed"].sort(key=_aum, reverse=True)
        prof["co_managed"].sort(key=_aum, reverse=True)
        prof["previously_managed"].sort(key=lambda x: x.get("ended") or "", reverse=True)
        prof["aka"].sort()
        main_aum = sum(_aum(c) for c in prof["main_managed"])
        co_aum = sum(_aum(c) for c in prof["co_managed"])
        prof["total_aum_cr"] = round(main_aum + co_aum)   # Main + Co (in-universe)
        prof["main_aum_cr"] = round(main_aum)
        prof["main_count"] = len(prof["main_managed"])
        prof["co_count"] = len(prof["co_managed"])
        prof["previously_count"] = len(prof["previously_managed"])

    # Defensive — drop profiles with no current + no previous + no off-universe
    managers = {nm: prof for nm, prof in managers.items()
                if prof["currently_managing"] or prof["previously_managed"]
                or prof.get("off_universe_overseas")}

    # Prune aliases that point to dropped profiles
    aliases = {alt: canon for alt, canon in aliases.items() if canon in managers}

    output = {
        "scraped_at": _dt.date.today().isoformat(),
        "source": (
            f"rebuilt from {screener_path.name} + {manager_history_path.name} "
            f"(Monitor-keyed canonical + aka aliases; D4 Main/Co split + AUM totals; "
            f"D3 canonical overrides)"
        ),
        "aliases": aliases,
        "managers": managers,
    }

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, separators=(",", ":"))

    total_main = sum(p["main_count"] for p in managers.values())
    print(
        f"[manager-profiles] managers: {len(managers)} · aliases: {len(aliases)} · "
        f"matches exact={monitor_matches['exact']} surname={monitor_matches['surname']} none={monitor_matches['none']} · "
        f"out-of-universe AMFIs skipped: {skipped_out_of_universe} · "
        f"total main_count (≈ funds w/ a resolvable lead): {total_main} · "
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
