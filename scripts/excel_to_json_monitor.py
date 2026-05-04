"""
Monitor-source Excel-to-JSON converter.

TODO: v1.x — see CLAUDE.md §4.1.

Source file:
    Daily_MF_monitor_DD_Month_YYYY.xlsx   (as-on-date, typically aligned to a
                                            Screener cycle date but not always)

Output:
    data/monitor-YYYY-MM-DD.json

Validates against:
    data-contract/monitor-v1.json   (also TODO)

Cadence-pairing rule (locked, CLAUDE.md §4.1):
    For a Screener cycle date C, this converter is run against the Monitor file
    dated exactly C if available; otherwise the most recent Monitor file with
    date <= C.

Architectural rules (locked, CLAUDE.md §4.1):
    - Output keyed by AMFI scheme code (primary key across all four sources).
    - Independent failure mode: a malformed Monitor push must never block a
      valid Screener deploy. Schema-check rejects only the Monitor JSON.
    - No pandas dependency; openpyxl-only, matching the Screener converter.

Once implemented, this enriches the Screener JSON's `return_*` fields with the
Monitor file's point-to-point trailing returns (Monitor's view of the same
windows is the official "as-on-date" reading).
"""


def main():
    raise NotImplementedError(
        "Monitor converter is a v1.x stub. See CLAUDE.md §4.1 for the build "
        "spec. Do not run in production until implemented."
    )


if __name__ == "__main__":
    main()
