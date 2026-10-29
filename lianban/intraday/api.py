"""Public minute query/storage contract, also used by compatibility entrypoints."""
from .rules import validate_day, session_slot, number, previous_close, validate_points, is_mainboard
from .normalizers import normalize_eastmoney, normalize_tencent
from .store import store_path, connect, initialize, initialize_connection, save_session, save_error, _cached, catalog, auction_view
from .queries import SCOPE, trading_dates, overview, stock_view

EASTMONEY_URL = "https://push2his.eastmoney.com/api/qt/stock/trends2/get"
TENCENT_URL = "https://web.ifzq.gtimg.cn/appstock/app/day/query"
