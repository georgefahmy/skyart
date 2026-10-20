#!/usr/bin/env python3
"""
SkyArt - GPS Flight Art & ForeFlight Flight Plan Generator
Standalone server application.
"""

import json
import logging
import os
import re
import time
import uuid
import urllib.parse
from datetime import datetime, timezone
from logging.handlers import RotatingFileHandler

from flask import Flask, jsonify, make_response, render_template, request
from flask_sqlalchemy import SQLAlchemy

BASE_DIR = os.path.abspath(os.path.dirname(__file__))
INSTANCE_DIR = os.path.join(BASE_DIR, "instance")
os.makedirs(INSTANCE_DIR, exist_ok=True)

# --- Load local .env configuration if present ---
ENV_FILE = os.path.join(BASE_DIR, ".env")
if os.path.exists(ENV_FILE):
    try:
        with open(ENV_FILE, "r", encoding="utf-8") as _env_f:
            for _line in _env_f:
                _line = _line.strip()
                if _line and not _line.startswith("#") and "=" in _line:
                    _k, _v = _line.split("=", 1)
                    _k = _k.strip()
                    _v = _v.strip().strip("'\"")
                    if _k and _k not in os.environ:
                        os.environ[_k] = _v
    except Exception:
        pass

app = Flask(__name__, instance_path=INSTANCE_DIR)
app.secret_key = os.environ.get("SECRET_KEY", "skyart-standalone-secret-key-9281729482")
app.config["MAX_CONTENT_LENGTH"] = 32 * 1024 * 1024

db_path = os.path.join(app.instance_path, "sky_art.db")
app.config["SQLALCHEMY_DATABASE_URI"] = os.environ.get(
    "DATABASE_URL", f"sqlite:///{db_path}"
)
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False

db = SQLAlchemy(app)

# --- Server-Side Logging Configuration ---
LOG_FILE = os.path.join(INSTANCE_DIR, "sky_art.log")
log_formatter = logging.Formatter("%(asctime)s [%(levelname)s] %(message)s")

file_handler = RotatingFileHandler(
    LOG_FILE, maxBytes=10 * 1024 * 1024, backupCount=5, encoding="utf-8"
)
file_handler.setFormatter(log_formatter)
file_handler.setLevel(logging.INFO)

console_handler = logging.StreamHandler()
console_handler.setFormatter(log_formatter)
console_handler.setLevel(logging.INFO)

root_logger = logging.getLogger()
root_logger.setLevel(logging.INFO)
if not any(isinstance(h, RotatingFileHandler) for h in root_logger.handlers):
    root_logger.addHandler(file_handler)
if not any(
    isinstance(h, logging.StreamHandler) and not isinstance(h, RotatingFileHandler)
    for h in root_logger.handlers
):
    root_logger.addHandler(console_handler)

app.logger.setLevel(logging.INFO)
app.logger.handlers.clear()
app.logger.propagate = True

USER_COOKIE_NAME = "skyart_uid"


def get_client_ip():
    """
    Extract client IP address, supporting reverse proxies (Nginx, Cloudflare, etc.).
    """
    # 1. Cloudflare header
    cf_ip = request.headers.get("CF-Connecting-IP")
    if cf_ip:
        return cf_ip.strip()

    # 2. Standard X-Forwarded-For header (first entry is original client IP)
    x_forwarded_for = request.headers.get("X-Forwarded-For")
    if x_forwarded_for:
        client_ip = x_forwarded_for.split(",")[0].strip()
        if client_ip:
            if (
                ":" in client_ip
                and not client_ip.startswith("[")
                and client_ip.count(":") == 1
            ):
                client_ip = client_ip.split(":")[0]
            return client_ip

    # 3. Nginx X-Real-IP header
    x_real_ip = request.headers.get("X-Real-IP")
    if x_real_ip:
        client_ip = x_real_ip.strip()
        if (
            ":" in client_ip
            and not client_ip.startswith("[")
            and client_ip.count(":") == 1
        ):
            client_ip = client_ip.split(":")[0]
        return client_ip

    # 4. Standard WSGI remote_addr
    ip = request.remote_addr or "127.0.0.1"
    if ":" in ip and not ip.startswith("[") and ip.count(":") == 1:
        ip = ip.split(":")[0]
    return ip


