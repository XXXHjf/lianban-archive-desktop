"""Observed horizontal comparison runs and complete point-in-time cohorts."""
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from lianban.interfaces.http import routes as app
import database as db


class ComparisonTests(unittest.TestCase):
    def setUp(self):
        self.conn = db.initialize(":memory:")
        self.days = ["2026-10-09", "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16"]
        db.set_settings(self.conn, calendar_dates=self.days, range_start=self.days[0], range_end=self.days[-1])

    def tearDown(self):
        self.conn.close()

    def save(self, day, target=None, peer=None, others=(), status="ok"):
        rows = [{"code":code,"name":name,"boards":height} for code,name,height in others]
        if target is not None:
            rows.append({"code":"600668","name":"目标股","boards":target})
        if peer is not None:
            rows.append({"code":"000530","name":"对比股","boards":peer})
        db.save_day(self.conn, day, rows, "synthetic", status=status)

    def comparison(self, start=None, end=None, **filters):
        return db.stock_pair_comparison(self.conn, "600668", "000530", start or self.days[0], end or self.days[-1], db.get_settings(self.conn), **filters)

    def test_two_days_against_four_retains_both_full_runs_and_groups_shared_dates(self):
        for day,t,p in zip(self.days[2:], [None,None,1,2], [1,2,3,4]):
            self.save(day,t,p)
        segment, = self.comparison()["segments"]
        self.assertEqual((segment["start"],segment["end"]), ("2026-10-13","2026-10-16"))
        self.assertEqual([row["boards"] for row in segment["target_dates"]], [1,2])
        self.assertEqual([row["boards"] for row in segment["peer_dates"]], [1,2,3,4])
        self.assertEqual(segment["common_dates"], ["2026-10-15","2026-10-16"])
        self.assertEqual(len(self.comparison(end="2026-10-15")["segments"][0]["peer_dates"]),3)

    def test_missing_trading_day_and_height_reset_split_runs_without_invented_nodes(self):
        self.save(self.days[0],1,1)
        self.save(self.days[1],2,2)
        self.save(self.days[2],status="failed")
        self.save(self.days[3],4,4)
        self.save(self.days[4],1,1)
        self.save(self.days[5],2,2)
        result = self.comparison()["segments"]
        self.assertEqual([len(s["target_dates"]) for s in result], [2,1,2])
        self.assertEqual(result[-1]["end"],self.days[1],"weekend may join consecutive trading days")
        self.assertEqual(result[1]["target_dates"], [{"date":self.days[3],"boards":4}])

    def test_seven_observations_make_seven_nodes_and_partial_start_stays_observed(self):
        extra = ["2026-10-19", "2026-10-20"]
        db.set_settings(self.conn,calendar_dates=self.days+extra)
        for i,day in enumerate(self.days[1:]+extra,1):
            self.save(day,1 if i==7 else None,i)
        segment, = self.comparison(end=extra[-1])["segments"]
        self.assertEqual(len(segment["peer_dates"]),7)
        self.assertEqual(len(segment["target_dates"]),1)
        self.assertEqual(segment["peer_dates"][-1]["boards"],7)

    def test_disjoint_cycles_and_unknown_peer_have_no_comparison(self):
        self.save(self.days[0],1,None)
        self.save(self.days[1],None,1)
        self.assertEqual(self.comparison()["segments"],[])

    def test_leader_uses_intersecting_run_extended_both_directions_within_cutoff(self):
        for index, day in enumerate(self.days):
            others = [("600003", "完整周期股", index + 1)]
            if index == 2:
                others.append(("600004", "区间内五板", 5))
            if index == 0:
                others.append(("600005", "区间外高板", 99))
            self.save(day, index - 1 if index in (2, 3) else None,
                      index - 1 if index in (2, 3) else None, others)
        before = [tuple(row) for row in self.conn.execute("SELECT * FROM events ORDER BY date,code")]
        segment, = self.comparison(start=self.days[2])["segments"]
        self.assertEqual((segment["start"], segment["end"]), (self.days[2], self.days[3]))
        leader = segment["leader"]
        self.assertEqual((leader["code"], leader["max_boards"]), ("600003", 6))
        self.assertEqual((leader["start"], leader["end"]), (self.days[0], self.days[-1]))
        self.assertEqual([row["boards"] for row in leader["dates"]], [1, 2, 3, 4, 5, 6])
        earlier = self.comparison(end=self.days[3])["segments"][0]["leader"]
        self.assertEqual((earlier["code"], earlier["max_boards"]), ("600004", 5), "later peaks must not leak past the requested cutoff")
        self.assertEqual(before, [tuple(row) for row in self.conn.execute("SELECT * FROM events ORDER BY date,code")])

    def test_leader_excludes_current_pair_and_unrelated_later_cycles(self):
        self.save(self.days[2], 12, 10, [("600003", "同周期四板", 3), ("600004", "另一期高板", 2)])
        self.save(self.days[3], 13, 11, [("600003", "同周期四板", 4)])
        self.save(self.days[5], others=[("600004", "另一期高板", 99)])
        leader = self.comparison()["segments"][0]["leader"]
        self.assertEqual((leader["code"], leader["max_boards"]), ("600003", 4))

    def test_leader_ties_use_latest_overlap_then_ascending_code(self):
        self.save(self.days[2], 1, 1, [("600001", "较早七板", 7)])
        self.save(self.days[3], 2, 2, [("600005", "较晚七板乙", 7), ("600004", "较晚七板甲", 7)])
        leader = self.comparison()["segments"][0]["leader"]
        self.assertEqual(leader["code"], "600004")

    def test_leader_cannot_extend_over_missing_or_failed_trading_days(self):
        for status in (None, "failed"):
            with self.subTest(status=status):
                self.save(self.days[2], 1, 1, [("600003", "缺口前股票", 3), ("600004", "本期最高", 4)])
                if status:
                    self.save(self.days[3], status=status)
                self.save(self.days[4], others=[("600003", "缺口后股票", 5)])
                self.save(self.days[5], others=[("600003", "缺口后股票", 6)])
                leader = self.comparison()["segments"][0]["leader"]
                self.assertEqual((leader["code"], leader["max_boards"]), ("600004", 4))

    def test_each_period_selects_its_own_leader_and_empty_candidates_are_explicit(self):
        self.save(self.days[0], 1, 1, [("600003", "早期最高", 8)])
        self.save(self.days[2], 1, 1, [("600004", "本期最高", 5)])
        self.save(self.days[-1], 1, 1)
        segments = self.comparison()["segments"]
        self.assertIsNone(segments[0]["leader"])
        self.assertEqual([segment["leader"]["code"] for segment in segments[1:]], ["600004", "600003"])

    def test_leader_filters_exclude_st_and_both_gem_prefixes_independently(self):
        self.save(self.days[2], 1, 1, [("600001", "* ST 测试", 10), ("300001", "创业甲", 9),
                  ("301001", "创业乙", 8), ("688001", "科创样本", 7), ("600002", "普通样本", 6)])
        before = [tuple(row) for row in self.conn.execute("SELECT * FROM events ORDER BY date,code")]
        for filters, expected in [({}, "300001"), ({"exclude_st": True}, "300001"),
                                  ({"exclude_gem": True}, "688001"),
                                  ({"exclude_st": True, "exclude_gem": True}, "688001")]:
            with self.subTest(filters=filters):
                result = self.comparison(**filters)["segments"][0]
                self.assertEqual(result["leader"]["code"], expected)
                self.assertEqual(result["target_dates"], [{"date": self.days[2], "boards": 1}])
        self.assertEqual(before, [tuple(row) for row in self.conn.execute("SELECT * FROM events ORDER BY date,code")])

    def test_no_eligible_leader_after_filters_does_not_remove_pair(self):
        self.save(self.days[2], 1, 1, [("600001", "ST样本", 10), ("301001", "创业样本", 8)])
        segment, = self.comparison(exclude_st=True, exclude_gem=True)["segments"]
        self.assertIsNone(segment["leader"])
        self.assertEqual(len(segment["target_dates"]), 1)

    def test_round_cohort_includes_both_promoters_absent_reset_and_pending(self):
        self.save(self.days[0],1,1,[("600003","未入池股",1),("600004","板数重置股",1)])
        self.save(self.days[1],2,2,[("600004","板数重置股",1)])
        relations=db.stock_view(self.conn,"600668",self.days[0],self.days[1])["relationships"]
        first=next(r for r in relations["competition"]["rounds"] if r["date"]==self.days[0])
        members={p["code"]:p for p in first["cohort"]}
        self.assertEqual(set(members),{"600668","000530","600003","600004"})
        self.assertTrue(members["600668"]["is_target"])
        self.assertEqual(members["000530"]["promotion_status"],"advanced")
        self.assertEqual(members["600003"]["promotion_status"],"not_in_pool")
        self.assertEqual(members["600004"]["promotion_status"],"other_height")
        self.assertIn("tags",members["000530"],"all cohort members receive display profiles")
        final=relations["competition"]["rounds"][0]
        self.assertTrue(all(p["promotion_status"]=="pending" for p in final["cohort"]))
        self.assertEqual(relations["competition"]["win_count"],1,"adding cohort display cannot change win/loss counts")

    def test_comparison_route_is_read_only_and_validates_peer(self):
        self.save(self.days[0],1,1,[("600003", "同期最高", 5), ("300001", "ST创业样本", 8)])
        connect=db.connect
        def connect_copy(_):
            copied=connect(":memory:")
            self.conn.backup(copied)
            return copied
        with patch.object(app,"connect",side_effect=connect_copy):
            response=app.read_api(SimpleNamespace(db_path=":memory:",read_only=True),"/api/comparison?code=600668&peer=000530")
            self.assertEqual(len(response["segments"]),1)
            self.assertEqual(response["segments"][0]["leader"]["code"], "600003")
            filtered=app.read_api(SimpleNamespace(db_path=":memory:"),"/api/comparison?code=600668&peer=000530&exclude_st=1&exclude_gem=1")
            self.assertEqual(filtered["segments"][0]["leader"]["code"], "600003")
            for invalid_filter in ("exclude_st=2", "exclude_gem=bad"):
                with self.assertRaises(ValueError):
                    app.read_api(SimpleNamespace(db_path=":memory:"),f"/api/comparison?code=600668&peer=000530&{invalid_filter}")
            for invalid in ("no-code","600668"):
                with self.assertRaises(ValueError):
                    app.read_api(SimpleNamespace(db_path=":memory:"),f"/api/comparison?code=600668&peer={invalid}")

    def test_latest_day_exclusion_recalculates_relations_outcomes_and_leader_cutoff(self):
        self.save(self.days[-2], 1, 1, [("600003", "截止日前最高", 5), ("600004", "后续高板", 1)])
        self.save(self.days[-1], 2, 2, [("600004", "后续高板", 2), ("600005", "仅最新日同涨", 1)])
        connect=db.connect
        def connect_copy(_):
            copied=connect(":memory:")
            self.conn.backup(copied)
            return copied
        before=[tuple(row) for row in self.conn.execute("SELECT * FROM events ORDER BY date,code")]
        with patch.object(app,"connect",side_effect=connect_copy):
            context=SimpleNamespace(db_path=":memory:")
            full=app.read_api(context,"/api/stock?code=600668")
            filtered=app.read_api(context,"/api/stock?code=600668&exclude_latest=1")
            relations=filtered["relationships"]
            self.assertEqual((full["relationships"]["target_limit_days"], relations["target_limit_days"]),(2,1))
            self.assertEqual(relations["range_end"],self.days[-2])
            self.assertNotIn("600005",{peer["code"] for peer in relations["cooccurrences"]["rows"]})
            self.assertEqual(relations["competition"]["rounds"][0]["status"],"cutoff","the latest day's promotion result must not leak into prior-day outcomes")
            compared=app.read_api(context,"/api/comparison?code=600668&peer=000530&exclude_latest=1")
            self.assertEqual(compared["range_end"],self.days[-2])
            self.assertEqual(compared["segments"][0]["common_dates"],[self.days[-2]])
            self.assertTrue(all(row["date"]<self.days[-1] for segment in compared["segments"] for key in ("target_dates","peer_dates") for row in segment[key]))
            self.assertLess(compared["segments"][0]["leader"]["end"],self.days[-1])
            for endpoint in ("stock?code=600668", "comparison?code=600668&peer=000530"):
                with self.assertRaises(ValueError):app.read_api(context,"/api/"+endpoint+"&exclude_latest=bad")
        self.assertEqual(before,[tuple(row) for row in self.conn.execute("SELECT * FROM events ORDER BY date,code")])

    def test_excluding_the_only_day_returns_empty_relations_and_comparisons(self):
        self.save(self.days[-1],1,1)
        connect=db.connect
        def connect_copy(_):
            copied=connect(":memory:");self.conn.backup(copied);return copied
        with patch.object(app,"connect",side_effect=connect_copy):
            context=SimpleNamespace(db_path=":memory:")
            result=app.read_api(context,"/api/stock?code=600668&exclude_latest=1")
            self.assertEqual(result["relationships"]["target_limit_days"],0)
            self.assertEqual(result["relationships"]["cooccurrences"]["rows"],[])
            self.assertEqual(app.read_api(context,"/api/comparison?code=600668&peer=000530&exclude_latest=1")["segments"],[])


if __name__=="__main__":
    unittest.main()
