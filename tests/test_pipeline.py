"""ネットにつながずに確認できる部分のテスト。  python -m unittest discover -s tests"""
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from pipeline import captions, publish
from pipeline.util import walk_minutes, yen_short, load_brand


class UtilTest(unittest.TestCase):
    def test_walk_minutes(self):
        self.assertEqual(walk_minutes(640), 8)
        self.assertEqual(walk_minutes(641), 9)   # 端数は切り上げ
        self.assertEqual(walk_minutes(50), 1)
        self.assertIsNone(walk_minutes(""))

    def test_yen(self):
        self.assertEqual(yen_short(78000), "7.8万円")
        self.assertEqual(yen_short(125000), "12.5万円")
        self.assertEqual(yen_short(35000000), "3,500万円")
        self.assertEqual(yen_short(5000), "5,000円")


class CaptionTest(unittest.TestCase):
    prop = {"id": "P001", "price": 78000, "layout": "1LDK", "station": "中野駅", "station_m": 640,
            "deal_type": "仲介", "updated": "2026年10月28日", "points": "南向き、独立洗面台"}

    def test_ng_words(self):
        ng = load_brand()["ng_words"]
        self.assertEqual(captions.find_ng("駅から徒歩5分を超える距離", ng), [])
        self.assertEqual(captions.find_ng("積極的にご案内", ng), [])
        self.assertIn("最高", captions.find_ng("最高の眺望", ng))
        self.assertIn("格安", captions.find_ng("格安物件", ng))

    def test_template_has_legal_footer(self):
        with mock.patch.dict("os.environ", {"GEMINI_API_KEY": ""}):
            out, warnings = captions.generate(self.prop, load_brand())
        self.assertIn("取引態様：仲介", out["reel_caption"])
        self.assertIn("2026年10月28日時点", out["reel_caption"])
        self.assertIn("徒歩8分", out["reel_caption"])
        self.assertNotIn("http", out["threads_tip"])
        self.assertTrue(warnings)

    def test_gemini_retry_on_ng(self):
        bad = {k: "最高の部屋" for k in captions.FIELDS}
        bad["hashtags"] = ["#中野"]
        good = {k: "明るい部屋" for k in captions.FIELDS}
        good["hashtags"] = ["#中野"]
        with mock.patch.dict("os.environ", {"GEMINI_API_KEY": "k"}), \
                mock.patch.object(captions, "_gemini", side_effect=[bad, good]) as g:
            out, warnings = captions.generate(self.prop, load_brand())
        self.assertEqual(g.call_count, 2)
        self.assertIn("言い換えて", g.call_args_list[1].args[0])
        self.assertEqual(warnings, [])
        self.assertTrue(out["reel_caption"].startswith("明るい部屋"))


class FakeResp:
    def __init__(self, data, code=200):
        self._d, self.status_code, self.ok, self.text = data, code, code < 400, json.dumps(data)
        self.headers = {}

    def json(self):
        return self._d


