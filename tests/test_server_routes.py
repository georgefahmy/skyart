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

    def test_ip_access_logging(self):
        """Verify server logs client IP addresses for requests accessing the website."""
        with self.assertLogs('sky_art', level='INFO') if 'sky_art' in app.logger.name else self.assertLogs(app.logger, level='INFO') as cm:
            # 1. Access with X-Forwarded-For header
            res1 = self.client.get('/', headers={'X-Forwarded-For': '198.51.100.42, 10.0.0.1'})
            self.assertEqual(res1.status_code, 200)

            # 2. Access with X-Real-IP header
            res2 = self.client.get('/api/airports/search?q=SFO', headers={'X-Real-IP': '203.0.113.19'})
            self.assertEqual(res2.status_code, 200)

            # 3. Access with CF-Connecting-IP header
            res3 = self.client.get('/', headers={'CF-Connecting-IP': '192.0.2.77'})
            self.assertEqual(res3.status_code, 200)

        logs = "\n".join(cm.output)
        self.assertIn("198.51.100.42", logs)
        self.assertIn("[ACCESS]", logs)
        self.assertIn("203.0.113.19", logs)
        self.assertIn("192.0.2.77", logs)

    def test_saved_art_ip_logging(self):
        """Verify server logs the names of saved art associated with the client IP address."""
        import uuid
        uid = f"usr_test_{uuid.uuid4().hex[:8]}"
        art_name = "Golden Gate Star"
        client_ip = "198.51.100.99"

        with self.assertLogs(app.logger, level='INFO') as cm:
            res_save = self.client.post(
                '/api/sky_art/drawings',
                headers={
                    'X-User-ID': uid,
                    'X-Forwarded-For': client_ip
                },
                json={
                    "name": art_name,
                    "basePoints": [
                        {"lat": 37.7749, "lon": -122.4194},
                        {"lat": 37.8044, "lon": -122.2712}
                    ],
                    "sizeNM": 15.0
                }
            )
            self.assertEqual(res_save.status_code, 200)
            data = res_save.get_json()
            self.assertEqual(data["status"], "success")
            self.assertEqual(data["drawing"]["name"], art_name)
            self.assertEqual(data["drawing"]["ipAddress"], client_ip)
            drawing_id = data["drawing"]["id"]

            # Also verify delete logging
            res_del = self.client.delete(
                f'/api/sky_art/drawings/{drawing_id}',
                headers={
                    'X-User-ID': uid,
                    'X-Forwarded-For': client_ip
                }
            )
            self.assertEqual(res_del.status_code, 200)

        logs = "\n".join(cm.output)
        # Check that saved art name and IP are logged
        self.assertIn("[SAVED ART]", logs)
        self.assertIn(client_ip, logs)
        self.assertIn(art_name, logs)
        # Check that deleted art name and IP are logged
        self.assertIn("[DELETED ART]", logs)


if __name__ == '__main__':
    unittest.main()
