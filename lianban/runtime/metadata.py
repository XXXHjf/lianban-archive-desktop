"""Lifecycle and freshness policy for independently supplied profile jobs."""
from contextlib import closing
from datetime import datetime, timedelta
import threading
import time
from lianban.core.clock import TZ, now_iso
from lianban.storage import connect
from lianban.storage.settings import get_settings, set_settings

MAX_AGE = timedelta(hours=24)


class MetadataRefresher:
    def __init__(self, path, *, prefix, refresh_callback):
        self.path = path
        self.prefix = prefix
        self.refresh_callback = refresh_callback
        self._lock = threading.Lock()
        self._running = False
        self._retry_after = 0.0
        self._stopped = False
        self._thread = None

    def maybe_refresh(self):
        with self._lock:
            if self._stopped or self._running or time.monotonic() < self._retry_after:
                return
            with closing(connect(self.path)) as conn:
                settings = get_settings(conn)
                last = settings.get(f"{self.prefix}_fetched_at")
                missing_profiles = self.prefix in ("registration", "concept", "shareholder") and conn.execute(
                    "SELECT COUNT(*) FROM stocks").fetchone()[0] > settings.get(f"{self.prefix}_requested", 0)
                max_age = timedelta(hours=1) if self.prefix == "concept" and settings.get("concept_errors", 0) else MAX_AGE
                if last and datetime.now(TZ) - datetime.fromisoformat(last) < max_age and not missing_profiles:
                    return
                self._running = True
                set_settings(conn, **{f"{self.prefix}_status": "updating"})
            self._thread = threading.Thread(target=self._run, name=f"{self.prefix}-refresh", daemon=True)
            self._thread.start()

    def _run(self):
        retry_delay = 0
        try:
            self.refresh_callback(self.path)
        except Exception as exc:
            retry_delay = 15 * 60
            with closing(connect(self.path)) as conn:
                set_settings(conn, **{f"{self.prefix}_status": "error", f"{self.prefix}_error": str(exc),
                                        f"{self.prefix}_attempted_at": now_iso()})
        finally:
            with self._lock:
                self._running = False
                self._retry_after = time.monotonic() + retry_delay


    def stop(self):
        with self._lock:
            self._stopped = True
        if self._thread and self._thread is not threading.current_thread():
            self._thread.join(timeout=1)
