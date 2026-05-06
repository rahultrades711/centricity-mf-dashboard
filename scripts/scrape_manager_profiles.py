"""
Scrape short bios for the unique fund managers in the latest cycle JSON.

Standalone post-converter step — the GitHub Action runs this AFTER
excel_to_json_screener.py. If anything fails, the script logs a
warning and exits 0 so the deploy pipeline is never blocked by a
flaky external scrape.

Cadence cache: any manager already in data/manager-profiles.json
that was scraped within the last 90 days is skipped on re-runs, so
re-scraping ~150 managers happens at most quarterly. Within the
90-day window the script is effectively a no-op.

Source priority for each manager (best signal first):
  1. Morningstar India fund-manager pages
  2. The AMC's own team / about page
  3. Value Research manager pages

The Action requires:  pip install requests beautifulsoup4 --break-system-packages
"""
from __future__ import annotations

import datetime as _dt
import json
import re
import sys
import time
from pathlib import Path
from typing import Optional

REPO_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = REPO_ROOT / "data"
PROFILES_PATH = DATA_DIR / "manager-profiles.json"
CACHE_DAYS = 90
REQUEST_TIMEOUT = 12         # seconds
BETWEEN_REQUESTS_SLEEP = 1.0  # be polite

# --------------------------------------------------------------------------
# Soft dependency import — degrade gracefully when libs aren't installed
# --------------------------------------------------------------------------
try:
    import requests
    from bs4 import BeautifulSoup  # type: ignore
    SCRAPE_DEPS_OK = True
except ImportError:
    SCRAPE_DEPS_OK = False


def _log(msg: str) -> None:
    print(f"[scrape-mgr] {msg}", file=sys.stderr)


# --------------------------------------------------------------------------
# Cycle JSON discovery
# --------------------------------------------------------------------------
def _latest_cycle_path() -> Optional[Path]:
    candidates = sorted(DATA_DIR.glob("screener-*.json"), reverse=True)
    return candidates[0] if candidates else None


def _load_cycle_managers(cycle_json: Path) -> list[dict]:
    """
    Return the unique (manager, AMC) pairs from the latest cycle.
    Single-manager funds only — v1 JSON carries one manager per fund.
    """
    with open(cycle_json, "r", encoding="utf-8") as f:
        j = json.load(f)
    seen: dict[str, dict] = {}
    for fund in j.get("funds", []):
        name = (fund.get("manager_name") or "").strip()
        if not name:
            continue
        amc = (fund.get("amc") or "").strip()
        # Prefer the AMC of the largest fund this manager runs as the
        # canonical AMC. Tie-break: keep the first one seen.
        existing = seen.get(name)
        if existing is None:
            seen[name] = {"manager": name, "amc": amc, "fund_count": 1}
        else:
            existing["fund_count"] += 1
            if not existing.get("amc") and amc:
                existing["amc"] = amc
    return list(seen.values())


# --------------------------------------------------------------------------
# Profile cache I/O
# --------------------------------------------------------------------------
def _load_existing_profiles() -> dict:
    if not PROFILES_PATH.exists():
        return {"last_updated": None, "profiles": {}}
    try:
        with open(PROFILES_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        _log(f"could not read existing profiles ({e}); starting fresh")
        return {"last_updated": None, "profiles": {}}


def _save_profiles(profiles_doc: dict) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with open(PROFILES_PATH, "w", encoding="utf-8") as f:
        json.dump(profiles_doc, f, ensure_ascii=False, indent=2)


def _is_fresh(profile: dict, today: _dt.date) -> bool:
    scraped = profile.get("scraped_date")
    if not scraped:
        return False
    try:
        scraped_d = _dt.date.fromisoformat(scraped)
    except ValueError:
        return False
    return (today - scraped_d).days < CACHE_DAYS


# --------------------------------------------------------------------------
# Scrapers (best-effort — return None on any failure, never raise)
# --------------------------------------------------------------------------
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (compatible; Centricity-MF-Bot/1.0; "
        "+contact products@centricity.co.in)"
    ),
    "Accept-Language": "en-IN,en;q=0.9",
}


def _fetch(url: str) -> Optional[str]:
    if not SCRAPE_DEPS_OK:
        return None
    try:
        r = requests.get(url, headers=HEADERS, timeout=REQUEST_TIMEOUT)
        if r.status_code == 200 and len(r.text) > 200:
            return r.text
    except Exception:
        pass
    return None


