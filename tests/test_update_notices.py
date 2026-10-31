from pathlib import Path
from io import BytesIO
from threading import Event
from unittest.mock import patch
from uuid import uuid4
import json
import unittest
from update_notices import (CHECK_INTERVAL, FAILURE_INTERVAL, MANUAL_INTERVAL,
                            FEED_URL, FALLBACK_FEED_URL, NoticeService,
                            fetch_notice, normalize_notice, version_key)


def release(version='2026.10.21', **changes):
    return {'version': version, 'title': '新版本', 'notes': '更新说明',
            'published_at': '2026-10-21T08:00:00Z', **changes}


class UpdateNoticeTests(unittest.TestCase):
    def responses(self, *values):
        return [value if isinstance(value, Exception) else
                BytesIO(value if isinstance(value, bytes) else json.dumps(value).encode('utf-8'))
                for value in values]

    def service(self, fetcher=lambda: release(), version='2026.10.20.1'):
        self.now = [1000.0]
        self.path = Path(__file__).parent/'test-data'/('updates-' + uuid4().hex)/'cache.json'
        return NoticeService(version, self.path, fetcher, clock=lambda: self.now[0])

    def finish(self, service):
        service.worker.join(2)
        self.assertFalse(service.worker.is_alive())

    def test_versions_do_not_offer_older_equal_or_textually_smaller_releases(self):
        self.assertLess(version_key('2026.10.20'), version_key('2026.10.20.1'))
        self.assertLess(version_key('2026.10.20.2'), version_key('2026.10.20.10'))
        for value in ('2026.10.20', '2026.10.20.1', '2026.10.19.100'):
            service = self.service(lambda: release(value))
            service.refresh()
            self.finish(service)
            self.assertIsNone(service.snapshot()['notice'])

    def test_remote_links_are_not_trusted_and_plain_text_is_preserved(self):
        value = normalize_notice(release(url='javascript:alert(1)', notes='<img src=x onerror=alert(1)>'))
        self.assertEqual(value['url'], 'https://github.com/x107108/lianban-archive-desktop/releases/tag/v2026.10.21')
        self.assertEqual(value['notes'], '<img src=x onerror=alert(1)>')
        for bad in (None, [], release('../x'), release('2026.02.30'), release('2026.10.21-rc1'),
                    release(title=''), release(notes='x'*5001), release(published_at='2026-10-21')):
            with self.subTest(bad=bad), self.assertRaises((ValueError, TypeError)):
                normalize_notice(bad)

    def test_background_check_deduplicates_concurrent_requests_and_does_not_block(self):
        started, allowed = Event(), Event()
        calls = []
        def fetch():
            calls.append(True)
            started.set()
            allowed.wait(2)
            return release()
        service = self.service(fetch)
        first = service.snapshot()
        self.assertTrue(started.wait(1))
        self.assertTrue(first['checking'])
        for _ in range(10):
            self.assertTrue(service.snapshot(force=True)['checking'])
        allowed.set()
        self.finish(service)
        self.assertEqual(len(calls), 1)
        self.assertEqual(service.snapshot()['notice']['version'], '2026.10.21')

    def test_offline_failure_keeps_last_good_notice_and_retries_after_backoff(self):
        calls = []
        def fetch():
            calls.append(True)
            if len(calls) > 1:
                raise OSError('offline')
            return release()
        service = self.service(fetch)
        service.refresh()
        self.finish(service)
        self.now[0] += 3601
        service.refresh()
        self.finish(service)
        state = service.snapshot()
        self.assertTrue(state['unavailable'])
        self.assertEqual(state['notice']['version'], '2026.10.21')
        service.refresh()
        self.assertEqual(len(calls), 2)
        self.now[0] += 901
        service.refresh()
        self.finish(service)
        self.assertEqual(len(calls), 3)

    def test_cache_survives_restart_and_manual_checks_are_throttled(self):
        calls = []
        def fetch():
            calls.append(True)
            return release()
        service = self.service(fetch)
        service.refresh()
        self.finish(service)
        restarted = NoticeService(service.current_version, self.path, fetch, clock=lambda: self.now[0])
        self.assertEqual(restarted.checked_at, 1000.0)
        self.assertIsNone(restarted.last_attempt)
        self.assertEqual(restarted.snapshot()['notice']['id'], 'release:2026.10.21')
        self.finish(restarted)
        self.assertEqual(len(calls), 2)
        restarted.refresh(force=True)
        self.assertEqual(len(calls), 2)
        self.now[0] += 31
        restarted.refresh(force=True)
        self.finish(restarted)
        self.assertEqual(len(calls), 3)

    def test_both_public_sources_are_checked_and_newer_version_wins(self):
        for raw_version, api_version in [('2026.10.21', '2026.10.21.10'),
                                         ('2026.10.21.10', '2026.10.21.2')]:
            with self.subTest(raw=raw_version, api=api_version):
                with patch('update_notices.urllib.request.urlopen',
                           side_effect=self.responses(release(raw_version), release(api_version))) as opened:
                    with patch('update_notices.time.time', return_value=1234):
                        notice = fetch_notice()
                self.assertEqual(notice['version'], '2026.10.21.10')
                self.assertEqual(opened.call_count, 2)
                for call, url in zip(opened.call_args_list, (FEED_URL, FALLBACK_FEED_URL)):
                    request = call.args[0]
                    separator = '&' if '?' in url else '?'
                    self.assertEqual(request.full_url, url + separator + 'check=1234')
                    headers = {key.lower(): value for key, value in request.header_items()}
                    self.assertEqual(headers['cache-control'], 'no-cache')
                    self.assertEqual(headers['accept'], 'application/vnd.github.raw+json')
                    self.assertNotIn('authorization', headers)
                    self.assertEqual(call.kwargs['timeout'], 5)

    def test_one_failed_or_invalid_source_does_not_hide_the_valid_notice(self):
        for invalid in (OSError('offline'), b'not-json', release(title=''), b'x' * 65537):
            for failed_index in (0, 1):
                with self.subTest(invalid=type(invalid).__name__, failed_index=failed_index):
                    values = [release(), release()]
                    values[failed_index] = invalid
                    with patch('update_notices.urllib.request.urlopen',
                               side_effect=self.responses(*values)) as opened:
                        self.assertEqual(fetch_notice()['version'], '2026.10.21')
                    self.assertEqual(opened.call_count, 2)

    def test_both_failed_sources_preserve_good_cached_notice_and_timestamp(self):
        service = self.service()
        service.refresh()
        self.finish(service)
        saved_cache = self.path.read_bytes()
        self.now[0] += CHECK_INTERVAL
        service.fetcher = fetch_notice
        with patch('update_notices.urllib.request.urlopen',
                   side_effect=self.responses(OSError('offline'), release(title=''))) as opened:
            service.refresh()
            self.finish(service)
        self.assertEqual(opened.call_count, 2)
        state = service.snapshot()
        self.assertTrue(state['unavailable'])
        self.assertEqual(state['checked_at'], 1000.0)
        self.assertEqual(state['notice']['version'], '2026.10.21')
        self.assertEqual(self.path.read_bytes(), saved_cache)

    def test_polling_intervals_remain_unchanged(self):
        self.assertEqual((CHECK_INTERVAL, FAILURE_INTERVAL, MANUAL_INTERVAL), (3600, 900, 30))
        for force, failed, interval in ((False, False, 3600), (False, True, 900),
                                        (True, False, 30)):
            with self.subTest(force=force, failed=failed):
                calls = []
                service = self.service(lambda: calls.append(True) or release())
                service.refresh()
                self.finish(service)
                service.error = failed
                self.now[0] += interval - 1
                service.refresh(force=force)
                self.assertEqual(len(calls), 1)
                self.now[0] += 1
                service.refresh(force=force)
                self.finish(service)
                self.assertEqual(len(calls), 2)

    def test_corrupt_or_future_cache_is_not_shown(self):
        for payload in ('broken', json.dumps({'notice': release(), 'checked_at': 9999999})):
            service = self.service()
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self.path.write_text(payload)
            restarted = NoticeService(service.current_version, self.path, clock=lambda: self.now[0])
            self.assertIsNone(restarted.notice)
            self.assertIsNone(restarted.checked_at)


if __name__ == '__main__':
    unittest.main()
