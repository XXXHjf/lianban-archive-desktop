import re
import unicodedata
from functools import lru_cache
from pypinyin import Style, lazy_pinyin

@lru_cache(maxsize=20000)
def stock_initials(name):
    letters = "".join(lazy_pinyin(unicodedata.normalize("NFKC", name), style=Style.FIRST_LETTER))
    return re.sub(r"[^A-Z0-9]", "", letters.upper())
