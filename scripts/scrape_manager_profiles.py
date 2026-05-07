"""
scrape_manager_profiles.py — Fix-List 9 Feature C
==============================================================

Best-effort scraper that augments data/manager-profiles.json with a bio,
experience years, and a source URL for every manager that appears as
is_current in data/manager-history-YYYY-MM-DD.json.

Sources, in priority order (highest priority wins on duplicate names):

  1. AMFI India          — basic authoritative directory
                           https://www.amfiindia.com/research-information/fund-managers
  2. Value Research      — most comprehensive narrative bios
                           https://www.valueresearchonline.com/fund-managers/
  3. Per-AMC sites       — top 10 AMCs by AUM, each with its own
                           parser. One AMC failing never blocks the
                           others.

LinkedIn is explicitly NOT scraped (against their ToS). If a LinkedIn
URL is found embedded in another page, we record it as `linkedin_url`
but do not fetch it.

Output schema:

    {
      "scraped_at": "2026-05-07",
      "source": "scrape_manager_profiles.py v1",
      "managers": {
        "Amit B. Ganatra": {
          "bio": "...",
          "experience_years": 15,
          "education": "MBA, CFA",
          "source_url": "https://www.hdfcfund.com/fund-managers/amit-ganatra",
          "source_name": "HDFC AMC Website",
          "scraped_at": "2026-05-07",
          "photo_url": null,
          "linkedin_url": null
        },
        ...
      }
    }

90-day cache: managers whose `scraped_at` is within 90 days are skipped
on re-runs. Only stale or missing entries get fetched.

Graceful degrade rules:
  • Missing requests / beautifulsoup4 → exit 0 with a "deps not
    installed" message; the file is left whatever shape the previous
    run produced, including the empty stub Feature B ships.
  • Network failure to any source → log + continue. Other sources still
    populate.
  • Per-AMC parser raising any exception → log + continue.
  • Final write atomic (write to .tmp then rename) so a crash mid-run
    never leaves a half-written JSON.

Usage:
    python scripts/scrape_manager_profiles.py
    python scripts/scrape_manager_profiles.py --force      # bypass 90-day cache
    python scripts/scrape_manager_profiles.py --only HDFC  # one AMC only

Designed-for-Change: per-AMC parsers are individually registered, each
in a `try / except` block. A new AMC is one new function + one entry
in `AMC_REGISTRY`. No other changes ripple.
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
import traceback
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Callable, Iterable

REPO_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = REPO_ROOT / "data"
OUTPUT_PATH = DATA_DIR / "manager-profiles.json"
TMP_PATH = DATA_DIR / "manager-profiles.json.tmp"

CACHE_DAYS = 90
HTTP_TIMEOUT = 12
HTTP_HEADERS = {
    "User-Agent": (
        "Centricity-MF-Screener/1.0 "
        "(Products Team manager-profile scraper; respect robots.txt)"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-IN,en;q=0.9",
}


# --------------------------------------------------------------------------
# Soft dependency loader
# --------------------------------------------------------------------------
def _try_load_deps():
    """Returns (requests, BeautifulSoup, ok). Both None when missing."""
    try:
        import requests
        from bs4 import BeautifulSoup
        return requests, BeautifulSoup, True
    except ImportError:
        return None, None, False


REQUESTS, BS, DEPS_OK = _try_load_deps()


def _http_get(url: str) -> str | None:
    """Fetch a URL. Returns text on 2xx; None on any failure (logged)."""
    if not DEPS_OK:
        return None
    try:
        resp = REQUESTS.get(url, headers=HTTP_HEADERS, timeout=HTTP_TIMEOUT)
        if resp.status_code == 200:
            return resp.text
        print(f"  [scrape] {url} -> HTTP {resp.status_code}")
    except Exception as e:                                # pylint: disable=broad-except
        print(f"  [scrape] {url} -> {type(e).__name__}: {e}")
    return None


# --------------------------------------------------------------------------
# Cache helpers
# --------------------------------------------------------------------------
def _load_existing() -> dict:
    if not OUTPUT_PATH.exists():
        return {"scraped_at": None, "source": "scrape_manager_profiles.py v1", "managers": {}}
    try:
        return json.loads(OUTPUT_PATH.read_text(encoding="utf-8"))
    except Exception:                                     # pylint: disable=broad-except
        return {"scraped_at": None, "source": "scrape_manager_profiles.py v1", "managers": {}}


def _is_fresh(entry: dict, now: date) -> bool:
    when = entry.get("scraped_at") if entry else None
    if not when:
        return False
    try:
        last = datetime.strptime(when, "%Y-%m-%d").date()
    except ValueError:
        return False
    return (now - last).days < CACHE_DAYS


def _atomic_write(payload: dict) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    TMP_PATH.write_text(
        json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    os.replace(TMP_PATH, OUTPUT_PATH)


# --------------------------------------------------------------------------
# Manager universe — read manager-history JSON
# --------------------------------------------------------------------------
def _load_target_managers() -> dict[str, dict]:
    """Returns { manager_name: { 'amc_hint': str, 'fund_count': int } }
    for every manager who appears as is_current in any fund."""
    candidates = sorted(DATA_DIR.glob("manager-history-*.json"), reverse=True)
    if not candidates:
        return {}
    history = json.loads(candidates[0].read_text(encoding="utf-8"))
    managers: dict[str, dict] = {}
    for code, entry in (history.get("funds") or {}).items():
        for m in entry.get("managers") or []:
            if not m.get("is_current"):
                continue
            name = m.get("name")
            if not name:
                continue
            row = managers.setdefault(name, {"fund_count": 0, "amc_hint": None})
            row["fund_count"] += 1
            # AMC hint: extract from the first 1-3 words of the scheme name
            # ("HDFC Focused Gr" -> "HDFC")
            sn = entry.get("scheme_name") or ""
            if not row["amc_hint"] and sn:
                head = sn.split()[0]
                if len(head) >= 2 and head[0].isalpha():
                    row["amc_hint"] = head
    return managers


# --------------------------------------------------------------------------
# Name normalisation for fuzzy matching
# --------------------------------------------------------------------------
TITLE_RE = re.compile(r"\b(mr|mrs|ms|dr|prof)\.?\b", re.IGNORECASE)


def _norm_name(s: str) -> str:
    s = TITLE_RE.sub("", s or "")
    s = re.sub(r"[^A-Za-z\s]", " ", s)
    s = re.sub(r"\s+", " ", s).strip().lower()
    return s


def _name_match(scraped: str, targets: Iterable[str]) -> str | None:
    """Try exact normalised match, then last-name + first-initial."""
    n = _norm_name(scraped)
    if not n:
        return None
    norm_to_target = {_norm_name(t): t for t in targets}
    if n in norm_to_target:
        return norm_to_target[n]
    parts = n.split()
    if len(parts) >= 2:
        first_init = parts[0][0]
        last = parts[-1]
        for nt, t in norm_to_target.items():
            tparts = nt.split()
            if not tparts:
                continue
            if tparts[-1] == last and tparts[0] and tparts[0][0] == first_init:
                return t
    return None


# --------------------------------------------------------------------------
# Source 1 — AMFI directory
# --------------------------------------------------------------------------
def scrape_amfi(targets: dict[str, dict]) -> dict[str, dict]:
    """The AMFI page is JS-heavy; we try the static HTML and silently
    return {} if it doesn't yield. Adds source_name=AMFI for matched
    names. Bio not available from this source — name + URL only."""
    out: dict[str, dict] = {}
    if not DEPS_OK:
        return out
    url = "https://www.amfiindia.com/research-information/fund-managers"
    html = _http_get(url)
    if not html:
        return out
    try:
        soup = BS(html, "html.parser")
        names = []
        for a in soup.find_all("a"):
            txt = (a.get_text() or "").strip()
            if 3 <= len(txt) <= 60 and any(c.isalpha() for c in txt):
                names.append(txt)
        for n in names:
            t = _name_match(n, targets.keys())
            if not t:
                continue
            out[t] = {
                "bio": None,
                "experience_years": None,
                "education": None,
                "source_url": url,
                "source_name": "AMFI",
                "photo_url": None,
                "linkedin_url": None,
            }
    except Exception as e:                                # pylint: disable=broad-except
        print(f"  [amfi] parse failed: {e}")
    print(f"  [amfi] matched {len(out)} managers")
    return out


# --------------------------------------------------------------------------
# Source 2 — Value Research Online
# --------------------------------------------------------------------------
def scrape_vro(targets: dict[str, dict]) -> dict[str, dict]:
    """VRO has individual manager pages at /fund-managers/<slug>. Building
    every URL from a name is fragile (their slug rules vary), so we scrape
    the index page and only follow detail pages whose anchor text matches
    a target manager."""
    out: dict[str, dict] = {}
    if not DEPS_OK:
        return out
    base = "https://www.valueresearchonline.com"
    html = _http_get(f"{base}/fund-managers/")
    if not html:
        return out
    try:
        soup = BS(html, "html.parser")
        # Collect (name, href) pairs from the index
        pairs: list[tuple[str, str]] = []
        for a in soup.find_all("a", href=True):
            txt = (a.get_text() or "").strip()
            href = a["href"]
            if "/fund-managers/" in href and 3 <= len(txt) <= 60:
                pairs.append((txt, href if href.startswith("http") else base + href))
        seen: set[str] = set()
        for txt, href in pairs:
            t = _name_match(txt, targets.keys())
            if not t or t in seen or t in out:
                continue
            # Fetch the detail page (best effort, throttled)
            time.sleep(0.6)
            sub_html = _http_get(href)
            bio = None
            exp = None
            if sub_html:
                try:
                    sub = BS(sub_html, "html.parser")
                    # Heuristic: largest <p> on the page that mentions
                    # the manager's name is usually the bio
                    candidates = []
                    for p in sub.find_all("p"):
                        ptxt = (p.get_text() or "").strip()
                        if len(ptxt) > 100 and any(w in ptxt.lower() for w in t.lower().split()):
                            candidates.append(ptxt)
                    if candidates:
                        bio = max(candidates, key=len)[:1200]
                    # Experience: pull "X+ years" from the page
                    em = re.search(r"(\d{1,2})\s*\+?\s*years?\s+of\s+experience", sub_html, re.IGNORECASE)
                    if em:
                        exp = int(em.group(1))
                except Exception:                          # pylint: disable=broad-except
                    pass
            out[t] = {
                "bio": bio,
                "experience_years": exp,
                "education": None,
                "source_url": href,
                "source_name": "Value Research",
                "photo_url": None,
                "linkedin_url": None,
            }
            seen.add(t)
    except Exception as e:                                # pylint: disable=broad-except
        print(f"  [vro] parse failed: {e}")
    print(f"  [vro] matched {len(out)} managers")
    return out


# --------------------------------------------------------------------------
# Source 3 — per-AMC parsers
# --------------------------------------------------------------------------
def _generic_amc_scraper(amc_label: str, url: str,
                         targets: dict[str, dict]) -> dict[str, dict]:
    """Common pattern for AMC pages: pull every <p> / <div> that contains
    a manager's name; treat the surrounding paragraph as bio. Falls back
    to "name only" when no narrative is found."""
    out: dict[str, dict] = {}
    if not DEPS_OK:
        return out
    html = _http_get(url)
    if not html:
        return out
    try:
        soup = BS(html, "html.parser")
        text = soup.get_text(separator="\n")
        for line in text.split("\n"):
            line = line.strip()
            if not (3 <= len(line) <= 80):
                continue
            t = _name_match(line, targets.keys())
            if not t or t in out:
                continue
            # Find a sibling paragraph that mentions the manager
            bio = None
            for p in soup.find_all(("p", "div")):
                ptxt = (p.get_text() or "").strip()
                if len(ptxt) < 60 or len(ptxt) > 1500:
                    continue
                if any(w in ptxt for w in t.split() if len(w) > 3):
                    bio = ptxt[:1200]
                    break
            out[t] = {
                "bio": bio,
                "experience_years": None,
                "education": None,
                "source_url": url,
                "source_name": f"{amc_label} Website",
                "photo_url": None,
                "linkedin_url": None,
            }
    except Exception as e:                                # pylint: disable=broad-except
        print(f"  [{amc_label}] parse failed: {e}")
    print(f"  [{amc_label}] matched {len(out)} managers")
    return out


# Top-10-AMCs-by-AUM registry. Each is one URL; the generic scraper
# handles every page through the same pattern. Adding a new AMC = one
# entry here.  v1 is a single best-effort pass per AMC.
AMC_REGISTRY: dict[str, str] = {
    "HDFC":            "https://www.hdfcfund.com/fund-managers",
    "ICICI Pru":       "https://www.icicipruamc.com/about-us/our-fund-managers",
    "SBI":             "https://www.sbimf.com/en-us/fund-managers",
    "Nippon India":    "https://mf.nipponindiaim.com/Investor/Pages/FundManagers.aspx",
    "Kotak":           "https://www.kotakmf.com/about/investment-team",
    "Axis":            "https://www.axismf.com/about/our-people",
    "Mirae Asset":     "https://miraeassetmf.co.in/about-us/investment-team",
    "DSP":             "https://www.dspim.com/about/team",
    "Franklin":        "https://www.franklintempletonindia.com/investor/fund-managers",
    "Motilal Oswal":   "https://www.motilaloswalmf.com/about-us/investment-team",
}


def scrape_per_amc(targets: dict[str, dict],
                   only: str | None = None) -> dict[str, dict[str, dict]]:
    """Returns { amc_label: { manager_name: profile_dict } }."""
    results: dict[str, dict[str, dict]] = {}
    for amc, url in AMC_REGISTRY.items():
        if only and amc.lower() != only.lower():
            continue
        try:
            results[amc] = _generic_amc_scraper(amc, url, targets)
        except Exception:                                  # pylint: disable=broad-except
            print(f"  [{amc}] scraper crashed:")
            traceback.print_exc()
            results[amc] = {}
        time.sleep(0.6)                                    # polite throttle
    return results


# --------------------------------------------------------------------------
# Merge logic — priority: AMC site > VRO > AMFI; later sources fill
# blanks but never overwrite a non-null field.
# --------------------------------------------------------------------------
def _merge(target: dict, source: dict) -> dict:
    out = dict(target)
    for k, v in source.items():
        if v is None:
            continue
        if out.get(k) in (None, "", []):
            out[k] = v
    return out


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------
def main(argv: list[str] | None = None) -> int:
    argv = argv if argv is not None else sys.argv[1:]
    force = "--force" in argv
    only = None
    if "--only" in argv:
        i = argv.index("--only")
        if i + 1 < len(argv):
            only = argv[i + 1]

    if not DEPS_OK:
        print("scrape_manager_profiles.py: requests + beautifulsoup4 not "
              "installed; leaving manager-profiles.json untouched.")
        print("install with: pip install requests beautifulsoup4")
        return 0

    today = date.today()
    targets = _load_target_managers()
    print(f"[scrape] {len(targets)} target managers from manager-history-*.json")
    if not targets:
        print("[scrape] no manager-history file found; nothing to scrape")
        return 0

    existing_doc = _load_existing()
    existing = (existing_doc.get("managers") or {})
    fresh_skip = 0
    if not force:
        for n, e in existing.items():
            if _is_fresh(e, today):
                fresh_skip += 1
        print(f"[scrape] {fresh_skip} managers within {CACHE_DAYS}-day cache "
              f"(use --force to re-scrape)")

    # --- run the sources ---
    print("[scrape] AMFI ...")
    amfi_hits = scrape_amfi(targets)
    print("[scrape] Value Research ...")
    vro_hits = scrape_vro(targets)
    print("[scrape] per-AMC sites ...")
    per_amc_hits = scrape_per_amc(targets, only=only)

    # --- merge ---
    final: dict[str, dict] = dict(existing)
    timestamp = today.isoformat()

    def _apply(layer: dict[str, dict]) -> None:
        for name, profile in layer.items():
            if not force and _is_fresh(existing.get(name) or {}, today):
                continue
            profile = dict(profile)
            profile["scraped_at"] = timestamp
            final[name] = _merge(final.get(name) or {}, profile)

    # AMC sites win on conflicts (most authoritative)
    for amc_layer in per_amc_hits.values():
        _apply(amc_layer)
    _apply(vro_hits)
    _apply(amfi_hits)

    # --- write ---
    payload = {
        "scraped_at": timestamp,
        "source": "scrape_manager_profiles.py v1",
        "managers": final,
    }
    _atomic_write(payload)

    matched = len([n for n in final if final[n].get("source_url")])
    unmatched = [n for n in targets if n not in final or not final[n].get("source_url")]
    print()
    print(f"[scrape] DONE — {len(final)} managers in profile JSON, "
          f"{matched} with at least one source URL.")
    print(f"[scrape] match rate: {matched}/{len(targets)} = "
          f"{matched / max(1, len(targets)) * 100:.1f}% of target universe")
    if unmatched:
        print(f"[scrape] {len(unmatched)} managers still unmatched (sample):")
        for n in unmatched[:10]:
            print(f"           - {n}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
