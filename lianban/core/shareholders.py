"""Public shareholder source and disclosure semantics."""
SOURCE = "东方财富 · 十大股东及十大流通股东"
URL = "https://datacenter.eastmoney.com/securities/api/data/v1/get"
REPORTS = {"total": "RPT_DMSK_HOLDERS", "float": "RPT_F10_EH_FREEHOLDERS"}
SCOPE_NOTE = "按本地已收录股票各自最新披露的十大股东及十大流通股东全名匹配，不代表实时持仓或历史当日持仓；同名个人不保证为同一人，结算及代持账户不代表同一最终投资者。"
BATCH_SIZE = 100
