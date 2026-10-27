"""Minute pool isolation, offline query overlays, route policy and close handoff."""
from contextlib import closing
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4
import unittest

import app
import database as db
import provider
import realtime


class Clock(datetime):
    @classmethod
    def now(cls, tz=None):
        value = cls.fromisoformat("2026-10-27T10:00:00+08:00")
        return value.astimezone(tz) if tz else value.replace(tzinfo=None)


class RealtimeTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(__file__).parent/'test-data'/('realtime-'+uuid4().hex)
        self.root.mkdir(parents=True)
        self.path = self.root/'archive.sqlite3'
        self.clock = patch.object(realtime, 'datetime', Clock)
        self.clock.start(); self.addCleanup(self.clock.stop)
        self.now, self.day = Clock.now(db.TZ), '2026-10-27'
        self.row = {'date':self.day,'code':'600001','name':'测试股份','market':'沪市主板','boards':2,'close':11,'pct_change':10}
        realtime.initialize(self.path)
        with closing(db.connect(self.path)) as conn:
            db.set_settings(conn, range_start='2026-10-26',range_end='2026-10-26',calendar_dates=['2026-10-26'])
            db.save_day(conn,'2026-10-26',[{**self.row,'date':'2026-10-26','boards':1}],provider.SOURCE)
        original = app.read_api
        self.addCleanup(setattr, app, 'read_api', original)
        realtime.install(app)

    def save(self, rows=None):
        with closing(db.connect(self.path)) as conn:
            return realtime.save_pool(conn,self.day,[self.row] if rows is None else rows,provider.CLS_SOURCE,now=self.now)

    def test_snapshot_and_temp_views_do_not_change_history_or_personal_edits(self):
        with closing(db.connect(self.path)) as conn:
            db.save_stock_tags(conn,'600001',['私有标签'],0)
            db.save_stock_note(conn,'600001','保留备注',0)
            before = db.meta(conn)
        self.save()
        server = SimpleNamespace(db_path=self.path)
        with patch('requests.get',side_effect=AssertionError('GET must remain offline')):
            date = app.read_api(server,'/api/date?date='+self.day)
            self.assertEqual(date['data_status'],'provisional')
            self.assertEqual(date['rows'][0]['boards'],2)
            self.assertIn('私有标签',date['rows'][0]['tags'])
            self.assertEqual(app.read_api(server,'/api/stock?code=600001')['stats']['limit_days'],1)
        with closing(db.connect(self.path)) as conn:
            self.assertEqual(db.meta(conn)['coverage'],before['coverage'])
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM events').fetchone()[0],1)
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM days').fetchone()[0],1)
            self.assertEqual(db.get_stock_note(conn,'600001')['content'],'保留备注')

    def test_full_replacement_removes_opened_stocks_and_keeps_filters(self):
        self.save()
        self.save([{**self.row,'code':'600002','boards':1},{**self.row,'code':'600003','boards':2,'name':'ST测试'}])
        result=app.read_api(SimpleNamespace(db_path=self.path),'/api/date?date='+self.day+'&exclude_st=1&boards=1')
        self.assertEqual([r['code'] for r in result['rows']],['600002'])
        self.assertEqual(result['stats']['total'],1)

    def test_wrong_dates_duplicates_and_empty_do_not_replace_success(self):
        self.save()
        for rows in [[self.row,self.row],[{**self.row,'date':'2026-10-26'}],[{**self.row,'boards':True}]]:
            with self.assertRaises(ValueError):self.save(rows)
        self.assertFalse(self.save([]))
        with closing(db.connect(self.path)) as conn:
            self.assertEqual(len(realtime.snapshot(conn,self.day)['records']),1)
            self.assertNotIn('limit_up_reason',realtime.snapshot(conn,self.day)['records'][0])

    def test_public_queries_can_read_pool_without_acquiring_write_capabilities(self):
        self.save()
        public=SimpleNamespace(db_path=self.path,read_only=True,realtime=True)
        meta=app.read_api(public,'/api/meta')
        self.assertEqual(meta['latest_date'],'2026-10-26')
        self.assertEqual(meta['live']['date'],self.day)
        self.assertFalse(meta['capabilities']['edit_tags'])
        self.assertTrue(app.read_api(public,'/api/date?date='+self.day)['provisional'])
        self.assertNotIn('live',app.read_api(SimpleNamespace(db_path=self.path,read_only=True),'/api/meta'))

    def test_minute_poll_calendar_cache_negative_retry_and_source_failure(self):
        with patch.object(provider,'trading_dates',return_value=(['2026-10-26'],'calendar')) as calendar, patch.object(realtime,'fetch_pool') as fetch:
            realtime.refresh(self.path,now=self.now)
            fetch.assert_not_called()
        with patch.object(provider,'trading_dates',return_value=([self.day],'calendar')) as calendar, patch.object(realtime,'fetch_pool',return_value=([self.row],provider.CLS_SOURCE)):
            realtime.refresh(self.path,now=self.now)
            calendar.assert_called_once()
        with patch.object(provider,'trading_dates') as calendar, patch.object(realtime,'fetch_pool',side_effect=RuntimeError('offline')):
            realtime.refresh(self.path,now=self.now)
            calendar.assert_not_called()
        with closing(db.connect(self.path)) as conn:
            self.assertEqual(realtime.metadata(conn)['status'],'error')
            self.assertEqual(realtime.metadata(conn)['count'],1)

    def test_server_closing_handoff_adds_only_new_confirmed_day(self):
        self.save()
        after=Clock.fromisoformat('2026-10-27T15:30:00+08:00')
        result=provider.DayResult(self.day,[{**self.row,'boards':3}],'ok','confirmed','test.json',provider.CLS_SOURCE)
        with patch.object(provider,'trading_dates',return_value=([self.day],'calendar')),patch.object(provider,'fetch_day',return_value=result) as fetch:
            realtime.refresh(self.path,now=after,close_archive=True)
            realtime.refresh(self.path,now=after,close_archive=True)
            fetch.assert_called_once()
        with closing(db.connect(self.path)) as conn:
            self.assertIsNone(realtime.snapshot(conn,self.day))
            self.assertEqual(db.meta(conn)['latest_date'],self.day)
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM events').fetchone()[0],2)
        self.assertEqual(app.read_api(SimpleNamespace(db_path=self.path),'/api/date?date='+self.day)['rows'][0]['boards'],3)


if __name__=='__main__': unittest.main()
