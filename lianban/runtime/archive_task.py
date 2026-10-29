"""Lifecycle of the wall-clock scheduled closing archive collector."""
from contextlib import closing
from datetime import datetime
import threading

from lianban.core.clock import TZ, now_iso, CLOSE_READY
from lianban.storage import connect
from lianban.storage.settings import set_settings
from lianban.runtime.schedule import next_check_at
from lianban.ingestion.archive_update import CHECK_SECONDS, refresh


class ArchiveRefresher:
    def __init__(self, path, on_update=None):
        self.path = path
        self.on_update = on_update
        self._stop = threading.Event()
        self._thread = None

    def start(self):
        if self._thread and self._thread.is_alive():
            return
        self._thread = threading.Thread(target=self._run, name="archive-auto-update", daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()
        if self._thread and self._thread is not threading.current_thread():
            self._thread.join(timeout=1)

    def _run(self):
        while not self._stop.is_set():
            try:
                refresh(self.path, stop=self._stop)
                if self.on_update and not self._stop.is_set():
                    self.on_update()
            except Exception as exc:
                # Network, calendar and validation failures keep confirmed facts.
                with closing(connect(self.path)) as conn:
                    set_settings(conn, auto_update_status="error", auto_update_error=str(exc),
                                    auto_update_checked_at=now_iso(), auto_update_interval=CHECK_SECONDS,
                                    auto_update_time=CLOSE_READY.strftime("%H:%M"), auto_update_timezone="Asia/Shanghai")
            next_at = next_check_at()
            with closing(connect(self.path)) as conn:
                set_settings(conn, auto_update_next_at=next_at.isoformat(timespec="seconds"))
            self._stop.wait(max(0, (next_at - datetime.now(TZ)).total_seconds()))
