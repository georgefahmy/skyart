# 🎨 SkyArt - GPS Flight Art & ForeFlight Flight Plan Generator

A standalone web application for designing, transforming, and projecting GPS sky art routes onto aeronautical charts, and exporting them directly into **ForeFlight** (`.fpl`), **Garmin**, **GPX**, and **Google Earth** (`.kml`).

---

## 📖 User Guide & Feature Manual

### 1. 🚀 Quick Start in 3 Easy Steps
1. **Choose or Draw Art:** Pick a preset shape (e.g. RV-7 Airplane, Heart, Star, Clover), click **Freehand Draw** to sketch directly on the map, or click **Import Image** to trace an image.
2. **Position & Scale:** Drag the **orange diamond anchor pin** to move your drawing over your desired airspace. Use the sliders to adjust scale (Width & Height in NM) and rotation (0° – 360°).
3. **Export & Fly:** Click **Open in ForeFlight**, scan the **QR Code** with your iPad or iPhone camera, or download a **Garmin FPL / GPX** file to load into your cockpit GPS.

---

### 2. 🎨 Drawing & Image Import
- **Preset Shapes:** 1-click loading for Airplane (RV-7), Heart, Star, Clover, Diamond, Smooth Circle, and "FLY" text.
- **Freehand Drawing Mode:** Click "Freehand Draw Mode", then draw directly on the map using your mouse, trackpad, or touchscreen. Releasing automatically smooths the route, closes closed contours, and generates GPS waypoints.
- **Image Import & Vectorization (PNG, JPG, SVG, iPhone HEIC):**
  - **Trace by Hand (Overlay):** Places the uploaded image as a semi-transparent tracing lightbox directly onto the map (at 50% default opacity with click-through enabled). Pilots can immediately freehand draw or click waypoints right on top of their own custom images, logos, or sketches. Features live opacity control (10%–100%), visibility toggle, high-contrast inversion, and synchronized scaling/translation/rotation.
  - **Outline Contour:** Traces only the outer perimeter silhouette of the image.
  - **Single Stroke Path:** Specifically engineered for coloring book pages, sketches, and line drawings. Instead of generating double lines around thick pen strokes, it extracts a single continuous center flight path.
  - **All Vectors:** Captures all interior and exterior line segments for detailed multi-stroke drawings.
  - **Detail Threshold Slider:** Controls how much fine detail to capture versus broad simplified lines.
  - **Invert Colors:** Inverts dark lines on white paper versus white lines on dark backgrounds.

---

### 3. 📍 Map & Waypoint Tools
- **Orange Diamond Center Pin:** Drag to translate the entire drawing anywhere in the world.
- **Scale (NM) & Aspect Ratio Lock:** Resize width and height independently or lock them with the chain icon.
- **Rotation (0° – 360°):** Spin the art to avoid controlled airspace, align with runways, or match prevailing winds.
- **Reverse Route:** Instantly toggle between flying clockwise or counter-clockwise.
- **99-Waypoint Ceiling:** Automatically simplifies and enforces the 99-waypoint limit required by Garmin GTN/G1000 avionics and ForeFlight navigators.
- **Drag Waypoints:** Drag any numbered marker to fine-tune individual legs around towers, terrain, or airspace.
- **Insert Waypoints:** Click any `+` midpoint handle between waypoints, or click directly on the blue route line.
- **Delete Waypoints:** Right-click on any waypoint marker to remove it.
- **Smart Tooltips:** Hover over any marker to see coordinates, incoming/outgoing leg distances in NM, compass tracks (°), turn angles, and autopilot cutoff distances.

---

### 4. ✈️ Autopilot & Corner Smoothing
- **Lead-Turn Corner Rounding Simulation (Orange Dashed Line):** Standard autopilots fly "fly-by" turns, rolling into turns before reaching waypoints. The orange dashed line shows the exact curved flight path your autopilot will fly.
- **Turn Radius Slider (0.2 – 2.5 NM):** Tune the turn radius to match your aircraft's cruise speed and bank angle (default ~1.0 NM for 120–140 kt cruise).
- **Leg Length Clamping:** If an intermediate leg is too short for a full turn, SkyArt automatically clamps the radius to fit the leg, flagging it as `[clamped]` in tooltips.
- **Exterior Corner Loop-Backs:** Automatically inserts teardrop/circular loops for turns sharper than 60°. The aircraft sweeps outside the corner and passes cleanly through the vertex, keeping drawings razor-sharp on FlightAware and FlightRadar24!
- **Individual Corner Overrides:** Click any corner marker directly on the map to toggle loop-backs on or off for that specific corner.

---

### 5. 🛫 Airports & Transit Routing
- **Airport Search:** Fast search across all FAA/ICAO airports by identifier (e.g. `E16`, `KPAO`, `KOSH`), name, or city.
- **Home Base Configuration:** Save your home airport so it automatically loads on every visit.
- **Connected Departure & Arrival Transits:** Automatically draws dashed transit lines from your departure runway to the start of the art, and from the finish back to your arrival airfield.
- **Smart Entry/Exit Routing:** Automatically determines the best entry vertex so transit legs never slice through the center of your artwork.

---

### 6. 📊 Aircraft Performance & Telemetry
- **Live Flight HUD:** Real-time calculation of Artwork Distance, Total Distance (with transits), Estimated Time En Route (ETE), Fuel Required, and Waypoint Count.
- **Customizable Performance:** Set your aircraft's True Airspeed (KTAS) and Fuel Burn (GPH) to get accurate time and fuel calculations.

---

### 7. 📲 ForeFlight & GPS Export
- **Open in ForeFlight:** 1-click button to open ForeFlight Mobile on iOS/iPadOS with the complete route pre-loaded.
- **ForeFlight QR Code:** Scan the screen using your iPad/iPhone camera to import the flight plan wirelessly over the air.
- **Garmin XML (.fpl):** Official flight plan format for Garmin Pilot, GTN 650/750, G3X, or G1000 navigators.
- **GPX (.gpx):** Standard GPS exchange format for handheld navigators and flight trackers.
- **Google Earth (.kml):** 3D interactive flight path for Google Earth and debriefing in CloudAhoy.
- **Copy Route String:** Text coordinates for filing VFR flight plans with 1800wxbrief / Leidos.
- **Save to Presets:** Name and save custom drawings to your personal preset library.

---

### 8. 💡 Pro Pilot Tips
- Always check NOTAMs, TFRs, and local Class B/C/D airspace before flying.
- Fly early in the morning or late afternoon for the smoothest air and cleanest GPS tracks.
- Request VFR Flight Following with ATC and advise them you are flying planned GPS maneuvers.
- Couple your autopilot in GPSS / NAV mode to crab for winds and maintain exact ground tracks.

---

### 9. ✉️ Feedback & Support Form
- Accessible directly within the in-app **Help & User Guide** (`?` icon in the top header).
- Pilots can submit suggestions, report bugs, request avionics features, or ask questions.
- Form submissions are sent directly to **`vans.rv7.pilot@gmail.com`** with the subject line **`SkyArt Feedback`**, and are archived safely in the server database and access logs.
- Includes 1-click fallback to open the pre-filled draft in your personal desktop or mobile email application.

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