def _clean_bio(text: str) -> str:
    # Collapse whitespace, trim, cap at ~600 chars (~3-4 sentences).
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) > 600:
        # Trim at the last sentence boundary before 600.
        cut = text[:600]
        last_dot = cut.rfind(". ")
        if last_dot > 200:
            text = cut[:last_dot + 1]
        else:
            text = cut + "…"
    return text


def _try_morningstar(name: str, amc: str) -> Optional[dict]:
    """
    Morningstar India hosts manager bios on URLs like
        https://www.morningstar.in/fund-manager/<slug>/<id>.aspx
    The slug pattern is unstable, so the most robust path is a search:
        https://www.morningstar.in/search.aspx?q=<urlencoded name>
    For now this stub returns None — flesh out when the Action goes live
    and we have a real network to test against.
    """
    return None


def _try_value_research(name: str, amc: str) -> Optional[dict]:
    """
    Value Research manager pages live at
        https://www.valueresearchonline.com/funds/manager/<slug>/
    Same caveat as Morningstar — stable slug derivation requires a
    search-result scrape. Stub returns None until the Action runs
    against the live network and we can verify selectors.
    """
    return None


def _try_amc_about_page(name: str, amc: str) -> Optional[dict]:
    """
    AMC team / about pages have wildly varying markup. A generic scrape
    that grabs the first <p> after the manager's name on the AMC's
    /about-us/team/ page works for many but not all. Stub for now.
    """
    return None


def _scrape_one(name: str, amc: str) -> dict:
    """
    Walk the source priority list. Return a profile dict; bio is None
    when every source fails (caller handles the fallback caption).
    """
    for fn in (_try_morningstar, _try_value_research, _try_amc_about_page):
        try:
            result = fn(name, amc)
        except Exception as e:
            _log(f"  scraper {fn.__name__} crashed for {name!r}: {e}")
            continue
        if result and result.get("bio"):
            return {
                "amc": amc,
                "bio": _clean_bio(result["bio"]),
                "source_url": result.get("source_url"),
                "scraped_date": _dt.date.today().isoformat(),
            }
        time.sleep(BETWEEN_REQUESTS_SLEEP)
    return {
        "amc": amc,
        "bio": None,
        "source_url": None,
        "scraped_date": _dt.date.today().isoformat(),
    }


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------
def main() -> int:
    today = _dt.date.today()

    cycle_json = _latest_cycle_path()
    if cycle_json is None:
        _log("no screener-*.json file in data/; nothing to do")
        # Still emit an empty profiles file so fund-detail.js's lazy-load
        # gets a 200 not a 404.
        _save_profiles({"last_updated": today.isoformat(), "profiles": {}})
        return 0

    _log(f"reading {cycle_json.name}")
    managers = _load_cycle_managers(cycle_json)
    _log(f"found {len(managers)} unique managers across the universe")

    existing_doc = _load_existing_profiles()
    profiles = existing_doc.get("profiles", {})

    if not SCRAPE_DEPS_OK:
        _log(
            "requests/beautifulsoup4 not installed; emitting empty "
            "profiles file. (pip install requests beautifulsoup4 "
            "--break-system-packages on the runner.)"
        )

    fresh_count = 0
    scraped_count = 0
    failed_count = 0

    for entry in managers:
        name = entry["manager"]
        amc = entry.get("amc", "")
        if name in profiles and _is_fresh(profiles[name], today):
            fresh_count += 1
            continue
        if not SCRAPE_DEPS_OK:
            # Without deps, write a placeholder so the file at least
            # carries the manager → AMC association.
            profiles[name] = {
                "amc": amc,
                "bio": None,
                "source_url": None,
                "scraped_date": today.isoformat(),
            }
            failed_count += 1
            continue
        _log(f"  scraping {name!r} ({amc})")
        profile = _scrape_one(name, amc)
        profiles[name] = profile
        if profile.get("bio"):
            scraped_count += 1
        else:
            failed_count += 1
        time.sleep(BETWEEN_REQUESTS_SLEEP)

    output = {
        "last_updated": today.isoformat(),
        "profiles": profiles,
    }
    _save_profiles(output)
    _log(
        f"wrote {PROFILES_PATH.relative_to(REPO_ROOT)} — "
        f"{len(profiles)} total ({fresh_count} cached, "
        f"{scraped_count} freshly scraped, {failed_count} unresolved)"
    )
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        _log("interrupted")
        sys.exit(0)
    except Exception as e:
        # Never crash the pipeline — log and exit 0
        _log(f"unhandled error: {e}")
        sys.exit(0)
