"""Launcher readiness tests. No browser/process actually launched."""
import importlib.util
import io
import sys
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


class LauncherTests(unittest.TestCase):
    def test_launcher_file_is_present(self):
        self.assertTrue((ROOT / 'launcher.py').is_file(), 'readiness-aware launcher missing')

    def load(self):
        spec = importlib.util.spec_from_file_location('ks_launcher', ROOT / 'launcher.py')
        m = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(m)
        return m

    def test_opens_browser_only_after_ready(self):
        m = self.load()
        process = Mock()
        process.wait.return_value = 0
        with patch.object(m, 'port_in_use', return_value=False), patch.object(m.subprocess, 'Popen', return_value=process), patch.object(m, 'wait_ready', return_value=True) as ready, patch.object(m.webbrowser, 'open') as browser:
            self.assertEqual(m.run(open_browser=True), 0)
            ready.assert_called_once()
            browser.assert_called_once()

    def test_failed_readiness_does_not_open_browser(self):
        m = self.load()
        process = Mock()
        process.poll.return_value = None
        with patch.object(m, 'port_in_use', return_value=False), patch.object(m.subprocess, 'Popen', return_value=process), patch.object(m, 'wait_ready', return_value=False), patch.object(m.webbrowser, 'open') as browser:
            self.assertEqual(m.run(open_browser=True), 1)
            browser.assert_not_called()
            process.terminate.assert_called_once()

    def test_foreign_port_does_not_launch_or_open(self):
        m = self.load()
        with patch.object(m, 'port_in_use', return_value=True), patch.object(m, 'health_ok', return_value=False), patch.object(m.subprocess, 'Popen') as popen, patch.object(m.webbrowser, 'open') as browser:
            self.assertEqual(m.run(open_browser=True), 1)
            popen.assert_not_called()
            browser.assert_not_called()

    def test_reuses_healthy_app(self):
        m = self.load()
        with patch.object(m, 'port_in_use', return_value=True), patch.object(m, 'health_ok', return_value=True), patch.object(m.subprocess, 'Popen') as popen, patch.object(m.webbrowser, 'open') as browser:
            self.assertEqual(m.run(open_browser=True), 0)
            popen.assert_not_called()
            browser.assert_called_once()

    def test_health_rejects_non_object_json_without_network(self):
        m = self.load()
        for payload in ('[]', 'null', '3', '"healthy"', 'true'):
            with self.subTest(payload=payload):
                with patch.object(m.urllib.request, 'urlopen', return_value=io.StringIO(payload)) as request:
                    self.assertFalse(m.health_ok('http://health.invalid/'))
                    request.assert_called_once_with('http://health.invalid/api/health', timeout=1)

    def test_health_requires_expected_application_object_without_network(self):
        m = self.load()
        for payload, expected in (
            ('{"ok":true,"version":"1.1.0"}', True),
            ('{"ok":true,"version":"other"}', False),
            ('{"ok":false,"version":"1.1.0"}', False),
            ('{}', False),
        ):
            with self.subTest(payload=payload):
                with patch.object(m.urllib.request, 'urlopen', return_value=io.StringIO(payload)):
                    self.assertEqual(m.health_ok('http://health.invalid'), expected)


if __name__ == '__main__':
    unittest.main(verbosity=2)
