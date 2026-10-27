"""Launch the unchanged local application with per-copy lifecycle management."""
from pathlib import Path
import argparse
import hashlib
import hmac
import io
import json
import os
import secrets
import sys
import threading
from urllib.parse import urlsplit
from http.server import SimpleHTTPRequestHandler
from update_notices import NoticeService

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
PROJECT_KEY = hashlib.sha256(str(ROOT).casefold().encode('utf-8')).hexdigest()

def serve(port, no_updates=False):
    import app
    import realtime
    realtime.initialize(ROOT/'data/archive.sqlite3')
    realtime.install(app)
    session_file = ROOT/'data/desktop-session.json'
    session = {'pid': os.getpid(), 'port': port, 'project_key': PROJECT_KEY,
               'instance_id': secrets.token_hex(16), 'token': secrets.token_hex(32), 'state': 'starting'}
    session_file.write_text(json.dumps(session), encoding='utf-8')
    original_handler = app.Handler
    version = json.loads((ROOT/'VERSION.json').read_text(encoding='utf-8'))['version']
    notices = NoticeService(version, ROOT/'data/update-notice-cache.json')
    notices.refresh()

    class DesktopHandler(original_handler):
        def send_head(self):
            path = urlsplit(self.path).path
            if path in ('/', '/index.html', '/updates.js', '/updates.css', '/realtime.js'):
                filename = 'index.html' if path in ('/', '/index.html') else path[1:]
                raw = (ROOT/'web'/filename).read_bytes()
                if filename == 'index.html':
                    extension = ('<link rel="stylesheet" href="/updates.css?v=' + version + '">'
                                 '<script src="/updates.js?v=' + version + '" defer></script>'
                                 '<script src="/realtime.js?v=' + version + '" defer></script>')
                    raw = raw.replace(b'</head>', extension.encode('utf-8') + b'</head>', 1)
                content_type = {'index.html':'text/html', 'updates.js':'text/javascript',
                                'updates.css':'text/css', 'realtime.js':'text/javascript'}[filename]
                self.send_response(200)
                self.send_header('Content-Type', content_type + '; charset=utf-8')
                self.send_header('Content-Length', str(len(raw)))
                self.end_headers()
                return io.BytesIO(raw)
            return super().send_head()

        def do_GET(self):
            parsed = urlsplit(self.path)
            if parsed.path == '/__desktop__/updates':
                return self.reply(notices.snapshot(force=parsed.query == 'check=1'))
            if parsed.path == '/__desktop__/status':
                return self.reply({k:v for k,v in session.items() if k!='token'})
            if parsed.path in ('/updates.js', '/updates.css', '/realtime.js'):
                return SimpleHTTPRequestHandler.do_GET(self)
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
        minute_worker = realtime.Refresher(ROOT/'data/archive.sqlite3')
        if not no_updates:
            minute_worker.start()
        app.main()
    finally:
        minute_worker.stop()
        session['state'] = 'stopped'
        session_file.write_text(json.dumps(session), encoding='utf-8')

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['serve'])
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--no-updates', action='store_true', help='Offline acceptance testing only')
    options = parser.parse_args()
    serve(options.port, options.no_updates)
