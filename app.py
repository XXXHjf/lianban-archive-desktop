"""Local application entry point and backwards-compatible HTTP facade."""
from pathlib import Path
import argparse
import database as db
from lianban.config import DEFAULT_DB
from lianban.interfaces.http.routes import Handler, read_api, valid_day, WEB, FONT_ASSETS, IMAGE_ASSETS


def create_server(db_path=DEFAULT_DB, port=8765, *, handler_class=Handler, include_concepts=True, no_updates=False):
    from lianban.runtime.server import create_server as build
    return build(db_path, port, handler_class=handler_class, include_concepts=include_concepts, no_updates=no_updates)


def run(db_path=DEFAULT_DB, port=8765, **options):
    server = create_server(db_path, port, **options)
    try:
        server.start_tasks()
        print(f"连板档案已启动：http://127.0.0.1:{server.server_port}", flush=True)
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.stop_tasks()
        server.server_close()


def main(argv=None):
    parser = argparse.ArgumentParser(description="A 股连板历史本地查询")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    args = parser.parse_args(argv)
    run(args.db, args.port)


if __name__ == "__main__":
    main()
