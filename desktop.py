"""Launch the unchanged local application with per-copy lifecycle management."""
from pathlib import Path
import argparse
import hashlib
import hmac
import json
import os
import secrets
import sys
import threading
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
PROJECT_KEY = hashlib.sha256(str(ROOT).casefold().encode('utf-8')).hexdigest()

def serve(port, no_updates=False):
    import app
    session_file = ROOT/'data/desktop-session.json'
    session = {'pid': os.getpid(), 'port': port, 'project_key': PROJECT_KEY,
               'instance_id': secrets.token_hex(16), 'token': secrets.token_hex(32), 'state': 'starting'}
    session_file.write_text(json.dumps(session), encoding='utf-8')
    original_handler = app.Handler

    class DesktopHandler(original_handler):
        def do_GET(self):
            if urlsplit(self.path).path == '/__desktop__/status':
                return self.reply({k:v for k,v in session.items() if k!='token'})
            return super().do_GET()

        def do_POST(self):
            if urlsplit(self.path).path == '/__desktop__/shutdown':
                supplied = self.headers.get('X-Desktop-Token', '')
                if not hmac.compare_digest(supplied, session['token']):
                    return self.reply({'error':'Invalid launcher token'}, 403)
                self.reply({'stopping':True})
                threading.Thread(target=self.server.shutdown, daemon=True).start()
                return
            return super().do_POST()

    app.Handler = DesktopHandler
    if no_updates:
        class OfflineRefresher:
            def __init__(self, *args, **kwargs): pass
            def maybe_refresh(self, *args, **kwargs): pass
            def start(self): pass
            def stop(self): pass
        app.industry.Refresher = OfflineRefresher
        app.registration.Refresher = OfflineRefresher
        app.suspension.Refresher = OfflineRefresher
        app.live_update.Refresher = OfflineRefresher
    sys.argv = [str(ROOT/'app.py'), '--port', str(port), '--db', str(ROOT/'data/archive.sqlite3')]
    session['state'] = 'running'
    session_file.write_text(json.dumps(session), encoding='utf-8')
    try:
        app.main()
    finally:
        session['state'] = 'stopped'
        session_file.write_text(json.dumps(session), encoding='utf-8')

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['serve'])
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--no-updates', action='store_true', help='Offline acceptance testing only')
    options = parser.parse_args()
    serve(options.port, options.no_updates)