def sanitize_user_id(uid):
    if not uid or not isinstance(uid, str):
        return None
    uid = uid.strip()
    if 4 <= len(uid) <= 100 and re.match(r"^[a-zA-Z0-9_-]+$", uid):
        return uid
    return None


def get_or_create_user_id():
    # 1. Custom header from frontend (localStorage sync)
    uid = sanitize_user_id(request.headers.get("X-User-ID"))
    if uid:
        return uid, False

    # 2. Browser cookie
    uid = sanitize_user_id(request.cookies.get(USER_COOKIE_NAME))
    if uid:
        return uid, False

    # 3. Generate a new persistent user instance ID
    new_uid = f"usr_{uuid.uuid4().hex}"
    return new_uid, True


@app.before_request
def identify_user_instance():
    request._client_ip = get_client_ip()
    uid, is_new = get_or_create_user_id()
    request._skyart_user_id = uid
    request._skyart_user_id_is_new = is_new


@app.after_request
def log_request_access(response):
    client_ip = getattr(request, "_client_ip", None) or get_client_ip()
    uid = getattr(request, "_skyart_user_id", "-")
    # Server-side logging of IP address accessing the website
    app.logger.info(
        f"[ACCESS] IP: {client_ip} | User: {uid} | {request.method} {request.path} -> {response.status_code}"
    )
    return response


@app.after_request
def persist_user_cookie(response):
    uid = getattr(request, "_skyart_user_id", None)
    is_new = getattr(request, "_skyart_user_id_is_new", False)
    if uid and (is_new or USER_COOKIE_NAME not in request.cookies):
        response.set_cookie(
            USER_COOKIE_NAME,
            uid,
            max_age=315360000,  # 10 years persistence
            httponly=False,  # Allow frontend JS to read for localStorage fallback
            samesite="Lax",
            secure=request.is_secure,
        )
    return response


class SkyArtDrawing(db.Model):
    __tablename__ = "sky_art_drawings"

    id = db.Column(db.String(100), primary_key=True)
    user_id = db.Column(db.String(100), index=True, nullable=True)
    name = db.Column(db.String(100), nullable=False)
    ip_address = db.Column(db.String(50), index=True, nullable=True)
    created_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc))
    aspect_ratio = db.Column(db.Float, default=1.0)
    size_nm = db.Column(db.Float, default=12.0)
    height_nm = db.Column(db.Float, default=12.0)
    lock_aspect = db.Column(db.Boolean, default=True)
    route_reversed = db.Column(db.Boolean, default=False)
    point_count = db.Column(db.Integer, default=0)
    base_points_json = db.Column(db.Text, nullable=False)
    base_contours_json = db.Column(db.Text, nullable=True)

    def to_dict(self):
        try:
            pts = json.loads(self.base_points_json) if self.base_points_json else []
        except Exception:
            pts = []
        contours = None
        if self.base_contours_json:
            try:
                contours = json.loads(self.base_contours_json)
            except Exception:
                contours = None
        return {
            "id": self.id,
            "name": self.name,
            "ipAddress": self.ip_address,
            "createdAt": self.created_at.isoformat() if self.created_at else None,
            "aspectRatio": self.aspect_ratio if self.aspect_ratio is not None else 1.0,
            "sizeNM": self.size_nm if self.size_nm is not None else 12.0,
            "heightNM": self.height_nm if self.height_nm is not None else 12.0,
            "lockAspect": self.lock_aspect if self.lock_aspect is not None else True,
            "routeReversed": bool(self.route_reversed),
            "pointCount": self.point_count or len(pts),
            "basePoints": pts,
            "baseContours": contours,
        }


class SkyArtHomeAirport(db.Model):
    __tablename__ = "sky_art_home_airports"

    user_id = db.Column(db.String(100), primary_key=True)
    icao = db.Column(db.String(20), nullable=False)
    name = db.Column(db.String(150), nullable=False)
    lat = db.Column(db.Float, nullable=False)
    lon = db.Column(db.Float, nullable=False)
    updated_at = db.Column(
        db.DateTime,
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )

    def to_dict(self):
        return {
            "icao": self.icao,
            "faa": self.icao,
            "name": self.name,
            "lat": self.lat,
            "lon": self.lon,
            "updatedAt": self.updated_at.isoformat() if self.updated_at else None,
        }


