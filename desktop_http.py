"""JSON transport for the desktop wrapper; application response values stay intact."""
import gzip
import json


def accepts_gzip(value):
    explicit, wildcard = None, 0.0
    for entry in value.split(','):
        coding, *parameters = entry.strip().lower().split(';')
        quality = 1.0
        for parameter in parameters:
            key, separator, weight = parameter.strip().partition('=')
            if key == 'q' and separator:
                try:
                    quality = float(weight)
                    if not 0 <= quality <= 1:
                        quality = 0.0
                except ValueError:
                    quality = 0.0
        if coding == 'gzip':
            explicit = quality
        elif coding == '*':
            wildcard = quality
    return (wildcard if explicit is None else explicit) > 0


class CompressedJSONMixin:
    """Compress substantial JSON responses only when the client permits it."""
    def reply(self, value, status=200):
        raw = json.dumps(value, ensure_ascii=False, allow_nan=False).encode('utf-8')
        compressed = False
        if len(raw) >= 4096 and accepts_gzip(self.headers.get('Accept-Encoding', '')):
            candidate = gzip.compress(raw, compresslevel=1, mtime=0)
            if len(candidate) < len(raw):
                raw, compressed = candidate, True
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(raw)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Vary', 'Accept-Encoding')
        if compressed:
            self.send_header('Content-Encoding', 'gzip')
        self.end_headers()
        self.wfile.write(raw)
