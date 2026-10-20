"""Read-only announcement display and unpublished-draft isolation."""
from contextlib import closing
from types import SimpleNamespace
from unittest.mock import patch
import unittest

import app
import database as db


class AnnouncementTests(unittest.TestCase):
    def test_empty_disabled_and_malformed_notices_return_no_content(self):
        with closing(db.connect(":memory:")) as conn:
            self.assertEqual(db.get_announcement(conn)["announcement"],
                             {"title":"", "content":"", "enabled":False, "revision":0, "updated_at":None})
            for notice in (None, [], {"enabled":False,"title":"private draft","content":"draft"},
                           {"enabled":True,"content":"  "}, {"enabled":True,"content":["invalid"]}):
                with self.subTest(notice=notice):
                    db.set_settings(conn, site_announcement=notice)
                    result=db.get_announcement(conn)["announcement"]
                    self.assertFalse(result["enabled"])
                    self.assertEqual((result["title"],result["content"]),("",""))
            conn.execute("UPDATE settings SET value='invalid-json' WHERE key='site_announcement'")
            self.assertFalse(db.get_announcement(conn)["announcement"]["enabled"])

    def test_published_notice_is_plain_text_and_only_display_fields_are_returned(self):
        with closing(db.connect(":memory:")) as conn:
            notice={"enabled":True,"title":"测试公告", "content":"第一行\n<script>text only</script>",
                    "revision":3, "updated_at":"2026-10-18T23:55:00+08:00", "editor_token":"private"}
            db.set_settings(conn, site_announcement=notice)
            result=db.get_announcement(conn)["announcement"]
            self.assertEqual(result["content"],notice["content"])
            self.assertEqual(result["revision"],3)
            self.assertNotIn("editor_token",result)
            self.assertEqual(db.get_settings(conn)["site_announcement"],notice,"reading cannot rewrite the saved notice")

    def test_public_route_reads_notice_without_other_metadata_or_updates(self):
        with closing(db.connect(":memory:")) as conn:
            db.set_settings(conn,site_announcement={"enabled":True,"title":"标题","content":"公告正文"})
            # read_api closes its connection; return an isolated copy.
            connect=db.connect
            def connect_copy(_):
                copied=connect(":memory:");conn.backup(copied);return copied
            with patch.object(app.db,"connect",side_effect=connect_copy), patch.object(app.db,"meta",side_effect=AssertionError("unneeded metadata")):
                result=app.read_api(SimpleNamespace(db_path=":memory:",read_only=True),"/api/announcement")
            self.assertEqual(result["announcement"]["content"],"公告正文")


if __name__=="__main__":
    unittest.main()
