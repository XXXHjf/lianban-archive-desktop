"""Current Vue runtime packaging, not historical renderer assertions."""
from pathlib import Path
import json
import re
import unittest
from tools.check_frontend_build import verify_frontend_build

ROOT = Path(__file__).resolve().parents[1]


class FrontendBuildTests(unittest.TestCase):
    def test_current_build_matches_maintained_sources_and_versions(self):
        info = verify_frontend_build()
        self.assertEqual(set(info['dependencies']), {'vue', 'element-plus', '@element-plus/icons-vue', 'echarts'})
        self.assertIn('src/features/archive/DailyView.vue', info['source_sha256'])
        self.assertIn('src/features/intraday/IntradayView.vue', info['source_sha256'])
        self.assertIn('src/features/research/ResearchDialogs.vue', info['source_sha256'])

    def test_entry_loads_only_local_generated_assets(self):
        html = (ROOT / 'web/index.html').read_text(encoding='utf-8')
        self.assertIn('type="module"', html)
        paths = re.findall(r'(?:src|href)="([^"]+)"', html)
        self.assertIn('/app.js', paths)
        self.assertFalse(any(path.startswith(('https:', 'http:', '//')) for path in paths))
        for path in paths:
            self.assertTrue((ROOT / 'web' / path.lstrip('/')).is_file(), path)
        self.assertNotIn('/modules/', html)
        self.assertTrue((ROOT / 'web/assets/third-party-notices.txt').is_file())

    def test_current_frontend_does_not_import_historical_dom_renderer(self):
        for path in (ROOT / 'frontend/src').rglob('*'):
            if path.suffix not in ('.ts', '.vue') or path.name.endswith('.test.ts'):
                continue
            content = path.read_text(encoding='utf-8')
            self.assertNotIn('legacy_frontend', content, str(path))
            self.assertNotIn('web/modules', content, str(path))
            self.assertNotIn('v-html', content, str(path))
        manifest = json.loads((ROOT / 'BUNDLE.json').read_text(encoding='utf-8'))
        self.assertFalse(any('node_modules/' in name or 'legacy_frontend/' in name or name.startswith('frontend/') for name in manifest['sha256']))


if __name__ == '__main__':
    unittest.main()
