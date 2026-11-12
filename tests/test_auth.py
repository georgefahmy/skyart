#!/usr/bin/env python3
"""
Unit and integration tests for SkyArt user authentication, registration,
password validation, session persistence, drawing isolation, and rate limiting.
"""

import json
import os
import unittest
from app import app, db, SkyArtUser, SkyArtDrawing, _rate_limit_records


class SkyArtAuthTestCase(unittest.TestCase):
    def setUp(self):
        # Configure app for testing with an isolated in-memory or temporary database
        app.config["TESTING"] = True
        app.config["SQLALCHEMY_DATABASE_URI"] = "sqlite:///:memory:"
        app.config["WTF_CSRF_ENABLED"] = False
        app.config["SECRET_KEY"] = "test-secret-key-123456"
        self.client = app.test_client()

        with app.app_context():
            db.create_all()

        # Clear rate limit records between tests
        _rate_limit_records.clear()

    def tearDown(self):
        with app.app_context():
            db.session.rollback()
            try:
                SkyArtUser.query.delete()
                SkyArtDrawing.query.delete()
                db.session.commit()
            except Exception:
                pass

    # --- Registration Tests ---

    def test_registration_success(self):
        """Registering with a valid email and strong password must succeed and create a session."""
        payload = {
            "email": "pilot1@example.com",
            "password": "ValidPassword123!",
            "rememberMe": True
        }
        res = self.client.post("/api/auth/register", json=payload)
        self.assertEqual(res.status_code, 201)
        data = res.get_json()
        self.assertEqual(data.get("status"), "success")
        self.assertIn("user", data)
        self.assertEqual(data["user"]["email"], "pilot1@example.com")

        # Verify current user session via /api/auth/me
        me_res = self.client.get("/api/auth/me")
        self.assertEqual(me_res.status_code, 200)
        me_data = me_res.get_json()
        self.assertTrue(me_data.get("authenticated"))
        self.assertEqual(me_data["user"]["email"], "pilot1@example.com")

    def test_registration_invalid_email(self):
        """Malformed emails must be rejected with 400 Bad Request."""
        for bad_email in ["notanemail", "pilot@", "pilot@domain", "@domain.com", ""]:
            res = self.client.post("/api/auth/register", json={
                "email": bad_email,
                "password": "ValidPassword123!"
            })
            self.assertEqual(res.status_code, 400, f"Expected 400 for bad email: {bad_email}")

    def test_registration_weak_passwords(self):
        """Passwords not meeting strength criteria must be rejected with 400 Bad Request."""
        weak_passwords = [
            ("short1!", "too short"),
            ("nouppercase123!", "missing uppercase"),
            ("NOLOWERCASE123!", "missing lowercase"),
            ("NoNumbersHere!", "missing number"),
            ("NoSpecialChar123", "missing special character")
        ]
        for pw, reason in weak_passwords:
            res = self.client.post("/api/auth/register", json={
                "email": f"test_{reason.replace(' ', '_')}@example.com",
                "password": pw
            })
            self.assertEqual(res.status_code, 400, f"Expected 400 for {reason}: {pw}")

    def test_registration_duplicate_email(self):
        """Attempting to register with an already existing email must return 409 Conflict."""
        payload = {
            "email": "duplicate@example.com",
            "password": "Password123!"
        }
        res1 = self.client.post("/api/auth/register", json=payload)
        self.assertEqual(res1.status_code, 201)

        res2 = self.client.post("/api/auth/register", json=payload)
        self.assertEqual(res2.status_code, 409)
        data = res2.get_json()
        self.assertIn("already exists", data.get("message", ""))

    # --- Login & Logout Tests ---

    def test_login_success_and_logout(self):
        """Logging in with correct credentials must succeed, and logging out clears session."""
        # 1. Register user
        reg_payload = {
            "email": "rv7pilot@example.com",
            "password": "SuperSecretPass99#",
            "rememberMe": True
        }
        self.client.post("/api/auth/register", json=reg_payload)

        # 2. Logout
        logout_res = self.client.post("/api/auth/logout")
        self.assertEqual(logout_res.status_code, 200)

        # Confirm unauthenticated
        me_res = self.client.get("/api/auth/me")
        self.assertEqual(me_res.status_code, 401)

        # 3. Log in again
        login_res = self.client.post("/api/auth/login", json={
            "email": "rv7pilot@example.com",
            "password": "SuperSecretPass99#",
            "rememberMe": False
        })
        self.assertEqual(login_res.status_code, 200)
        self.assertEqual(login_res.get_json()["user"]["email"], "rv7pilot@example.com")

        # Confirm authenticated again
        me_res2 = self.client.get("/api/auth/me")
        self.assertEqual(me_res2.status_code, 200)
        self.assertTrue(me_res2.get_json()["authenticated"])

    def test_login_invalid_password(self):
        """Login with wrong password must return 401 Unauthorized."""
        self.client.post("/api/auth/register", json={
            "email": "wrongpass@example.com",
            "password": "CorrectPassword123$"
        })
        self.client.post("/api/auth/logout")

        res = self.client.post("/api/auth/login", json={
            "email": "wrongpass@example.com",
            "password": "IncorrectPassword999!"
        })
        self.assertEqual(res.status_code, 401)
        self.assertIn("Invalid email or password", res.get_json()["message"])

    def test_login_nonexistent_email(self):
        """Login with nonexistent email must return 401 Unauthorized."""
        res = self.client.post("/api/auth/login", json={
            "email": "nobody@example.com",
            "password": "AnyPassword123!"
        })
        self.assertEqual(res.status_code, 401)

    # --- Drawing Protection & Isolation Tests ---

    def test_unauthenticated_drawing_access_blocked(self):
        """Unauthenticated requests to get/save drawings must be rejected with 401."""
        get_res = self.client.get("/api/sky_art/drawings")
        self.assertEqual(get_res.status_code, 401)

        post_res = self.client.post("/api/sky_art/drawings", json={
            "name": "Secret Route",
            "basePoints": [{"x": 0, "y": 0}, {"x": 10, "y": 10}]
        })
        self.assertEqual(post_res.status_code, 401)

    def test_drawing_isolation_between_users(self):
        """User A's drawings must never be visible or editable by User B."""
        # User A registers & creates a drawing
        self.client.post("/api/auth/register", json={
            "email": "userA@example.com",
            "password": "PasswordUserA1!"
        })
        draw_res = self.client.post("/api/sky_art/drawings", json={
            "id": "art_user_a_1",
            "name": "User A Diamond",
            "basePoints": [{"x": 0, "y": 0}, {"x": 10, "y": 10}, {"x": 20, "y": 0}, {"x": 0, "y": 0}]
        })
        self.assertEqual(draw_res.status_code, 200)

        # User A sees 1 drawing
        drawings_a = self.client.get("/api/sky_art/drawings").get_json()
        self.assertEqual(len(drawings_a), 1)
        self.assertEqual(drawings_a[0]["name"], "User A Diamond")

        # User A logs out
        self.client.post("/api/auth/logout")

        # User B registers
        self.client.post("/api/auth/register", json={
            "email": "userB@example.com",
            "password": "PasswordUserB2!"
        })

        # User B sees 0 drawings
        drawings_b = self.client.get("/api/sky_art/drawings").get_json()
        self.assertEqual(len(drawings_b), 0)

        # User B cannot delete User A's drawing
        del_res = self.client.delete("/api/sky_art/drawings/art_user_a_1")
        self.assertEqual(del_res.status_code, 403)

    # --- Local Drawing Migration Tests ---

    def test_drawing_migration_to_user_account(self):
        """Anonymous or local browser drawings migrate cleanly into newly authenticated user account."""
        self.client.post("/api/auth/register", json={
            "email": "migrator@example.com",
            "password": "MigratePassword1!"
        })

        local_drawings = [
            {
                "id": "art_local_1",
                "name": "Local RV-7 Outline",
                "basePoints": [{"x": 1, "y": 1}, {"x": 5, "y": 5}],
                "aspectRatio": 1.0,
                "sizeNM": 15.0
            },
            {
                "id": "art_local_2",
                "name": "Local Heart Shape",
                "basePoints": [{"x": 2, "y": 2}, {"x": 6, "y": 6}],
                "aspectRatio": 1.2,
                "sizeNM": 10.0
            }
        ]

        migrate_res = self.client.post("/api/sky_art/drawings/migrate", json={"drawings": local_drawings})
        self.assertEqual(migrate_res.status_code, 200)
        self.assertEqual(migrate_res.get_json()["importedCount"], 2)

        # Check drawings list for user
        user_drawings = self.client.get("/api/sky_art/drawings").get_json()
        self.assertEqual(len(user_drawings), 2)
        names = {d["name"] for d in user_drawings}
        self.assertIn("Local RV-7 Outline", names)
        self.assertIn("Local Heart Shape", names)

    # --- Rate Limiting Tests ---

    def test_rate_limiting_login_endpoint(self):
        """Exceeding max login attempts within sliding window returns 429 Too Many Requests."""
        for _ in range(15):
            res = self.client.post("/api/auth/login", json={
                "email": "nonexistent@example.com",
                "password": "Password123!"
            })
            self.assertEqual(res.status_code, 401)

        # 16th attempt should be rate limited
        blocked_res = self.client.post("/api/auth/login", json={
            "email": "nonexistent@example.com",
            "password": "Password123!"
        })
        self.assertEqual(blocked_res.status_code, 429)
        self.assertIn("Too many login attempts", blocked_res.get_json()["message"])

    # --- Pilot Profile Tests ---

    def test_profile_requires_authentication(self):
        """Unauthenticated profile access returns 401 Unauthorized."""
        res_get = self.client.get("/api/user/profile")
        self.assertEqual(res_get.status_code, 401)

        res_post = self.client.post("/api/user/profile", json={"pilotName": "Capt. Test"})
        self.assertEqual(res_post.status_code, 401)

    def test_profile_update_and_retrieval(self):
        """Authenticated user can save optional pilot profile and retrieve it."""
        self.client.post("/api/auth/register", json={
            "email": "profilepilot@example.com",
            "password": "StrongPassword123!"
        })

        profile_payload = {
            "pilotName": "Geoff Fahmy",
            "tailNumber": "N890GF",
            "homeAirport": "KSQL",
            "aircraftType": "Van's RV-7"
        }
        update_res = self.client.post("/api/user/profile", json=profile_payload)
        self.assertEqual(update_res.status_code, 200)
        data = update_res.get_json()
        self.assertEqual(data["status"], "success")
        user = data["user"]
        self.assertEqual(user["pilotName"], "Geoff Fahmy")
        self.assertEqual(user["tailNumber"], "N890GF")
        self.assertEqual(user["homeAirport"], "KSQL")
        self.assertEqual(user["aircraftType"], "Van's RV-7")

        # Verify via GET /api/user/profile
        get_res = self.client.get("/api/user/profile")
        self.assertEqual(get_res.status_code, 200)
        profile_data = get_res.get_json()["profile"]
        self.assertEqual(profile_data["pilotName"], "Geoff Fahmy")
        self.assertEqual(profile_data["tailNumber"], "N890GF")
        self.assertEqual(profile_data["homeAirport"], "KSQL")
        self.assertEqual(profile_data["aircraftType"], "Van's RV-7")

        # Verify via GET /api/auth/me
        me_res = self.client.get("/api/auth/me")
        self.assertEqual(me_res.status_code, 200)
        me_user = me_res.get_json()["user"]
        self.assertEqual(me_user["pilotName"], "Geoff Fahmy")
        self.assertEqual(me_user["tailNumber"], "N890GF")

    def test_profile_home_airport_sync(self):
        """Setting home airport in profile automatically synchronizes user's home airport."""
        self.client.post("/api/auth/register", json={
            "email": "syncpilot@example.com",
            "password": "StrongPassword123!"
        })

        self.client.post("/api/user/profile", json={
            "pilotName": "Bay Pilot",
            "homeAirport": "KPAO"
        })

        home_res = self.client.get("/api/sky_art/home_airport")
        self.assertEqual(home_res.status_code, 200)
        home_data = home_res.get_json()
        self.assertEqual(home_data["status"], "success")
        self.assertEqual(home_data["airport"]["icao"], "KPAO")


if __name__ == "__main__":
    unittest.main()
