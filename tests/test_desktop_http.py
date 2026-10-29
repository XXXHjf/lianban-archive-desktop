"""Check transport negotiation and the actual bytes received by an HTTP client."""
import gzip
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import threading
import unittest

from desktop_http import CompressedJSONMixin, accepts_gzip


LARGE = {'rows': [{'code': '000678', 'name': '襄阳轴承', 'boards': 5}] * 1000}


class Handler(CompressedJSONMixin, BaseHTTPRequestHandler):
    def do_GET(self):
        self.reply({'message': '已保存'} if self.path == '/small' else LARGE,
                   201 if self.path == '/small' else 200)

    def log_message(self, *args):
        pass


class DesktopHTTPTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        cls.worker = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.worker.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.worker.join(2)

    def request(self, encoding=None, path='/large'):
        conn = http.client.HTTPConnection(*self.server.server_address, timeout=3)
        try:
            conn.request('GET', path, headers={} if encoding is None else {'Accept-Encoding': encoding})
            response = conn.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            conn.close()

    def test_gzip_response_preserves_json_and_declares_actual_wire_length(self):
        status, headers, body = self.request('br, gzip;q=0.8')
        self.assertEqual(status, 200)
        self.assertEqual(headers['Content-Encoding'], 'gzip')
        self.assertEqual(int(headers['Content-Length']), len(body))
        self.assertEqual(headers['Vary'], 'Accept-Encoding')
        self.assertEqual(headers['Cache-Control'], 'no-store')
        self.assertEqual(json.loads(gzip.decompress(body)), LARGE)
        self.assertLess(len(body), len(gzip.decompress(body)) // 10)

    def test_plain_clients_and_explicit_refusals_keep_readable_json(self):
        for encoding in (None, 'identity', 'gzip;q=0', '*;q=1, gzip;q=0'):
            with self.subTest(encoding=encoding):
                status, headers, body = self.request(encoding)
                self.assertEqual(status, 200)
                self.assertNotIn('Content-Encoding', headers)
                self.assertEqual(json.loads(body), LARGE)
                self.assertEqual(int(headers['Content-Length']), len(body))

    def test_small_unicode_responses_keep_status_without_compression(self):
        status, headers, body = self.request('gzip', '/small')
        self.assertEqual(status, 201)
        self.assertNotIn('Content-Encoding', headers)
        self.assertEqual(json.loads(body), {'message': '已保存'})

    def test_quality_negotiation_rejects_invalid_or_disabled_gzip(self):
        for header in ('gzip;q=0', 'gzip;q=nan', 'gzip;q=2', 'gzip;q=invalid', 'br'):
            with self.subTest(header=header):
                self.assertFalse(accepts_gzip(header))
        self.assertTrue(accepts_gzip('*;q=0.5'))
        self.assertTrue(accepts_gzip('GZip; q=0.5'))


if __name__ == '__main__':
    unittest.main()
