"""Public shareholder source and disclosure semantics."""
import re
import unicodedata

SOURCE = "东方财富 · 十大股东及十大流通股东"
URL = "https://datacenter.eastmoney.com/securities/api/data/v1/get"
REPORTS = {"total": "RPT_DMSK_HOLDERS", "float": "RPT_F10_EH_FREEHOLDERS"}
SCOPE_NOTE = "按本地已收录股票各自最新披露的十大股东及十大流通股东全名匹配，不代表实时持仓或历史当日持仓；同名个人不保证为同一人，结算及代持账户不代表同一最终投资者。"
BATCH_SIZE = 100


def exclusion_reason(name):
    """Conservative name-based exclusions, independent of provider categories.

    These describe low-specificity relationships, not beneficial-owner identity.
    Keep ordinary institutions/private funds even when they own many stocks.
    """
    normalized = unicodedata.normalize("NFKC", name).replace(" ", "").casefold()
    if normalized in {
        "香港中央结算有限公司", "香港中央结算(代理人)有限公司",
        "香港中央結算有限公司", "香港中央結算(代理人)有限公司",
    }:
        return "结算代持账户"
    if re.search(r"(?:客户资金|客户交易结算资金|客户信用交易担保证券账户)$", normalized):
        return "客户汇总账户"
    if "基金" in normalized and ("指数" in normalized or "etf" in normalized):
        return "指数基金/ETF"
    return None
