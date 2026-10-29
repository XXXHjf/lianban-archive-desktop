"""Compatibility exports; implementations live in the application package."""
from lianban.profiles.shareholders import SOURCE, URL, REPORTS, SCOPE_NOTE, BATCH_SIZE, normalize_rows, fetch_batch, refresh, Refresher
from lianban.storage.shareholders import save_batch
from lianban.readside.shareholders import today_limit_ups, today_alerts, stock_view

if __name__ == "__main__":
    print(f"Updated {refresh()} shareholder profiles.")
