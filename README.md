# 🎨 SkyArt - GPS Flight Art & ForeFlight Flight Plan Generator

A standalone web application for designing, transforming, and projecting GPS sky art routes onto aeronautical charts, and exporting them directly into **ForeFlight** (`.fpl`), **Garmin**, **GPX**, and **Google Earth** (`.kml`).

---

## Features

- **Interactive Vector & Shape Studio**:
  - Library of aviation presets (Airplane, Heart, Star, Clover, Infinity, spirals, etc.).
  - Text-to-Flight-Path generator using vector strokes with configurable letter height, spacing, and font styles.
  - Image Import & Vector Tracing (PNG, JPEG, HEIC/HEIF) with adaptive edge detection, contrast thresholding, and smoothing.
  - Freehand drawing mode directly onto the map with touch, stylus, or mouse.
- **Flight Planning & Navigation**:
  - Live spatial transformations: scale (NM), lock/unlock aspect ratio, rotate, and drag anchor point anywhere on Earth.
  - Real-time flight telemetry estimates: total track distance, leg count, flight time at configured True Airspeed (TAS), and fuel burn based on GPH.
  - Direct airport departure and arrival connecting legs.
  - Searchable US airport and navaid database.
- **Unified Aeronautical Map & Ultra-Smooth Zoom**:
  - Multiple base layers: OpenStreetMap (default), Aero Midnight (Dark), Aviation VFR (Light), and Satellite Imagery.
  - Speed-ramped continuous fractional zooming (`zoomSnap: 0`) with inertial momentum deceleration and zero-pop tile buffering.
- **Direct ForeFlight / Pilot Export**:
  - **ForeFlight & Garmin XML** (`.fpl`): One-click download or instant iPad/iPhone QR code scanning.
  - **GPX format** (`.gpx`) for handheld GPS navigators and avionics.
  - **Google Earth** (`.kml`) for 3D visualization.
  - Local database preset saving to store and reload your favorite flight art routes.

---

## Quick Start (Local Run)

1. **Clone the repository**:
   ```bash
   git clone <repo-url> sky_art
   cd sky_art
   ```

2. **Install dependencies**:
   ```bash
   python3 -m venv venv
   source venv/bin/activate
   pip install -r requirements.txt
   ```

3. **Run the server**:
   ```bash
   python3 app.py
   # Or use the runner script:
   ./run.sh
   ```

4. Open your browser at **`http://localhost:5005`**.

---

## Hosting on a Linux Server (Systemd + Gunicorn)

1. Copy or clone the project to your server directory (e.g. `/home/georgefahmy/Documents/sky_art`).
2. Copy the systemd service file:
   ```bash
   sudo cp sky-art.service /etc/systemd/system/sky-art.service
   sudo systemctl daemon-reload
   sudo systemctl enable sky-art
   sudo systemctl start sky-art
   ```
3. Check status:
   ```bash
   sudo systemctl status sky-art
   ```

---

## Architecture & Tech Stack

- **Backend**: Python 3, Flask, Flask-SQLAlchemy (SQLite)
- **Frontend**: Leaflet 1.9.4, Bootstrap 5, Bootstrap Icons, QRCode.js, Heic2Any
- **Airport Dataset**: Bundled `data/airports_summary.json` for offline-capable fast ICAO/FAA/city search
