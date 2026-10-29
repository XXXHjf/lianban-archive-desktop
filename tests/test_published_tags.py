from contextlib import closing
import json
from pathlib import Path
import sqlite3
import uuid
import unittest

import database as db
import published_tags
import tag_management


class PublishedTagsTests(unittest.TestCase):
    def setUp(self):
        directory = Path(__file__).resolve().parents[1] / '.build' / ('published-tag-test-' + uuid.uuid4().hex)
        directory.mkdir(parents=True)
        self.path = directory / 'archive.sqlite3'
        self.bundle = {'id':'release-one','stocks':[{'code':'000001','name':'测试股票','market':'深市主板',
                       'last_seen':'2026-10-28','tags':['发布标签','子标签']}],
                       'hierarchy':[{'name':'发布标签','parent':''},{'name':'子标签','parent':'发布标签'}]}

    def test_fresh_labels_match_and_no_notes_or_blacklist_are_imported(self):
        published_tags.apply(self.path,self.bundle)
        with closing(db.initialize(self.path)) as conn:
            self.assertEqual(db.get_stock_tags(conn,'000001')['tags'],['发布标签','子标签'])
            self.assertEqual(db.get_stock_note(conn,'000001')['content'],'')
            self.assertEqual(db.get_blacklist(conn)['total'],0)
            self.assertEqual(tag_management.hierarchy(conn),sorted(self.bundle['hierarchy'],key=lambda n:n['name']))

    def test_old_custom_labels_notes_blacklist_remain_and_union_is_deduplicated(self):
        with closing(db.initialize(self.path)) as conn, conn:
            conn.execute('INSERT INTO stocks VALUES (?,?,?,?)',('000001','测试股票','深市主板','2026-10-27'))
            conn.execute('INSERT INTO stock_tag_overrides VALUES (?,?,?,?)',('000001','["自己的标签","发布标签"]',3,'before'))
            conn.execute('INSERT INTO stock_notes VALUES (?,?,?,?)',('000001','我的私人备注',2,'2026-10-27T12:00:00+08:00'))
            conn.execute('INSERT INTO stock_blacklist VALUES (?,?)',('000001','before'))
        published_tags.apply(self.path,self.bundle)
        with closing(db.initialize(self.path)) as conn:
            self.assertEqual(db.get_stock_tags(conn,'000001')['tags'],['自己的标签','发布标签','子标签'])
            self.assertEqual(db.get_stock_note(conn,'000001')['content'],'我的私人备注')
            self.assertEqual(db.get_blacklist(conn)['total'],1)
            self.assertEqual(conn.execute('SELECT revision FROM stock_tag_overrides').fetchone()[0],3)

    def test_second_start_does_not_reset_user_edits(self):
        published_tags.apply(self.path,self.bundle)
        with closing(db.initialize(self.path)) as conn:
            current=db.get_stock_tags(conn,'000001')
            db.save_stock_tags(conn,'000001',['自己的标签'],current['revision'])
        self.assertFalse(published_tags.apply(self.path,self.bundle))
        with closing(db.initialize(self.path)) as conn:
            self.assertEqual(db.get_stock_tags(conn,'000001')['tags'],['自己的标签'])

    def test_new_release_adds_defaults_without_changing_personal_note_history(self):
        published_tags.apply(self.path,self.bundle)
        with closing(db.initialize(self.path)) as conn:
            db.save_stock_note(conn,'000001','独立备注',0,new_entry=True)
            before=[tuple(row) for row in conn.execute('SELECT * FROM stock_note_entries')]
            db.save_stock_tags(conn,'000001',['发布标签','子标签','个人'],0)
        self.bundle['id']='release-two';self.bundle['stocks'][0]['tags'].append('新版标签')
        published_tags.apply(self.path,self.bundle)
        with closing(db.initialize(self.path)) as conn:
            self.assertIn('个人',db.get_stock_tags(conn,'000001')['tags'])
            self.assertIn('新版标签',db.get_stock_tags(conn,'000001')['tags'])
            self.assertEqual([tuple(row) for row in conn.execute('SELECT * FROM stock_note_entries')],before)

    def test_existing_parent_wins_and_merge_does_not_create_cycle(self):
        with closing(db.initialize(self.path)) as conn, conn:
            conn.executemany('INSERT INTO tag_nodes VALUES (?,?,?)',[('发布标签','发布标签','子标签'),('子标签','子标签',None)])
        published_tags.apply(self.path,self.bundle)
        with closing(db.initialize(self.path)) as conn:
            nodes=tag_management.hierarchy(conn)
            tag_management._validate_hierarchy(nodes)
            self.assertEqual(next(node['parent'] for node in nodes if node['name']=='发布标签'),'子标签')

    def test_published_file_has_only_allowlisted_public_fields(self):
        bundle=json.loads((Path(published_tags.__file__).parent/'resources/published-tags.json').read_text(encoding='utf-8'))
        self.assertEqual(set(bundle),{'id','source_commit','stocks','hierarchy'})
        for stock in bundle['stocks']:
            self.assertEqual(set(stock),{'code','name','market','last_seen','tags'})
        for node in bundle['hierarchy']:
            self.assertEqual(set(node),{'name','parent'})

    def test_mainboard_catalog_is_seeded_without_replacing_existing_cache(self):
        import intraday
        self.assertTrue(published_tags.initialize_catalog(self.path))
        with closing(intraday.initialize(intraday.store_path(self.path))) as conn, conn:
            count=conn.execute('SELECT COUNT(*) FROM universe').fetchone()[0]
            self.assertGreater(count,3000)
            conn.execute("UPDATE universe SET name='用户已有更新' WHERE code=(SELECT MIN(code) FROM universe)")
        self.assertFalse(published_tags.initialize_catalog(self.path))
        with closing(intraday.initialize(intraday.store_path(self.path))) as conn:
            self.assertEqual(conn.execute('SELECT name FROM universe ORDER BY code LIMIT 1').fetchone()[0],'用户已有更新')


if __name__=='__main__':
    unittest.main()
