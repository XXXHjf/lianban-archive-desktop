"""Compatibility facade. Initialize explicitly at startup; connect only opens SQLite."""
from lianban.config import ROOT, DEFAULT_DB
from lianban.core.clock import TZ, now_iso
from lianban.core.stock import market_for, validated_records, is_st_name
from lianban.storage import connect, initialize, initialize_connection
from lianban.storage.settings import *
from lianban.storage.profiles import *
from lianban.research.tags import *
from lianban.research.notes import *
from lianban.research.blacklist import *
from lianban.research.presentation import stock_initials
from lianban.archive.service import save_day
from lianban.archive.queries import *
from lianban.readside.stock_profiles import enrich_stock_profiles as enrich_industries
