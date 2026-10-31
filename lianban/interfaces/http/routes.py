"""Run: python app.py. No third-party package or token is required for the UI."""
from __future__ import annotations

import argparse
import json
import re
from contextlib import closing
from datetime import date, timedelta
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse, unquote

from lianban.storage import connect
from lianban.archive.relationship_queries import stock_pair_comparison
from lianban.storage.settings import get_announcement, get_settings, get_site_links
from lianban.storage.trading_calendar import valid_session
from lianban.research.tags import TagConflictError, get_stock_tags, tag_alias_revision
from lianban.research.notes import NOTE_DATE_UNSET, NoteConflictError, change_stock_note_entry, get_stock_note, save_stock_note
from lianban.research.blacklist import get_blacklist, save_blacklist
from lianban.archive.queries import date_view, meta, search_stocks, stock_view
from lianban.profiles import industry
from lianban.profiles import concepts as concept_tags
from lianban.profiles import registration
from lianban.ingestion import archive_update as live_update
from lianban.ingestion import live_pool
from lianban.profiles import suspension
from lianban.intraday import api as intraday
from lianban.research import tag_management
from lianban.readside import shareholders

from lianban.config import ROOT

WEB = ROOT / "web"
FONT_ASSETS = {"/fonts/NotoSansSC-VF.woff2", "/fonts/OFL.txt", "/fonts/SOURCE.md"}
IMAGE_ASSETS = {"/images/title-companions.jpg"}


def valid_day(value):
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        raise ValueError("日期格式应为 YYYY-MM-DD")
    date.fromisoformat(value)
    return value


def read_api(server, path):
    """Shared query routes for the local demo and the public WSGI service."""
    parsed = urlparse(path)
    args = parse_qs(parsed.query)
    arg = lambda name, default="": args.get(name, [default])[0]
    editable = not getattr(server, "read_only", False)
    if parsed.path == "/api/intraday":
        return intraday.overview(server.db_path, arg("date") or None, include_live=editable)
    if parsed.path == "/api/intraday/stock":
        return intraday.stock_view(server.db_path, valid_day(arg("date")), arg("code"), include_live=editable)
    if parsed.path == "/api/intraday/timeline":
        from lianban.intraday import timeline as intraday_timeline
        exclude_gem = arg("exclude_gem", "1")
        if exclude_gem not in ("0", "1"):
            raise ValueError("创业板屏蔽选项无效")
        return intraday_timeline.timeline(server.db_path, valid_day(arg("date")), int(arg("window", "2")), float(arg("multiple", "3")), exclude_gem=exclude_gem == "1", include_live=editable)
    if parsed.path == "/api/meta" and hasattr(server, "industry_refresher"):
        server.industry_refresher.maybe_refresh()
        server.registration_refresher.maybe_refresh()
        if hasattr(server, "shareholder_refresher"):
            server.shareholder_refresher.maybe_refresh()
        if hasattr(server, "concept_refresher"):
            server.concept_refresher.maybe_refresh()
    with closing(connect(server.db_path)) as conn:
        if parsed.path == '/api/ladder-nodes':
            from lianban.nodes.service import view
            return view(conn, valid_day(arg('date')))
        if parsed.path == "/api/stock-shareholders":
            return shareholders.stock_view(conn, arg("code"), include_live=editable)
        if parsed.path == "/api/announcement":
            return get_announcement(conn)
        if parsed.path == "/api/site-links":
            return get_site_links(conn)
        if parsed.path == "/api/blacklist":
            return get_blacklist(conn)
        if parsed.path == "/api/tags":
            return tag_management.catalog(conn)
        if parsed.path == "/api/tag-stocks":
            return tag_management.members(conn, arg("tag"))
        if parsed.path == "/api/stock-note":
            return get_stock_note(conn, arg("code"))
        metadata = meta(conn)
        editable = not getattr(server, "read_only", False)
        metadata["capabilities"] = {"edit_tags": editable, "edit_blacklist": editable, "edit_notes": editable, "manage_tags": editable}
        metadata["tag_alias_revision"] = tag_alias_revision(conn)
        if parsed.path == "/api/meta":
            metadata["shareholder_alerts"] = shareholders.today_alerts(conn, include_live=editable)
            if editable:
                metadata["live"] = live_pool.metadata(conn)
            catalog = tag_management.catalog(conn)
            metadata["tag_order"] = [tag["name"] for tag in catalog["tags"]]
            metadata["tag_hierarchy"] = catalog["hierarchy"]
            metadata["tag_catalog_revision"] = catalog["revision"]
            if hasattr(server, "suspension_refresher"):
                server.suspension_refresher.maybe_refresh(metadata["latest_date"])
            return metadata
        if parsed.path == "/api/stocks":
            return search_stocks(conn, arg("q")[:100])
        if parsed.path == "/api/stock-tags":
            return get_stock_tags(conn, arg("code"))
        if parsed.path in ("/api/stock", "/api/comparison"):
            code = arg("code")
            if not re.fullmatch(r"[0-9]{6}", code):
                raise ValueError("请输入六位股票代码")
            # Use visible archive bounds; only the explicit latest-day filter
            # may shorten them. Ignore obsolete ranges and the daily query date.
            start = metadata["available_start"] or metadata["range_start"]
            end = metadata["available_end"] or metadata["range_end"]
            exclude_latest = arg("exclude_latest", "0")
            if exclude_latest not in ("0", "1"):
                raise ValueError("最新交易日筛选值应为 0 或 1")
            reference = metadata["trading_calendar"]["latest_trade_date"]
            if exclude_latest == "1" and reference:
                previous_dates = [day for day in metadata["dates"] if day < reference]
                end = previous_dates[-1] if previous_dates else (date.fromisoformat(reference) - timedelta(days=1)).isoformat()
            if parsed.path == "/api/comparison":
                peer = arg("peer")
                if not re.fullmatch(r"[0-9]{6}", peer) or peer == code:
                    raise ValueError("请选择另一只六位代码的股票")
                exclude_st, exclude_gem = arg("exclude_st", "0"), arg("exclude_gem", "0")
                if exclude_st not in ("0", "1") or exclude_gem not in ("0", "1"):
                    raise ValueError("股票筛选值应为 0 或 1")
                return stock_pair_comparison(conn, code, peer, start, end, get_settings(conn),
                                                exclude_st=exclude_st == "1", exclude_gem=exclude_gem == "1")
            result = stock_view(conn, code, start, end)
            result["range_mode"] = "archive"
        elif parsed.path == "/api/date":
            live = live_pool.metadata(conn) if editable else {}
            day = valid_day(arg("date") or metadata["trading_calendar"]["latest_trade_date"] or metadata["latest_date"] or metadata["range_end"])
            if not valid_session(conn, day):
                raise ValueError("该日期休市或交易日历尚未确认，请选择已确认的交易日")
            if hasattr(server, "suspension_refresher"):
                server.suspension_refresher.maybe_refresh(day)
            minimum = int(arg("min_boards", "1"))
            if not 1 <= minimum <= 100:
                raise ValueError("连板筛选值应为 1 至 100")
            exclude_st = arg("exclude_st", "0")
            if exclude_st not in ("0", "1"):
                raise ValueError("ST 筛选值应为 0 或 1")
            exclude_gem = arg("exclude_gem", "0")
            if exclude_gem not in ("0", "1"):
                raise ValueError("创业板筛选值应为 0 或 1")
            selected = arg("boards")
            boards = None
            if selected:
                if not re.fullmatch(r"[0-9]+", selected) or not 1 <= int(selected) <= 100:
                    raise ValueError("连板数应为 1 至 100 的整数")
                boards = int(selected)
            result = date_view(conn, day, minimum, arg("market", "all"), arg("q")[:100],
                                  exclude_st == "1", boards, exclude_gem=exclude_gem == "1",
                                  snapshot=live_pool.snapshot(conn, day) if editable else None)
            if editable and day in live.get("dates", []):
                result["live"] = live
                if not result["provisional"] and result["data_status"] != "ok":
                    result["coverage_note"] = "当天盘中数据尚未取得，每分钟自动重试；空返回不代表没有涨停。"
        else:
            return None
        return result


