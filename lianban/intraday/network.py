"""Source transport and audit-response capture for explicit minute collection."""
from datetime import datetime
import hashlib
from pathlib import Path
from lianban.core.clock import TZ

def fetch_json(url, params, raw_dir, label):
    import requests
    referer = "https://vip.stock.finance.sina.com.cn/" if "sina" in url else "https://quote.eastmoney.com/"
    for attempt in range(2):
        try:
            response = requests.get(url, params=params, timeout=(4, 10), headers={
                "User-Agent": "Mozilla/5.0", "Referer": referer})
            response.raise_for_status()
            break
        except requests.RequestException:
            if attempt:
                raise
    payload = response.json()
    raw_dir = Path(raw_dir)
    raw_dir.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256(response.content).hexdigest()[:12]
    path = raw_dir / f"{label}_{datetime.now(TZ):%Y%m%dT%H%M%S%f}_{digest}.json"
    path.write_bytes(response.content)
    return payload, str(path)
