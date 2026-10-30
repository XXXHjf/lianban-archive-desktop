from pathlib import Path
import gzip
import hashlib
import json
import sqlite3
import unittest
from uuid import uuid4
import setup_shared

ROOT=Path(__file__).resolve().parents[1]

class DistributionTests(unittest.TestCase):
    def test_runtime_modules_and_every_ui_asset_match_maintained_build(self):
        baseline=json.loads((ROOT/'BUILD_BASELINE.json').read_text(encoding='utf-8'))
        self.assertEqual(set(baseline['identity_sha256']), setup_shared.runtime_files(ROOT))
        self.assertIn('lianban/storage/connection.py',baseline['identity_sha256'])
        self.assertIn('web/app.js',baseline['identity_sha256'])
        self.assertTrue(any(name.startswith('web/assets/') and name.endswith('.js') for name in baseline['identity_sha256']))
        self.assertFalse(any(name.startswith('web/modules/') for name in baseline['identity_sha256']))
        for name,digest in baseline['identity_sha256'].items():
            self.assertEqual(hashlib.sha256((ROOT/name).read_bytes()).hexdigest(),digest,name)

    def test_upstream_provenance_is_preserved(self):
        self.assertEqual(setup_shared.sha256(ROOT/'SOURCE_BASELINE.json'),
                         'e0c72f68c79c666dcacdf7fa0b4c5096b4ad2ada53de1bef51d0aa9e06e60272')

    def test_initial_database_has_no_personal_records_or_source_payloads(self):
        raw=gzip.decompress((ROOT/'resources/archive-seed.sqlite3.gz').read_bytes())
        conn=sqlite3.connect(':memory:')
        try:
            conn.deserialize(raw)
            self.assertEqual(conn.execute('PRAGMA integrity_check').fetchone()[0],'ok')
            for table in ('stock_tag_overrides','stock_blacklist','stock_notes'):
                self.assertEqual(conn.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0],0)
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM events WHERE limit_up_reason IS NOT NULL').fetchone()[0],0)
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM days WHERE raw_path IS NOT NULL').fetchone()[0],0)
            self.assertGreater(conn.execute('SELECT COUNT(*) FROM events').fetchone()[0],100000)
        finally:
            conn.close()
        for marker in ('C:\\Users\\107108','codex-模型搜索'):
            self.assertNotIn(marker.encode('utf-8'),raw)

    def test_wheel_paths_cannot_escape_runtime(self):
        destination=ROOT/'.runtime/test-python/Lib/site-packages'
        for name in ('../file','/absolute','pkg/../../file','C:/file','pkg\\file'):
            with self.assertRaises(ValueError): setup_shared.wheel_target(name,destination)
        self.assertEqual(setup_shared.wheel_target('package/module.py',destination),destination/'package/module.py')
        self.assertEqual(setup_shared.wheel_target('xlrd.data/scripts/runxlrd.py',destination),destination.parents[1]/'Scripts/runxlrd.py')

    def test_bundle_integrity(self):
        bundle=setup_shared.verify()
        self.assertIn('certs/geotrust-g2-cn-2022-ca1.crt',bundle['sha256'])

    def test_verifier_rejects_tampering_and_omitted_new_modules(self):
        root=ROOT/'.build'/('integrity-'+uuid4().hex)
        (root/'web/modules').mkdir(parents=True)
        (root/'app.py').write_text('pass\n',encoding='utf-8')
        (root/'web/modules/main.mjs').write_text('export const value=1;\n',encoding='utf-8')
        (root/'SOURCE_BASELINE.json').write_text('{}\n',encoding='utf-8')
        baseline={'upstream':{'manifest':'SOURCE_BASELINE.json','sha256':setup_shared.sha256(root/'SOURCE_BASELINE.json')},
                  'identity_sha256':{name:setup_shared.sha256(root/name) for name in setup_shared.runtime_files(root)}}
        (root/'BUILD_BASELINE.json').write_text(json.dumps(baseline),encoding='utf-8')
        files=set(baseline['identity_sha256']) | {'SOURCE_BASELINE.json','BUILD_BASELINE.json'}
        (root/'BUNDLE.json').write_text(json.dumps({'sha256':{name:setup_shared.sha256(root/name) for name in files}}),encoding='utf-8')
        setup_shared.verify(root)
        (root/'app.py').write_text('raise RuntimeError()\n',encoding='utf-8')
        with self.assertRaisesRegex(ValueError,'Missing or changed'):
            setup_shared.verify(root)
        (root/'app.py').write_text('pass\n',encoding='utf-8')
        (root/'web/modules/omitted.mjs').write_text('export {};\n',encoding='utf-8')
        with self.assertRaisesRegex(ValueError,'inventory'):
            setup_shared.verify(root)

if __name__=='__main__': unittest.main()
