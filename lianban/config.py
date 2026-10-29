"""Application paths, passed to services without changing the on-disk layout."""
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DB = ROOT / "data" / "archive.sqlite3"


@dataclass(frozen=True)
class AppPaths:
    root: Path = ROOT
    archive_db: Path | None = None

    def __post_init__(self):
        root = Path(self.root).resolve()
        object.__setattr__(self, "root", root)
        object.__setattr__(self, "archive_db", Path(self.archive_db).resolve()
                           if self.archive_db is not None else root / "data" / "archive.sqlite3")

    @classmethod
    def from_archive(cls, archive_path):
        return cls(archive_db=archive_path)

    @property
    def data_dir(self):
        return self.archive_db.parent

    @property
    def intraday_db(self):
        return self.data_dir / "intraday.sqlite3"

    @property
    def raw_dir(self):
        return self.data_dir / "raw"

    @property
    def intraday_raw_dir(self):
        return self.data_dir / "intraday_raw"

    @property
    def web_dir(self):
        return self.root / "web"

    @property
    def resources_dir(self):
        return self.root / "resources"
