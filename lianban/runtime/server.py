"""Explicit local-service assembly; creation never starts collection threads."""
from contextlib import closing
from http.server import ThreadingHTTPServer

from lianban.storage import connect, initialize
from lianban.storage.settings import get_settings, set_settings
from lianban.archive.queries import meta
from lianban.config import DEFAULT_DB, AppPaths
from lianban.profiles import industry
from lianban.profiles import concepts as concept_tags
from lianban.profiles import registration
from lianban.profiles import suspension
from lianban.runtime.archive_task import ArchiveRefresher
from lianban.ingestion import live_pool


class DisabledTask:
    """A configured disabled job, without replacing a module's implementation."""
    def maybe_refresh(self, *args, **kwargs):
        pass

    def start(self):
        pass

    def stop(self):
        pass


class ApplicationServer(ThreadingHTTPServer):
    def start_tasks(self):
        if self._tasks_started:
            return
        self._tasks_started = True
        self.industry_refresher.maybe_refresh()
        self.concept_refresher.maybe_refresh()
        self.registration_refresher.maybe_refresh()
        self.after_archive_update()
        self.archive_refresher.start()
        self.live_refresher.start()

    def after_archive_update(self):
        self.registration_refresher.maybe_refresh()
        self.concept_refresher.maybe_refresh()
        with closing(connect(self.db_path)) as conn:
            self.suspension_refresher.maybe_refresh(meta(conn)["latest_date"])

    def stop_tasks(self):
        # Stop producers first, so their completion cannot enqueue profile work.
        for task in (self.archive_refresher, self.live_refresher, self.suspension_refresher,
                     self.industry_refresher, self.registration_refresher, self.concept_refresher):
            task.stop()


def create_server(db_path=DEFAULT_DB, port=8765, *, handler_class, include_concepts=True, no_updates=False):
    with closing(initialize(db_path)) as conn:
        settings = get_settings(conn)
        set_settings(conn, range_start=settings["range_start"], range_end=settings["range_end"])
    from lianban.intraday import store as intraday_store
    with closing(intraday_store.initialize(AppPaths.from_archive(db_path).intraday_db)):
        pass
    server = ApplicationServer(("127.0.0.1", port), handler_class)
    server.db_path = db_path
    server._tasks_started = False
    def task(factory):
        return DisabledTask() if no_updates else factory(db_path)
    server.industry_refresher = task(industry.Refresher)
    server.concept_refresher = task(concept_tags.Refresher) if include_concepts else DisabledTask()
    server.registration_refresher = task(registration.Refresher)
    server.suspension_refresher = task(suspension.Refresher)
    server.archive_refresher = DisabledTask() if no_updates else ArchiveRefresher(db_path, on_update=server.after_archive_update)
    server.live_refresher = task(live_pool.Refresher)
    return server
