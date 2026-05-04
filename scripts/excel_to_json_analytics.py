"""
Analytics-source Excel-to-JSON converter.

TODO: v1.x — see CLAUDE.md §4.1.

Source files (folder per month-end):
    EQUITY MF.xlsx
    HYBRID FUNDS.xlsx
    Debt MF.xlsx

Output:
    data/analytics-YYYY-MM-DD.json   (date = the month-end the folder represents)

Validates against:
    data-contract/analytics-v1.json  (also TODO)

Cadence-pairing rule (locked, CLAUDE.md §4.1):
    For a Screener cycle date C, this converter is run against the most recent
    Analytics folder with folder-date <= C. Folder lookup logic lives here, not
    in the Action.

Architectural rules (locked, CLAUDE.md §4.1):
    - Output keyed by AMFI scheme code (primary key across all four sources).
    - Independent failure mode: a malformed Analytics push must never block a
      valid Screener deploy. Schema-check rejects only the Analytics JSON.
    - No pandas dependency; openpyxl-only, matching the Screener converter.

Until this script is implemented, the dashboard renders Analytics-sourced fields
as "—" with a "Holdings data integration pending — coming in v1.1" placeholder
on Fund Detail. See ISSUE-0003 in Skills/mf-dashboard-build/ISSUES_LOG.md.
"""


def main():
    raise NotImplementedError(
        "Analytics converter is a v1.x stub. See CLAUDE.md §4.1 for the build "
        "spec. Do not run in production until implemented."
    )


if __name__ == "__main__":
    main()