class SkyArtFeedback(db.Model):
    __tablename__ = "sky_art_feedback"

    id = db.Column(db.Integer, primary_key=True, autoincrement=True)
    user_id = db.Column(db.String(100), index=True, nullable=True)
    ip_address = db.Column(db.String(50), index=True, nullable=True)
    created_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc))
    sender_name = db.Column(db.String(150), nullable=True)
    sender_email = db.Column(db.String(150), nullable=True)
    category = db.Column(db.String(100), nullable=True)
    subject = db.Column(db.String(200), default="SkyArt Feedback")
    message = db.Column(db.Text, nullable=False)
    diagnostics_json = db.Column(db.Text, nullable=True)
    email_status = db.Column(db.String(100), default="saved")

    def to_dict(self):
        try:
            diag = json.loads(self.diagnostics_json) if self.diagnostics_json else None
        except Exception:
            diag = None
        return {
            "id": self.id,
            "userId": self.user_id,
            "ipAddress": self.ip_address,
            "createdAt": self.created_at.isoformat() if self.created_at else None,
            "senderName": self.sender_name,
            "senderEmail": self.sender_email,
            "category": self.category,
            "subject": self.subject,
            "message": self.message,
            "diagnostics": diag,
            "emailStatus": self.email_status,
        }


with app.app_context():
    db.create_all()
    try:
        from sqlalchemy import text

        with db.engine.connect() as conn:
            res = conn.execute(text("PRAGMA table_info(sky_art_drawings)")).fetchall()
            cols = [r[1] for r in res]
            if "user_id" not in cols:
                conn.execute(
                    text("ALTER TABLE sky_art_drawings ADD COLUMN user_id VARCHAR(100)")
                )
                conn.execute(
                    text(
                        "CREATE INDEX IF NOT EXISTS idx_sky_art_user_id ON sky_art_drawings (user_id)"
                    )
                )
                conn.commit()
            if "ip_address" not in cols:
                conn.execute(
                    text(
                        "ALTER TABLE sky_art_drawings ADD COLUMN ip_address VARCHAR(50)"
                    )
                )
                conn.execute(
                    text(
                        "CREATE INDEX IF NOT EXISTS idx_sky_art_ip_address ON sky_art_drawings (ip_address)"
                    )
                )
                conn.commit()
            if "base_contours_json" not in cols:
                conn.execute(
                    text(
                        "ALTER TABLE sky_art_drawings ADD COLUMN base_contours_json TEXT"
                    )
                )
                conn.commit()
    except Exception as e:
        app.logger.warning(f"DB migration check: {e}")


# --- Airport Search Service ---
_airports_summary_cache = None