def module_asset(path):
    """Serve only real ES modules below the dedicated web module directory."""
    decoded = unquote(path)
    if not decoded.startswith("/modules/") or "\\" in decoded or "\x00" in decoded:
        return False
    base = (WEB / "modules").resolve()
    target = (WEB / decoded.lstrip("/")).resolve()
    return target.is_relative_to(base) and target.suffix == ".mjs" and target.is_file()


def built_asset(path):
    """Serve bundled frontend assets without exposing source or other files."""
    decoded = unquote(path)
    if not decoded.startswith("/assets/") or "\\" in decoded or "\x00" in decoded:
        return False
    base = (WEB / "assets").resolve()
    target = (WEB / decoded.lstrip("/")).resolve()
    return target.is_relative_to(base) and target.suffix in {".js", ".css", ".woff2"} and target.is_file()


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, ".woff2": "font/woff2", ".mjs": "text/javascript", ".js": "text/javascript", ".css": "text/css"}

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WEB), **kwargs)

    def end_headers(self):
        if urlparse(self.path).path in FONT_ASSETS and urlparse(self.path).path.endswith(".woff2"):
            self.send_header("Cache-Control", "private, max-age=86400")
        elif not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def reply(self, value, status=200):
        raw = json.dumps(value, ensure_ascii=False, allow_nan=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        parsed = urlparse(self.path)
        if not parsed.path.startswith("/api/"):
            if parsed.path in ("/", "/index.html", "/styles.css", "/app.js", "/favicon.ico") or parsed.path in FONT_ASSETS | IMAGE_ASSETS or module_asset(parsed.path) or built_asset(parsed.path):
                return super().do_GET()
            return self.reply({"error": "页面不存在"}, 404)
        try:
            result = read_api(self.server, self.path)
            return self.reply(result if result is not None else {"error": "接口不存在"},
                              200 if result is not None else 404)
        except (ValueError, OverflowError) as exc:
            return self.reply({"error": str(exc)}, 400)
        except Exception:
            # Keep internal paths and stack traces in the local console.
            import traceback
            traceback.print_exc()
            return self.reply({"error": "读取数据失败，请查看本地服务日志。"}, 500)

    def do_POST(self):
        path = urlparse(self.path).path
        if path not in ("/api/ladder-nodes", "/api/ladder-nodes/identify", "/api/stock-tags", "/api/blacklist", "/api/stock-note", "/api/tag-rename", "/api/tag-stocks", "/api/tag-delete", "/api/tag-node", "/api/intraday/collect", "/api/intraday/timeline/times"):
            return self.reply({"error": "接口不存在"}, 404)
        if getattr(self.server, "read_only", False):
            return self.reply({"error": "公开版本仅供查询"}, 403)
        subject = "分时" if path in ("/api/intraday/collect", "/api/intraday/timeline/times") else "黑名单" if path == "/api/blacklist" else "备注" if path == "/api/stock-note" else "标签"
        if self.headers.get("Content-Type", "").split(";", 1)[0].strip() != "application/json":
            return self.reply({"error": f"请使用 JSON 提交{subject}"}, 415)
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length < 1 or length > (65536 if path == "/api/stock-note" else 16384):
                return self.reply({"error": f"{subject}内容大小无效"}, 413)
            data = json.loads(self.rfile.read(length))
            if not isinstance(data, dict):
                raise ValueError(f"{subject}内容格式无效")
            if path == '/api/ladder-nodes/identify':
                from lianban.nodes.collection import sync_day
                return self.reply(sync_day(self.server.db_path, valid_day(data.get('date'))))
            if path == "/api/intraday/collect":
                from lianban.intraday import collection as intraday_sources
                return self.reply(intraday_sources.collect_requested(self.server.db_path, valid_day(data.get("date", "")), data.get("code", ""), force=data.get("force") is True))
            if path == "/api/intraday/timeline/times":
                from lianban.intraday import timeline as intraday_timeline
                return self.reply(intraday_timeline.collect_seal_times(self.server.db_path, valid_day(data.get("date", "")), force=data.get("force") is True))
            with closing(connect(self.server.db_path)) as conn:
                if path == '/api/ladder-nodes':
                    from lianban.nodes import service as nodes
                    if data.get('action') == 'create':
                        result = nodes.create(conn, data.get('date'), data.get('boards'), data.get('name'))
                    elif data.get('action') == 'remove':
                        result = nodes.remove(conn, data.get('id'), data.get('date'), data.get('code'))
                    else:
                        raise ValueError('节点操作无效')
                elif path == "/api/blacklist":
                    result = save_blacklist(conn, data.get("code"), data.get("action"))
                elif path == "/api/stock-note":
                    if data.get("action", "save") == "save":
                        result = save_stock_note(conn, data.get("code"), data.get("content"), data.get("revision"),
                                                    entry_id=data.get("entry_id"), occurred_at=data.get("occurred_at"),
                                                    new_entry=data.get("new_entry", False), note_date=data.get("note_date", NOTE_DATE_UNSET))
                    else:
                        result = change_stock_note_entry(conn, data.get("code"), data.get("entry_id"), data.get("revision"), data.get("action"))
                elif path == "/api/tag-node":
                    result = tag_management.save_node(conn, data.get("name"), data.get("parent"), data.get("revision"), data.get("action", "create"))
                elif path == "/api/tag-rename":
                    result = tag_management.rename(conn, data.get("source"), data.get("target"), data.get("revision"), data.get("merge", False))
                elif path == "/api/tag-stocks":
                    if "codes" in data:
                        if data.get("action", "add") != "add":
                            raise ValueError("批量操作仅支持添加股票")
                        result = tag_management.add_stocks(conn, data.get("tag"), data.get("codes"), data.get("revision"))
                    else:
                        result = tag_management.change_stock(conn, data.get("tag"), data.get("code"), data.get("revision"), data.get("action", "add"))
                elif path == "/api/tag-delete":
                    result = tag_management.delete_tag(conn, data.get("tag"), data.get("revision"), data.get("confirm", False))
                else:
                    result = tag_management.save_stock_tag_paths(conn, data.get("code"), data.get("tags"),
                                                data.get("revision"), data.get("use_source", False), data.get("tag_alias_revision"))
            return self.reply(result)
        except (TagConflictError, NoteConflictError) as exc:
            return self.reply({"error": str(exc)}, 409)
        except (ValueError, UnicodeError) as exc:
            return self.reply({"error": str(exc)}, 400)
        except Exception:
            import traceback
            traceback.print_exc()
            return self.reply({"error": f"{subject}保存失败，请稍后重试。"}, 500)
