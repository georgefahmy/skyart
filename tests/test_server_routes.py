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

    def test_top_search_home_airport_markup(self):
        res = self.client.get('/')
        self.assertEqual(res.status_code, 200)
        self.assertIn(b'topHomeAirportBadge', res.data)
        self.assertIn(b'jumpToHomeBtn', res.data)
        # configHomeAirportBtn was in the lower airport card and should be removed
        self.assertNotIn(b'id="configHomeAirportBtn"', res.data)
        # setDepAsHomeBtn was also removed in favor of top search unification
        self.assertNotIn(b'id="setDepAsHomeBtn"', res.data)

    def test_home_airport_user_isolation(self):
        import uuid
        uid_alice = f"usr_alice_{uuid.uuid4().hex[:8]}"
        uid_bob = f"usr_bob_{uuid.uuid4().hex[:8]}"

        # User 1 (Alice)
        headers_alice = {"X-User-ID": uid_alice}
        res_get_alice_init = self.client.get('/api/sky_art/home_airport', headers=headers_alice)
        self.assertEqual(res_get_alice_init.status_code, 200)
        self.assertEqual(res_get_alice_init.get_json().get("status"), "not_found")

        # Alice saves KPAO
        res_save_alice = self.client.post(
            '/api/sky_art/home_airport',
            headers=headers_alice,
            json={
                "icao": "KPAO",
                "name": "Palo Alto Airport",
                "lat": 37.4611,
                "lon": -122.1150
            }
        )
        self.assertEqual(res_save_alice.status_code, 200)
        self.assertEqual(res_save_alice.get_json()["airport"]["icao"], "KPAO")

        # User 2 (Bob)
        headers_bob = {"X-User-ID": uid_bob}
        res_get_bob = self.client.get('/api/sky_art/home_airport', headers=headers_bob)
        self.assertEqual(res_get_bob.status_code, 200)
        self.assertEqual(res_get_bob.get_json().get("status"), "not_found")

        # Bob saves KCCR
        res_save_bob = self.client.post(
            '/api/sky_art/home_airport',
            headers=headers_bob,
            json={
                "icao": "KCCR",
                "name": "Buchanan Field Airport",
                "lat": 37.9897,
                "lon": -122.0569
            }
        )
        self.assertEqual(res_save_bob.status_code, 200)
        self.assertEqual(res_save_bob.get_json()["airport"]["icao"], "KCCR")

        # Verify Alice still gets KPAO
        res_get_alice_final = self.client.get('/api/sky_art/home_airport', headers=headers_alice)
        self.assertEqual(res_get_alice_final.status_code, 200)
        self.assertEqual(res_get_alice_final.get_json()["airport"]["icao"], "KPAO")
        self.assertEqual(res_get_alice_final.get_json()["airport"]["name"], "Palo Alto Airport")

        # Verify Bob still gets KCCR
        res_get_bob_final = self.client.get('/api/sky_art/home_airport', headers=headers_bob)
        self.assertEqual(res_get_bob_final.status_code, 200)
        self.assertEqual(res_get_bob_final.get_json()["airport"]["icao"], "KCCR")


if __name__ == '__main__':
    unittest.main()