def get_airports_summary_list():
    global _airports_summary_cache
    if _airports_summary_cache is None:
        try:
            path = os.path.join(BASE_DIR, "data", "airports_summary.json")
            if os.path.exists(path):
                with open(path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    if isinstance(data, dict):
                        _airports_summary_cache = data.get("airports", [])
                    elif isinstance(data, list):
                        _airports_summary_cache = data
                    else:
                        _airports_summary_cache = []
            else:
                _airports_summary_cache = []
        except Exception as e:
            app.logger.error(f"Error loading airports_summary: {e}")
            _airports_summary_cache = []
    return _airports_summary_cache


@app.route("/")
@app.route("/sky_art")
@app.route("/flight_art")
def index():
    return render_template("index.html")


def _airport_type_rank(atype):
    if atype == "large_airport":
        return 0
    if atype == "medium_airport":
        return 1
    if atype == "small_airport":
        return 2
    if atype == "seaplane_base":
        return 3
    return 4


@app.route("/api/airports/search", methods=["GET"])
def api_airports_search():
    """
    Search for worldwide international and domestic airports by:
    - IATA 3-letter code (e.g. LHR, CDG, SFO, SYD)
    - ICAO 4-letter code (e.g. EGLL, LFPG, KSFO, YSSY)
    - FAA / local code (e.g. E16, SQL)
    - City / Municipality (e.g. London, Paris, Tokyo, Sydney)
    - Airport Name (e.g. Heathrow, Charles de Gaulle, San Martin)
    - Country Name or Country Code (e.g. United Kingdom, France, Australia, GB, FR, AU)
    """
    q = request.args.get("q", "").strip().upper()
    if not q or len(q) < 2:
        return jsonify([])

    airports = get_airports_summary_list()
    scored = []

    for ap in airports:
        icao = (ap.get("icao") or "").upper()
        iata = (ap.get("iata") or "").upper()
        faa = (ap.get("faa") or "").upper()
        name = (ap.get("name") or "").upper()
        city = (ap.get("city") or "").upper()
        clean_city = city.split("(")[0].strip()
        country = (ap.get("country") or "").upper()
        country_name = (ap.get("country_name") or "").upper()
        keywords = (ap.get("keywords") or "").upper()
        tr = _airport_type_rank(ap.get("type", ""))

        score = None
        # 0. Exact IATA code match
        if q == iata:
            score = (0, tr, name)
        # 1. Exact ICAO or FAA code match
        elif q == icao or q == faa:
            score = (1, tr, name)
        # 2. US 3-letter to K-prefix or vice versa (e.g. SFO -> KSFO, KSFO -> SFO)
        elif len(q) == 3 and (icao == "K" + q or faa == "K" + q):
            score = (2, tr, name)
        elif len(q) == 4 and q.startswith("K") and (iata == q[1:] or faa == q[1:]):
            score = (2, tr, name)
        # 3. Exact city match (base city name)
        elif q == clean_city or q == city:
            score = (3, tr, name)
        # 4. Code prefix matches
        elif iata.startswith(q):
            score = (4, tr, name)
        elif icao.startswith(q) or faa.startswith(q):
            score = (5, tr, name)
        # 5. Exact Country code or full Country name
        elif q == country or q == country_name:
            score = (6, tr, name)
        # 6. City starts with query
        elif clean_city.startswith(q) or city.startswith(q):
            score = (7, tr, name)
        # 7. Airport Name starts with query
        elif name.startswith(q):
            score = (8, tr, name)
        # 8. Individual word in Name starts with query
        elif any(w.startswith(q) for w in name.split()):
            score = (9, tr, name)
        # 9. Country name starts with query
        elif country_name.startswith(q):
            score = (10, tr, name)
        # 10. Substring in city
        elif q in city:
            score = (11, tr, name)
        # 11. Substring in airport name
        elif q in name:
            score = (12, tr, name)
        # 12. Keywords / metadata match
        elif keywords and (q in [k.strip() for k in keywords.split(",")] or q in keywords):
            score = (13, tr, name)

        if score is not None:
            scored.append((score, ap))

    scored.sort(key=lambda x: x[0])
    results = []
    for _, ap in scored[:15]:
        results.append(
            {
                "icao": ap.get("icao") or ap.get("faa") or ap.get("iata"),
                "iata": ap.get("iata"),
                "faa": ap.get("faa"),
                "name": ap.get("name"),
                "city": ap.get("city"),
                "state": ap.get("state"),
                "country": ap.get("country"),
                "country_name": ap.get("country_name"),
                "type": ap.get("type"),
                "lat": ap.get("lat"),
                "lon": ap.get("lon"),
            }
        )
    return jsonify(results)


@app.route("/api/sky_art/drawings", methods=["GET"])
@app.route("/api/flight_art/drawings", methods=["GET"])
def api_get_sky_art_drawings():
    """Retrieve all saved Sky Art drawings for the current user instance."""
    try:
        uid = getattr(request, "_skyart_user_id", None)
        if not uid:
            return jsonify([])
        drawings = (
            SkyArtDrawing.query.filter_by(user_id=uid)
            .order_by(SkyArtDrawing.created_at.desc())
            .all()
        )
        return jsonify([d.to_dict() for d in drawings])
    except Exception as e:
        app.logger.error(f"Error fetching sky art drawings: {e}")
        return jsonify([]), 500


@app.route("/api/sky_art/drawings", methods=["POST"])
@app.route("/api/flight_art/drawings", methods=["POST"])
def api_save_sky_art_drawing():
    """Save or update a Sky Art drawing for the current user instance."""
    try:
        uid = getattr(request, "_skyart_user_id", None)
        if not uid:
            return (
                jsonify(
                    {
                        "status": "error",
                        "message": "Missing user instance identification",
                    }
                ),
                400,
            )

        data = request.get_json(silent=True) or {}
        name = (data.get("name") or "").strip()
        if not name:
            name = f"Drawing {datetime.now().strftime('%b %d, %H:%M')}"

        drawing_id = data.get("id")
        if not drawing_id:
            drawing_id = f"art_{int(time.time() * 1000)}"

        base_points = data.get("basePoints") or []
        if not base_points or len(base_points) < 2:
            return (
                jsonify({"status": "error", "message": "At least 2 points required"}),
                400,
            )

        drawing = db.session.get(SkyArtDrawing, drawing_id)
        if not drawing:
            drawing = SkyArtDrawing(id=drawing_id, user_id=uid)
            db.session.add(drawing)
        elif drawing.user_id and drawing.user_id != uid:
            return jsonify({"status": "error", "message": "Unauthorized"}), 403

        client_ip = getattr(request, "_client_ip", None) or get_client_ip()
        drawing.name = name
        drawing.user_id = uid
        drawing.ip_address = client_ip
        drawing.aspect_ratio = float(data.get("aspectRatio") or 1.0)
        drawing.size_nm = float(data.get("sizeNM") or 12.0)
        drawing.height_nm = float(data.get("heightNM") or 12.0)
        drawing.lock_aspect = bool(data.get("lockAspect", True))
        drawing.route_reversed = bool(data.get("routeReversed", False))
        drawing.point_count = len(base_points)
        drawing.base_points_json = json.dumps(base_points)
        base_contours = data.get("baseContours")
        if base_contours and isinstance(base_contours, list):
            drawing.base_contours_json = json.dumps(base_contours)
        else:
            drawing.base_contours_json = None

        db.session.commit()
        # Server-side logging of saved art name associated with client IP address
        app.logger.info(
            f'[SAVED ART] IP: {client_ip} | Art Name: "{drawing.name}" | ID: {drawing.id} | User: {uid}'
        )
        return jsonify({"status": "success", "drawing": drawing.to_dict()})
    except Exception as e:
        db.session.rollback()
        app.logger.error(f"Error saving sky art drawing: {e}")
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route("/api/sky_art/drawings/<drawing_id>", methods=["DELETE", "POST"])
@app.route("/api/flight_art/drawings/<drawing_id>", methods=["DELETE", "POST"])
def api_delete_sky_art_drawing(drawing_id):
    """Delete a saved Sky Art drawing for the current user instance."""
    try:
        uid = getattr(request, "_skyart_user_id", None)
        drawing = db.session.get(SkyArtDrawing, drawing_id)
        if drawing:
            if drawing.user_id and drawing.user_id != uid:
                return jsonify({"status": "error", "message": "Unauthorized"}), 403
            client_ip = getattr(request, "_client_ip", None) or get_client_ip()
            art_name = drawing.name
            db.session.delete(drawing)
            db.session.commit()
            app.logger.info(
                f'[DELETED ART] IP: {client_ip} | Art Name: "{art_name}" | ID: {drawing_id} | User: {uid}'
            )
            return jsonify({"status": "success"})
        return jsonify({"status": "not_found"}), 404
    except Exception as e:
        db.session.rollback()
        app.logger.error(f"Error deleting sky art drawing {drawing_id}: {e}")
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route("/api/sky_art/home_airport", methods=["GET"])
@app.route("/api/flight_art/home_airport", methods=["GET"])
def api_get_home_airport():
    """Retrieve the configured Home Airport for the current user instance."""
    try:
        uid = getattr(request, "_skyart_user_id", None)
        if not uid:
            return jsonify({"status": "not_found", "airport": None})
        record = db.session.get(SkyArtHomeAirport, uid)
        if record:
            return jsonify({"status": "success", "airport": record.to_dict()})
        return jsonify({"status": "not_found", "airport": None})
    except Exception as e:
        app.logger.error(f"Error fetching home airport: {e}")
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route("/api/sky_art/home_airport", methods=["POST"])
@app.route("/api/flight_art/home_airport", methods=["POST"])
def api_save_home_airport():
    """Save or update the configured Home Airport for the current user instance."""
    try:
        uid = getattr(request, "_skyart_user_id", None)
        if not uid:
            return jsonify({"status": "error", "message": "Missing user instance"}), 400

        data = request.get_json(silent=True) or {}
        icao = (data.get("icao") or data.get("faa") or "").strip().upper()
        name = (data.get("name") or icao).strip()
        lat = data.get("lat")
        lon = data.get("lon")

        if not icao or lat is None or lon is None:
            return (
                jsonify(
                    {"status": "error", "message": "Missing required airport fields"}
                ),
                400,
            )

        lat = float(lat)
        lon = float(lon)

        record = db.session.get(SkyArtHomeAirport, uid)
        if record:
            record.icao = icao
            record.name = name
            record.lat = lat
            record.lon = lon
            record.updated_at = datetime.now(timezone.utc)
        else:
            record = SkyArtHomeAirport(
                user_id=uid,
                icao=icao,
                name=name,
                lat=lat,
                lon=lon,
                updated_at=datetime.now(timezone.utc),
            )
            db.session.add(record)

        db.session.commit()
        return jsonify({"status": "success", "airport": record.to_dict()})
    except Exception as e:
        db.session.rollback()
        app.logger.error(f"Error saving home airport: {e}")
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route("/api/sky_art/export_fpl", methods=["POST"])
@app.route("/api/flight_art/export_fpl", methods=["POST"])
def api_sky_art_export_fpl():
    """Generates a downloadable ForeFlight/Garmin XML Flight Plan (.fpl)."""
    try:
        data = request.get_json(silent=True) or {}
        waypoints = data.get("waypoints", [])
        route_name = data.get("route_name", "SKY_ART")

        now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

        xml_lines = [
            '<?xml version="1.0" encoding="utf-8"?>',
            '<flight-plan xmlns="http://www8.garmin.com/xmlschemas/FlightPlan/v1">',
            f"  <created>{now_iso}</created>",
            "  <waypoint-table>",
        ]

        for wp in waypoints:
            w_id = wp.get("id", "WP")
            w_type = wp.get("type", "USER WAYPOINT")
            c_code = "US" if wp.get("isAirport") else ""
            lat = f"{float(wp.get('lat', 0.0)):.6f}"
            lon = f"{float(wp.get('lon', 0.0)):.6f}"
            comment = wp.get("name", w_id)
            xml_lines.extend(
                [
                    "    <waypoint>",
                    f"      <identifier>{w_id}</identifier>",
                    f"      <type>{w_type}</type>",
                    f"      <country-code>{c_code}</country-code>",
                    f"      <lat>{lat}</lat>",
                    f"      <lon>{lon}</lon>",
                    f"      <comment>{comment}</comment>",
                    "    </waypoint>",
                ]
            )

        xml_lines.extend(
            [
                "  </waypoint-table>",
                "  <route>",
                f"    <route-name>{route_name}</route-name>",
                "    <flight-plan-index>1</flight-plan-index>",
            ]
        )

        for wp in waypoints:
            w_id = wp.get("id", "WP")
            w_type = wp.get("type", "USER WAYPOINT")
            xml_lines.extend(
                [
                    "    <route-point>",
                    f"      <waypoint-identifier>{w_id}</waypoint-identifier>",
                    f"      <waypoint-type>{w_type}</waypoint-type>",
                ]
            )
            if wp.get("isAirport"):
                xml_lines.append("      <country-code>US</country-code>")
            xml_lines.append("    </route-point>")

        xml_lines.extend(["  </route>", "</flight-plan>"])
        xml_content = "\n".join(xml_lines)

        resp = make_response(xml_content)
        resp.headers["Content-Type"] = "application/xml"
        resp.headers["Content-Disposition"] = f"attachment; filename={route_name}.fpl"
        return resp
    except Exception as e:
        return jsonify({"error": str(e)}), 400


@app.route("/api/sky_art/export_gpx", methods=["POST"])
@app.route("/api/flight_art/export_gpx", methods=["POST"])
def api_sky_art_export_gpx():
    """Generates a downloadable GPX flight plan."""
    try:
        data = request.get_json(silent=True) or {}
        waypoints = data.get("waypoints", [])
        route_name = data.get("route_name", "Sky Art")

        xml_lines = [
            '<?xml version="1.0" encoding="UTF-8"?>',
            '<gpx version="1.1" creator="Sky Art Planner" xmlns="http://www.topografix.com/GPX/1/1">',
            f"  <metadata><name>{route_name}</name></metadata>",
            "  <rte>",
            f"    <name>{route_name}</name>",
        ]

        for wp in waypoints:
            lat = f"{float(wp.get('lat', 0.0)):.6f}"
            lon = f"{float(wp.get('lon', 0.0)):.6f}"
            w_id = wp.get("id", "WP")
            w_name = wp.get("name", w_id)
            xml_lines.extend(
                [
                    f'    <rtept lat="{lat}" lon="{lon}">',
                    f"      <name>{w_id}</name>",
                    f"      <desc>{w_name}</desc>",
                    "    </rtept>",
                ]
            )

        xml_lines.extend(["  </rte>", "</gpx>"])
        xml_content = "\n".join(xml_lines)

        resp = make_response(xml_content)
        resp.headers["Content-Type"] = "application/gpx+xml"
        resp.headers["Content-Disposition"] = f"attachment; filename={route_name}.gpx"
        return resp
    except Exception as e:
        return jsonify({"error": str(e)}), 400


@app.route("/api/sky_art/export_kml", methods=["POST"])
@app.route("/api/flight_art/export_kml", methods=["POST"])
def api_sky_art_export_kml():
    """Generates a downloadable KML flight plan path."""
    try:
        data = request.get_json(silent=True) or {}
        waypoints = data.get("waypoints", [])
        route_name = data.get("route_name", "Sky Art")

        xml_lines = [
            '<?xml version="1.0" encoding="UTF-8"?>',
            '<kml xmlns="http://www.opengis.net/kml/2.2">',
            "  <Document>",
            f"    <name>{route_name}</name>",
            "    <Placemark>",
            f"      <name>{route_name} Path</name>",
            "      <LineString>",
            "        <tessellate>1</tessellate>",
            "        <coordinates>",
        ]

        for wp in waypoints:
            lat = f"{float(wp.get('lat', 0.0)):.6f}"
            lon = f"{float(wp.get('lon', 0.0)):.6f}"
            xml_lines.append(f"          {lon},{lat},0")

        xml_lines.extend(
            [
                "        </coordinates>",
                "      </LineString>",
                "    </Placemark>",
                "  </Document>",
                "</kml>",
            ]
        )
        xml_content = "\n".join(xml_lines)

        resp = make_response(xml_content)
        resp.headers["Content-Type"] = "application/vnd.google-earth.kml+xml"
        resp.headers["Content-Disposition"] = f"attachment; filename={route_name}.kml"
        return resp
    except Exception as e:
        return jsonify({"error": str(e)}), 400


@app.route("/api/sky_art/feedback", methods=["POST"])
def api_sky_art_feedback():
    """
    Submits user feedback, persists to database & server log,
    and sends an email to vans.rv7.pilot@gmail.com with subject 'SkyArt Feedback'.
    """
    try:
        data = request.get_json(silent=True) or {}
        message = (data.get("message") or "").strip()
        if not message:
            return jsonify({"error": "Feedback message cannot be empty."}), 400

        sender_email = (data.get("email") or "").strip()
        if sender_email:
            email_regex = re.compile(r"^[^@\s]+@[^@\s]+\.[a-zA-Z0-9-]{2,}$")
            if "@" not in sender_email or not email_regex.match(sender_email):
                return jsonify({"error": "Please enter a valid email address with an '@' symbol (e.g. pilot@example.com) or leave it blank."}), 400

        sender_name = (data.get("name") or "").strip()
        category = (data.get("category") or "General").strip()
        subject = (data.get("subject") or "SkyArt Feedback").strip()
        if not subject:
            subject = "SkyArt Feedback"

        diagnostics = data.get("diagnostics")
        diag_json = json.dumps(diagnostics) if diagnostics else None

        client_ip = getattr(request, "_client_ip", None) or get_client_ip()
        uid = getattr(request, "_skyart_user_id", None)

        feedback = SkyArtFeedback(
            user_id=uid,
            ip_address=client_ip,
            sender_name=sender_name or None,
            sender_email=sender_email or None,
            category=category,
            subject=subject,
            message=message,
            diagnostics_json=diag_json,
            email_status="pending",
        )
        db.session.add(feedback)
        db.session.commit()

        app.logger.info(
            f"[FEEDBACK] Received feedback from '{sender_name}' <{sender_email}> | Subject: '{subject}' | Category: {category} | IP: {client_ip} | Message: {message[:120]}"
        )

        recipient = "vans.rv7.pilot@gmail.com"
        email_sent = False
        email_error = None

        # Compose full plaintext email body
        body_lines = [
            "SkyArt Flight Art Generator - User Feedback",
            "=" * 50,
            f"Subject: {subject}",
            f"From: {sender_name or 'Anonymous'} ({sender_email or 'No email provided'})",
            f"Category: {category}",
            f"User ID: {uid or 'Unknown'}",
            f"Client IP: {client_ip}",
            f"Timestamp: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}",
            "",
            "Feedback Message:",
            "-" * 50,
            message,
            "-" * 50,
        ]
        if diagnostics and isinstance(diagnostics, dict):
            body_lines.extend([
                "",
                "Client & Flight Plan Diagnostics:",
                "-" * 50,
            ])
            for k, v in diagnostics.items():
                body_lines.append(f"  • {k}: {v}")

        email_full_text = "\n".join(body_lines)

        # Attempt sending email via configured SMTP (e.g. Gmail App Password or custom SMTP server)
        smtp_user = os.environ.get("SMTP_USER")
        smtp_pass = os.environ.get("SMTP_PASSWORD")
        smtp_host = os.environ.get("SMTP_HOST", "smtp.gmail.com")
        smtp_port = int(os.environ.get("SMTP_PORT", 587))

        if smtp_user and smtp_pass:
            try:
                import smtplib
                from email.mime.text import MIMEText
                from email.mime.multipart import MIMEMultipart

                msg = MIMEMultipart()
                msg["From"] = smtp_user
                msg["To"] = recipient
                msg["Subject"] = subject
                if sender_email:
                    msg["Reply-To"] = sender_email

                msg.attach(MIMEText(email_full_text, "plain", "utf-8"))

                with smtplib.SMTP(smtp_host, smtp_port, timeout=10) as server:
                    server.starttls()
                    server.login(smtp_user, smtp_pass)
                    server.send_message(msg)
                    email_sent = True
                    feedback.email_status = "sent_smtp"
                    db.session.commit()
                    app.logger.info(f"[FEEDBACK] Email successfully sent to {recipient} via SMTP")
            except Exception as e:
                email_error = str(e)
                feedback.email_status = f"failed_smtp: {str(e)[:60]}"
                db.session.commit()
                app.logger.error(f"[FEEDBACK] Failed to send email via SMTP: {e}")
        else:
            feedback.email_status = "saved_no_smtp"
            db.session.commit()

        # Build mailto URL for direct email client fallback
        mailto_body = f"From: {sender_name or 'Pilot'} ({sender_email or 'no email'})\nCategory: {category}\n\n{message}"
        if diagnostics and isinstance(diagnostics, dict):
            diag_summary = ", ".join(f"{k}={v}" for k, v in list(diagnostics.items())[:6])
            mailto_body += f"\n\n[Diagnostics: {diag_summary}]"

        mailto_query = urllib.parse.urlencode({
            "subject": subject,
            "body": mailto_body
        }, quote_via=urllib.parse.quote)
        mailto_url = f"mailto:{recipient}?{mailto_query}"

        return jsonify({
            "success": True,
            "saved": True,
            "id": feedback.id,
            "email_sent": email_sent,
            "recipient": recipient,
            "subject": subject,
            "mailto_url": mailto_url,
            "error": email_error,
            "message": "Feedback received and saved successfully!"
        })
    except Exception as ex:
        app.logger.error(f"[FEEDBACK ERROR] {ex}", exc_info=True)
        return jsonify({"error": str(ex)}), 500


@app.route("/favicon.ico")
def favicon():
    """Serves the SkyArt vector favicon."""
    return app.send_static_file("favicon.svg")


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5005))
    debug = os.environ.get("FLASK_DEBUG", "True").lower() in ("true", "1", "yes")
    app.run(host="0.0.0.0", port=port, debug=debug)
