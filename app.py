"""Run: python app.py. No third-party package or token is required for the UI."""
from __future__ import annotations

import argparse
import json
import re
from contextlib import closing
from datetime import date, timedelta
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import database as db
import industry
import registration
import live_update
import suspension

WEB = Path(__file__).resolve().parent / "web"
FONT_ASSETS = {"/fonts/NotoSansSC-VF.woff2", "/fonts/OFL.txt", "/fonts/SOURCE.md"}
IMAGE_ASSETS = {"/images/title-companions.jpg"}


def valid_day(value):
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        raise ValueError("日期格式应为 YYYY-MM-DD")
    date.fromisoformat(value)
    return value


def read_api(server, path):
    """Shared query routes for the local demo and the public WSGI service."""
    parsed = urlparse(path)
    args = parse_qs(parsed.query)
    arg = lambda name, default="": args.get(name, [default])[0]
    if parsed.path == "/api/meta" and hasattr(server, "industry_refresher"):
        server.industry_refresher.maybe_refresh()
        server.registration_refresher.maybe_refresh()
    with closing(db.connect(server.db_path)) as conn:
        if parsed.path == "/api/announcement":
            return db.get_announcement(conn)
        if parsed.path == "/api/site-links":
            return db.get_site_links(conn)
        if parsed.path == "/api/blacklist":
            return db.get_blacklist(conn)
        if parsed.path == "/api/stock-note":
            return db.get_stock_note(conn, arg("code"))
        metadata = db.meta(conn)
        editable = not getattr(server, "read_only", False)
        metadata["capabilities"] = {"edit_tags": editable, "edit_blacklist": editable, "edit_notes": editable}
        if parsed.path == "/api/meta":
            if hasattr(server, "suspension_refresher"):
                server.suspension_refresher.maybe_refresh(metadata["latest_date"])
            return metadata
        if parsed.path == "/api/stocks":
            return db.search_stocks(conn, arg("q")[:100])
        if parsed.path == "/api/stock-tags":
            return db.get_stock_tags(conn, arg("code"))
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
            if exclude_latest == "1" and metadata["latest_date"]:
                previous_dates = [day for day in metadata["dates"] if day < metadata["latest_date"]]
                end = previous_dates[-1] if previous_dates else (date.fromisoformat(metadata["latest_date"]) - timedelta(days=1)).isoformat()
            if parsed.path == "/api/comparison":
                peer = arg("peer")
                if not re.fullmatch(r"[0-9]{6}", peer) or peer == code:
                    raise ValueError("请选择另一只六位代码的股票")
                exclude_st, exclude_gem = arg("exclude_st", "0"), arg("exclude_gem", "0")
                if exclude_st not in ("0", "1") or exclude_gem not in ("0", "1"):
                    raise ValueError("股票筛选值应为 0 或 1")
                return db.stock_pair_comparison(conn, code, peer, start, end, db.get_settings(conn),
                                                exclude_st=exclude_st == "1", exclude_gem=exclude_gem == "1")
            result = db.stock_view(conn, code, start, end)
            result["range_mode"] = "archive"
        elif parsed.path == "/api/date":
            day = valid_day(arg("date", metadata["latest_date"] or metadata["range_end"]))
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
            result = db.date_view(conn, day, minimum, arg("market", "all"), arg("q")[:100],
                                  exclude_st == "1", boards, exclude_gem=exclude_gem == "1")
        else:
            return None
        return result


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, ".woff2": "font/woff2"}

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
            if parsed.path in ("/", "/index.html", "/styles.css", "/app.js", "/favicon.ico") or parsed.path in FONT_ASSETS | IMAGE_ASSETS:
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
        if path not in ("/api/stock-tags", "/api/blacklist", "/api/stock-note"):
            return self.reply({"error": "接口不存在"}, 404)
        if getattr(self.server, "read_only", False):
            return self.reply({"error": "公开版本仅供查询"}, 403)
        subject = "黑名单" if path == "/api/blacklist" else "备注" if path == "/api/stock-note" else "标签"
        if self.headers.get("Content-Type", "").split(";", 1)[0].strip() != "application/json":
            return self.reply({"error": f"请使用 JSON 提交{subject}"}, 415)
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length < 1 or length > (65536 if path == "/api/stock-note" else 16384):
                return self.reply({"error": f"{subject}内容大小无效"}, 413)
            data = json.loads(self.rfile.read(length))
            if not isinstance(data, dict):
                raise ValueError(f"{subject}内容格式无效")
            with closing(db.connect(self.server.db_path)) as conn:
                if path == "/api/blacklist":
                    result = db.save_blacklist(conn, data.get("code"), data.get("action"))
                elif path == "/api/stock-note":
                    result = db.save_stock_note(conn, data.get("code"), data.get("content"), data.get("revision"))
                else:
                    result = db.save_stock_tags(conn, data.get("code"), data.get("tags"),
                                                data.get("revision"), data.get("use_source", False))
            return self.reply(result)
        except (db.TagConflictError, db.NoteConflictError) as exc:
            return self.reply({"error": str(exc)}, 409)
        except (ValueError, UnicodeError) as exc:
            return self.reply({"error": str(exc)}, 400)
        except Exception:
            import traceback
            traceback.print_exc()
            return self.reply({"error": f"{subject}保存失败，请稍后重试。"}, 500)


def main():
    parser = argparse.ArgumentParser(description="A 股连板历史本地查询")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--db", type=Path, default=db.DEFAULT_DB)
    args = parser.parse_args()
    with closing(db.connect(args.db)) as conn:
        db.set_settings(conn, range_start=db.get_settings(conn)["range_start"], range_end=db.get_settings(conn)["range_end"])
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    server.db_path = args.db
    server.industry_refresher = industry.Refresher(args.db)
    server.registration_refresher = registration.Refresher(args.db)
    server.suspension_refresher = suspension.Refresher(args.db)
    server.industry_refresher.maybe_refresh()
    server.registration_refresher.maybe_refresh()
    def after_archive_update():
        server.registration_refresher.maybe_refresh()
        with closing(db.connect(args.db)) as conn:
            server.suspension_refresher.maybe_refresh(db.meta(conn)["latest_date"])
    after_archive_update()
    server.archive_refresher = live_update.Refresher(args.db, on_update=after_archive_update)
    server.archive_refresher.start()
    print(f"连板档案已启动：http://127.0.0.1:{args.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.archive_refresher.stop()
        server.suspension_refresher.stop()
        server.server_close()


if __name__ == "__main__":
    main()
