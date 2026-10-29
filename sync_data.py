"""Compatibility command for bounded archive backfill."""
from lianban.ingestion.backfill import archive_calendar, archive_coverage, weekdays, run_backfill
from lianban.interfaces.cli.sync import main

if __name__ == "__main__":
    raise SystemExit(main())
