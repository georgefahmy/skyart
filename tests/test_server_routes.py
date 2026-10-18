import unittest
from app import app

class TestServerIntegrity(unittest.TestCase):
    def setUp(self):
        self.client = app.test_client()

    def test_homepage_loads(self):
        res = self.client.get('/')
        self.assertEqual(res.status_code, 200)
        self.assertIn(b'SkyArt', res.data)
        # Ensure N890GF authoring references are not present in client template
        self.assertNotIn(b'Author: N890GF', res.data)

    def test_static_js_contains_sync_fix(self):
        res = self.client.get('/static/js/sky_art.js')
        self.assertEqual(res.status_code, 200)
        # Verify the fix exists in served static bundle
        self.assertIn(b'_onMapInterrupt', res.data)
        self.assertIn(b'resyncMapRenderers', res.data)

    def test_airport_search_api(self):
        res = self.client.get('/api/airports/search?q=E16')
        self.assertEqual(res.status_code, 200)
        data = res.get_json()
        self.assertIsInstance(data, list)
        self.assertTrue(any(a.get('icao') == 'E16' or a.get('faa') == 'E16' for a in data))

if __name__ == '__main__':
    unittest.main()
