"""Current controllers for display only; never derives shareholder relationships."""
import re


SOURCE = "东方财富 · 公司资料（控股股东及实际控制人）"


def stock_view(conn, code):
    if not isinstance(code, str) or not re.fullmatch(r"[0-9]{6}", code):
        raise ValueError("请输入六位股票代码")
    profile = conn.execute("SELECT source,fetched_at FROM stock_control_profiles WHERE code=?", (code,)).fetchone()
    rows = [dict(row) for row in conn.execute(
        "SELECT kind,holder_name,holder_type,via_name,source_url FROM stock_control_owners "
        "WHERE code=? AND kind IN ('controller','actual_controller') "
        "ORDER BY CASE kind WHEN 'controller' THEN 0 ELSE 1 END,holder_name", (code,))]
    return {"code": code, "source": profile["source"] if profile else SOURCE,
            "fetched_at": profile["fetched_at"] if profile else None,
            "status": "current" if profile else "empty", "rows": rows}