class PublishTest(unittest.TestCase):
    def test_reel_carousel_threads(self):
        seen = []

        def fake_post(url, data=None, **kw):
            seen.append(("POST", url, data))
            if "media_publish" in url or "threads_publish" in url:
                return FakeResp({"id": "PUB"})
            return FakeResp({"id": f"C{len(seen)}"})

        def fake_get(url, params=None, **kw):
            if params and params.get("fields") == "status_code,status":
                return FakeResp({"status_code": "FINISHED"})
            if params and params.get("fields") == "status,error_message":
                return FakeResp({"status": "FINISHED"})
            return FakeResp({"permalink": "https://example.com/p/1"})

        job = {"job_id": "J1", "ig": {"user_id": "IGU", "token": "SECRET_IG"},
               "threads": {"user_id": "THU", "token": "SECRET_TH"},
               "posts": [
                   {"post_id": "S1", "type": "ig_reel", "caption": "c", "paths": ["m/x/S1_00.mp4"]},
                   {"post_id": "S2", "type": "ig_carousel", "caption": "c", "paths": ["m/x/a.jpg", "m/x/b.jpg"]},
                   {"post_id": "S3", "type": "threads_video", "caption": "t", "topic": "部屋探し", "paths": ["m/x/S3.mp4"]},
                   {"post_id": "S4", "type": "ig_story", "caption": "", "paths": []},
               ]}
        reported = {}
        with tempfile.TemporaryDirectory() as td:
            st = Path(td) / "job.json"
            st.write_text(json.dumps(job))
            with mock.patch.object(publish.requests, "post", fake_post), \
                    mock.patch.object(publish.requests, "get", fake_get), \
                    mock.patch.object(publish.requests, "head", lambda *a, **k: FakeResp({}, 200)), \
                    mock.patch.object(publish, "Gas") as G:
                G.return_value.call.side_effect = lambda action, **kw: reported.update(kw) or {"ok": True}
                publish.run(st, "https://me.github.io/fudosan-auto/")
        res = {r["post_id"]: r for r in reported["results"]}
        self.assertTrue(res["S1"]["ok"] and res["S2"]["ok"] and res["S3"]["ok"])
        self.assertFalse(res["S4"]["ok"])           # 素材なしは失敗として報告
        self.assertNotIn("SECRET", json.dumps(reported))
        reel = next(d for m, u, d in seen if d and d.get("media_type") == "REELS")
        self.assertEqual(reel["video_url"], "https://me.github.io/fudosan-auto/m/x/S1_00.mp4")
        car = next(d for m, u, d in seen if d and d.get("media_type") == "CAROUSEL")
        self.assertEqual(len(car["children"].split(",")), 2)
        th = next(d for m, u, d in seen if d and d.get("media_type") == "VIDEO")
        self.assertEqual(th["topic_tag"], "部屋探し")


if __name__ == "__main__":
    unittest.main()


class GeminiFallbackTest(unittest.TestCase):
    def test_falls_back_on_missing_model_and_reports_key_errors(self):
        from pipeline import gemini
        calls = []

        def fake_post(url, **kw):
            calls.append(url.split("/models/")[1].split(":")[0])
            if len(calls) == 1:
                return FakeResp({"error": {"message": "models/x is not found for API version v1beta"}}, 404)
            return FakeResp({"error": {"message": "API key not valid. Please pass a valid API key."}}, 400)

        with mock.patch.dict("os.environ", {"GEMINI_API_KEY": "SECRETKEY", "GEMINI_MODEL": ""}), \
                mock.patch.object(gemini.requests, "post", fake_post):
            with self.assertRaises(gemini.GeminiError) as cm:
                gemini.generate_json([{"text": "hi"}], {}, "old-model")
        self.assertEqual(calls[0], "old-model")
        self.assertEqual(len(calls), 2)            # キーの誤りでは何度もやり直さない
        self.assertIn("API key not valid", str(cm.exception))
        self.assertNotIn("SECRETKEY", str(cm.exception))


class GeminiModelDiscoveryTest(unittest.TestCase):
    def test_retired_model_switches_to_listed_model(self):
        from pipeline import gemini
        gemini._available = None
        posted = []

        def fake_get(url, **kw):
            return FakeResp({"models": [
                {"name": "models/gemini-3.8-flash", "supportedGenerationMethods": ["generateContent"]},
                {"name": "models/gemini-3.8-flash-lite", "supportedGenerationMethods": ["generateContent"]},
                {"name": "models/gemini-3.1-flash", "supportedGenerationMethods": ["generateContent"]},
                {"name": "models/text-embedding-9", "supportedGenerationMethods": ["embedContent"]}]})

        def fake_post(url, **kw):
            m = url.split("/models/")[1].split(":")[0]
            posted.append(m)
            if m == "gemini-3.8-flash":
                return FakeResp({"candidates": [{"content": {"parts": [{"text": "{\"ok\": true}"}]}}]})
            return FakeResp({"error": {"message": f"This model models/{m} is no longer available."}}, 404)

        with mock.patch.dict("os.environ", {"GEMINI_API_KEY": "K", "GEMINI_MODEL": ""}), \
                mock.patch.object(gemini.requests, "post", fake_post), \
                mock.patch.object(gemini.requests, "get", fake_get):
            out = gemini.generate_json([{"text": "hi"}], {}, "gemini-2.5-flash")
        self.assertEqual(out, {"ok": True})
        self.assertEqual(posted[-1], "gemini-3.8-flash")
        self.assertNotIn("gemini-3.8-flash-lite", posted)
        gemini._available = None
