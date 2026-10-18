/**
 * Flight Art / Sky Art Generator & ForeFlight Exporter
 * Interactive map drawing, vector SVG & transparent PNG import,
 * spatial transformation, and ForeFlight flight plan generation.
 */

(function () {
    'use strict';

    // --- User Instance Identification ---
    const USER_ID_STORAGE_KEY = 'sky_art_user_instance_id';

    function getUserInstanceId() {
        let uid = null;
        try {
            uid = localStorage.getItem(USER_ID_STORAGE_KEY);
        } catch (e) {}

        if (!uid) {
            const match = document.cookie.match(/(?:^|;\s*)skyart_uid=([^;]+)/);
            if (match && match[1]) {
                uid = decodeURIComponent(match[1]);
            } else {
                uid = 'usr_' + (window.crypto && crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : (Date.now().toString(36) + Math.random().toString(36).substring(2)));
            }
            try {
                localStorage.setItem(USER_ID_STORAGE_KEY, uid);
            } catch (e) {}
        }
        return uid;
    }

    function getApiHeaders(extra = {}) {
        return {
            'X-User-ID': getUserInstanceId(),
            ...extra
        };
    }

    // Default Home Airport: E16 (San Martin Airport, CA)
    const DEFAULT_HOME_AIRPORT = {
        icao: 'E16',
        faa: 'E16',
        name: 'San Martin Airport',
        lat: 37.0816,
        lon: -121.5970
    };

    const HOME_AIRPORT_STORAGE_KEY = 'sky_art_home_airport';
    const LEGACY_HOME_AIRPORT_STORAGE_KEY = 'flight_art_home_airport';

    function getUserHomeAirportStorageKey() {
        return HOME_AIRPORT_STORAGE_KEY + '_' + getUserInstanceId();
    }

    function loadConfiguredHomeAirport() {
        try {
            const userKey = getUserHomeAirportStorageKey();
            let saved = localStorage.getItem(userKey);
            if (!saved) {
                saved = localStorage.getItem(HOME_AIRPORT_STORAGE_KEY) || localStorage.getItem(LEGACY_HOME_AIRPORT_STORAGE_KEY);
                if (saved) {
                    try {
                        localStorage.setItem(userKey, saved);
                    } catch (e) {}
                }
            }
            if (saved) {
                const parsed = JSON.parse(saved);
                if (parsed && (parsed.icao || parsed.faa) && !isNaN(parsed.lat) && !isNaN(parsed.lon)) {
                    return parsed;
                }
            }
        } catch (e) {
            console.error("Error loading home airport from localStorage:", e);
        }
        return { ...DEFAULT_HOME_AIRPORT };
    }

    function saveConfiguredHomeAirport(airportObj, skipServerSync = false) {
        if (!airportObj) return;
        try {
            localStorage.setItem(getUserHomeAirportStorageKey(), JSON.stringify(airportObj));
        } catch (e) {
            console.error("Error saving home airport to localStorage:", e);
        }
        ArtState.homeAirport = airportObj;
        updateHomeAirportUI();

        if (!skipServerSync) {
            fetch('/api/sky_art/home_airport', {
                method: 'POST',
                headers: getApiHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({
                    icao: airportObj.icao || airportObj.faa,
                    name: airportObj.name,
                    lat: airportObj.lat,
                    lon: airportObj.lon
                })
            }).catch(e => {
                console.warn("Error syncing home airport with server:", e);
            });
        }
    }

    async function syncHomeAirportWithServer() {
        try {
            const res = await fetch('/api/sky_art/home_airport', {
                headers: getApiHeaders()
            });
            if (res.ok) {
                const data = await res.json();
                if (data && data.status === 'success' && data.airport) {
                    const serverAp = data.airport;
                    saveConfiguredHomeAirport(serverAp, true);
                    return;
                }
            }
            // If server doesn't have it yet, but user has customized local storage, push to server
            const localHome = loadConfiguredHomeAirport();
            if (localHome && (localHome.icao !== DEFAULT_HOME_AIRPORT.icao || localHome.lat !== DEFAULT_HOME_AIRPORT.lat)) {
                fetch('/api/sky_art/home_airport', {
                    method: 'POST',
                    headers: getApiHeaders({ 'Content-Type': 'application/json' }),
                    body: JSON.stringify({
                        icao: localHome.icao || localHome.faa,
                        name: localHome.name,
                        lat: localHome.lat,
                        lon: localHome.lon
                    })
                }).catch(e => console.warn("Background home airport upload error:", e));
            }
        } catch (err) {
            console.warn("Could not sync home airport with server (using local cache):", err);
        }
    }

    const initialHome = loadConfiguredHomeAirport();

    // --- State Management ---
    const ArtState = {
        map: null,
        layers: {
            osm: null,
            cartoDark: null,
            cartoVoyager: null,
            satellite: null
        },
        homeAirport: initialHome,
        basePoints: [],        // Normalized points in [-0.5, 0.5] space
        baseContours: null,    // Normalized sub-contours [[{x, y}], ...]
        rawProjectedPoints: [],// Latitude/Longitude points before simplification
        rawProjectedContours: null, // Latitude/Longitude points per contour
        projectedPoints: [],   // Active simplified flight path [{lat, lon}]
        waypoints: [],         // Full flight plan route including airport transit
        center: { lat: initialHome.lat, lon: initialHome.lon },
        sizeNM: 12,            // Width in Nautical Miles
        heightNM: 12,          // Height in Nautical Miles
        lockAspect: true,      // Proportional width & height link
        rotationDeg: 0,        // Heading rotation (0-359 deg)
        flipH: false,
        flipV: false,
        aspectRatio: 1.0,
        simplificationTolerance: 0.015, // RDP epsilon
        cruiseSpeedKts: 150,   // RV-7 default cruise speed
        fuelFlowGPH: 8.5,      // RV-7 default fuel burn
        includeAirport: true,
        optimizeEntryExit: true, // Auto-optimize start/end waypoint for shortest transit
        routeReversed: false,    // Reverse traversal direction
        depAirport: { ...initialHome },
        arrAirport: { ...initialHome },
        drawMode: false,       // Freehand drawing mode active
        clickMode: false,      // Waypoint click mode active
        isDrawing: false,
        currentFreehandPoints: [],
        sourceType: 'preset',  // 'preset' | 'text' | 'import' | 'saved' | 'freehand'
        strokeCount: 0,        // Count of connected freehand strokes
        smartConnect: true,    // Smart multi-stroke connection active
        mapMarkers: [],
        midpointMarkers: [],
        centerMarker: null,
        routePolyline: null,
        transitPolylineDep: null,
        transitPolylineArr: null,
        tempFreehandPolyline: null,
        autopilotTurnRadiusNM: 1.0,
        autopilotMinAngleDeg: 60,
        showAutopilotGhost: false,
        enableCornerLoopBacks: false,
        cornerLoopOverrides: {},
        autopilotGhostPolyline: null,
        loopBackMarkers: [],
        showWaypointIndicators: true,
        lastUploadedFile: null,
        lastDecodedImage: null,
        maxWaypoints: 99,
        enforceMaxWaypoints: true
    };

    // --- History Manager (Undo / Redo) ---
    const HistoryManager = {
        undoStack: [],
        redoStack: [],
        maxSize: 50,
        isApplying: false,

        captureSnapshot() {
            return {
                basePoints: ArtState.basePoints ? ArtState.basePoints.map(p => ({ x: p.x, y: p.y })) : [],
                baseContours: ArtState.baseContours ? ArtState.baseContours.map(c => c.map(p => ({ x: p.x, y: p.y }))) : null,
                projectedPoints: ArtState.projectedPoints ? ArtState.projectedPoints.map(p => ({ lat: p.lat, lon: p.lon })) : [],
                sizeNM: ArtState.sizeNM,
                heightNM: ArtState.heightNM,
                lockAspect: ArtState.lockAspect,
                aspectRatio: ArtState.aspectRatio,
                rotationDeg: ArtState.rotationDeg,
                flipH: ArtState.flipH,
                flipV: ArtState.flipV,
                center: { ...ArtState.center },
                simplificationTolerance: ArtState.simplificationTolerance,
                optimizeEntryExit: ArtState.optimizeEntryExit,
                routeReversed: ArtState.routeReversed,
                sourceType: ArtState.sourceType,
                strokeCount: ArtState.strokeCount,
                autopilotTurnRadiusNM: ArtState.autopilotTurnRadiusNM,
                autopilotMinAngleDeg: ArtState.autopilotMinAngleDeg,
                showAutopilotGhost: ArtState.showAutopilotGhost,
                enableCornerLoopBacks: ArtState.enableCornerLoopBacks,
                cornerLoopOverrides: { ...ArtState.cornerLoopOverrides }
            };
        },

        pushState() {
            if (this.isApplying) return;
            const snapshot = this.captureSnapshot();
            this.undoStack.push(snapshot);
            if (this.undoStack.length > this.maxSize) {
                this.undoStack.shift();
            }
            this.redoStack = [];
            this.updateButtons();
        },

        undo() {
            if (this.undoStack.length === 0 || this.isApplying) return;
            this.isApplying = true;
            try {
                const current = this.captureSnapshot();
                this.redoStack.push(current);

                const prev = this.undoStack.pop();
                this.restoreSnapshot(prev);
            } finally {
                this.isApplying = false;
                this.updateButtons();
            }
        },

        redo() {
            if (this.redoStack.length === 0 || this.isApplying) return;
            this.isApplying = true;
            try {
                const current = this.captureSnapshot();
                this.undoStack.push(current);

                const next = this.redoStack.pop();
                this.restoreSnapshot(next);
            } finally {
                this.isApplying = false;
                this.updateButtons();
            }
        },

        restoreSnapshot(s) {
            ArtState.basePoints = s.basePoints ? s.basePoints.map(p => ({ x: p.x, y: p.y })) : [];
            ArtState.baseContours = s.baseContours ? s.baseContours.map(c => c.map(p => ({ x: p.x, y: p.y }))) : null;
            ArtState.sizeNM = s.sizeNM ?? 12;
            ArtState.heightNM = s.heightNM ?? 12;
            ArtState.lockAspect = s.lockAspect ?? true;
            ArtState.aspectRatio = s.aspectRatio ?? 1.0;
            ArtState.rotationDeg = s.rotationDeg ?? 0;
            ArtState.flipH = !!s.flipH;
            ArtState.flipV = !!s.flipV;
            ArtState.center = s.center ? { ...s.center } : { ...ArtState.homeAirport };
            ArtState.simplificationTolerance = s.simplificationTolerance ?? 0.015;
            ArtState.optimizeEntryExit = s.optimizeEntryExit ?? true;
            ArtState.routeReversed = s.routeReversed ?? false;
            ArtState.sourceType = s.sourceType || 'freehand';
            ArtState.strokeCount = s.strokeCount ?? 0;
            if (s.autopilotTurnRadiusNM !== undefined) ArtState.autopilotTurnRadiusNM = s.autopilotTurnRadiusNM;
            if (s.autopilotMinAngleDeg !== undefined) ArtState.autopilotMinAngleDeg = s.autopilotMinAngleDeg;
            if (s.showAutopilotGhost !== undefined) ArtState.showAutopilotGhost = !!s.showAutopilotGhost;
            if (s.enableCornerLoopBacks !== undefined) ArtState.enableCornerLoopBacks = !!s.enableCornerLoopBacks;
            if (s.cornerLoopOverrides !== undefined) ArtState.cornerLoopOverrides = { ...s.cornerLoopOverrides };
            updateStrokeCountBadge();

            syncAllControls();
            applyTransformations();
        },

        updateStrokeCountBadge() {
            updateStrokeCountBadge();
        },

        updateButtons() {
            const canUndo = this.undoStack.length > 0;
            const canRedo = this.redoStack.length > 0;

            ['undoBtn', 'mapUndoBtn'].forEach(id => {
                const btn = document.getElementById(id);
                if (btn) {
                    btn.disabled = !canUndo;
                    btn.classList.toggle('disabled', !canUndo);
                }
            });

            ['redoBtn', 'mapRedoBtn'].forEach(id => {
                const btn = document.getElementById(id);
                if (btn) {
                    btn.disabled = !canRedo;
                    btn.classList.toggle('disabled', !canRedo);
                }
            });
        }
    };

    function syncDimensionInputs() {
        const sizeInput = document.getElementById('sizeInput');
        const sizeSlider = document.getElementById('sizeSlider');
        const sizeLabel = document.getElementById('sizeLabel');
        const heightInput = document.getElementById('heightInput');
        const heightSlider = document.getElementById('heightSlider');
        const heightContainer = document.getElementById('heightControlContainer');
        const lockBtn = document.getElementById('aspectLockBtn');
        const lockIcon = document.getElementById('aspectLockIcon');
        const lockLabel = document.getElementById('aspectLockLabel');

        if (sizeInput) sizeInput.value = ArtState.sizeNM;
        if (sizeSlider) sizeSlider.value = ArtState.sizeNM;
        if (heightInput) heightInput.value = ArtState.heightNM;
        if (heightSlider) heightSlider.value = ArtState.heightNM;

        if (sizeLabel) {
            sizeLabel.innerText = ArtState.lockAspect ? 'Size:' : 'Width:';
        }
        if (sizeSlider) {
            sizeSlider.title = ArtState.lockAspect ? 'Adjust size in Nautical Miles' : 'Adjust width in Nautical Miles';
        }

        if (heightContainer) {
            heightContainer.classList.toggle('d-none', !!ArtState.lockAspect);
        }

        if (lockBtn && lockIcon && lockLabel) {
            if (ArtState.lockAspect) {
                lockBtn.classList.remove('btn-outline-warning');
                lockBtn.classList.add('btn-outline-secondary');
                lockIcon.className = 'bi bi-link-45deg text-primary me-1';
                lockLabel.innerText = 'Locked';
                lockBtn.title = 'Scaling is locked proportionally. Click to unlock separate Width & Height sliders.';
            } else {
                lockBtn.classList.remove('btn-outline-secondary');
                lockBtn.classList.add('btn-outline-warning');
                lockIcon.className = 'bi bi-slash-circle text-warning me-1';
                lockLabel.innerText = 'Unlocked';
                lockBtn.title = 'Scaling is unlocked. Click to lock proportional scaling.';
            }
        }
    }

    function updateReverseButtons() {
        ['reverseRouteBtn', 'mapReverseBtn'].forEach(id => {
            const btn = document.getElementById(id);
            if (btn) {
                btn.classList.toggle('active', ArtState.routeReversed);
                if (id === 'reverseRouteBtn') {
                    btn.classList.toggle('btn-primary', ArtState.routeReversed);
                    btn.classList.toggle('btn-outline-secondary', !ArtState.routeReversed);
                } else if (id === 'mapReverseBtn') {
                    btn.classList.toggle('btn-primary', ArtState.routeReversed);
                    btn.classList.toggle('text-white', ArtState.routeReversed);
                    btn.classList.toggle('btn-light', !ArtState.routeReversed);
                }
            }
        });
    }

    function syncAllControls() {
        syncDimensionInputs();
        updateCenterInputs();

        const optCheck = document.getElementById('optimizeEntryExitCheck');
        if (optCheck) optCheck.checked = ArtState.optimizeEntryExit;

        updateReverseButtons();

        const rotSlider = document.getElementById('rotSlider');
        const rotBadge = document.getElementById('rotBadge');
        if (rotSlider) rotSlider.value = ArtState.rotationDeg;
        if (rotBadge) rotBadge.innerText = ArtState.rotationDeg + '°';

        const smoothSlider = document.getElementById('smoothSlider');
        if (smoothSlider) smoothSlider.value = ArtState.simplificationTolerance;

        const flipHBtn = document.getElementById('flipHBtn');
        const flipVBtn = document.getElementById('flipVBtn');
        if (flipHBtn) flipHBtn.classList.toggle('active', ArtState.flipH);
        if (flipVBtn) flipVBtn.classList.toggle('active', ArtState.flipV);

        // Autopilot Controls Sync
        const ghostCheck = document.getElementById('showAutopilotGhostCheck');
        if (ghostCheck) ghostCheck.checked = !!ArtState.showAutopilotGhost;

        const loopCheck = document.getElementById('enableCornerLoopBacksCheck');
        if (loopCheck) loopCheck.checked = !!ArtState.enableCornerLoopBacks;

        const apSlider = document.getElementById('autopilotRadiusSlider');
        if (apSlider) apSlider.value = ArtState.autopilotTurnRadiusNM;

        const apInput = document.getElementById('autopilotRadiusInput');
        if (apInput) apInput.value = ArtState.autopilotTurnRadiusNM.toFixed(1);

        const angleSelect = document.getElementById('autopilotMinAngleSelect');
        if (angleSelect) angleSelect.value = String(ArtState.autopilotMinAngleDeg);

        const mapGhostBtn = document.getElementById('mapAutopilotGhostBtn');
        if (mapGhostBtn) {
            mapGhostBtn.classList.toggle('active', !!ArtState.showAutopilotGhost);
            mapGhostBtn.classList.toggle('btn-warning', !!ArtState.showAutopilotGhost);
            mapGhostBtn.classList.toggle('text-dark', !!ArtState.showAutopilotGhost);
            mapGhostBtn.classList.toggle('btn-light', !ArtState.showAutopilotGhost);
        }

        const mapLoopBtn = document.getElementById('mapLoopBackBtn');
        if (mapLoopBtn) {
            mapLoopBtn.classList.toggle('active', !!ArtState.enableCornerLoopBacks);
            mapLoopBtn.classList.toggle('btn-primary', !!ArtState.enableCornerLoopBacks);
            mapLoopBtn.classList.toggle('text-white', !!ArtState.enableCornerLoopBacks);
            mapLoopBtn.classList.toggle('btn-light', !ArtState.enableCornerLoopBacks);
        }

        const mapWpBtn = document.getElementById('mapToggleWaypointsBtn');
        if (mapWpBtn) {
            const isVisible = ArtState.showWaypointIndicators !== false;
            mapWpBtn.classList.toggle('active', isVisible);
            mapWpBtn.classList.toggle('btn-primary', isVisible);
            mapWpBtn.classList.toggle('text-white', isVisible);
            mapWpBtn.classList.toggle('btn-light', !isVisible);
        }
    }

    // --- Ramer-Douglas-Peucker (RDP) Simplification ---
    function perpendicularDistance(point, lineStart, lineEnd) {
        const dx = lineEnd.x - lineStart.x;
        const dy = lineEnd.y - lineStart.y;
        const mag = Math.hypot(dx, dy);
        if (mag === 0) return Math.hypot(point.x - lineStart.x, point.y - lineStart.y);
        const u = ((point.x - lineStart.x) * dx + (point.y - lineStart.y) * dy) / (mag * mag);
        const clampU = Math.max(0, Math.min(1, u));
        const projX = lineStart.x + clampU * dx;
        const projY = lineStart.y + clampU * dy;
        return Math.hypot(point.x - projX, point.y - projY);
    }

    function ramerDouglasPeucker(points, epsilon) {
        if (!points || points.length <= 2) return points ? [...points] : [];
        let maxDist = 0;
        let index = 0;
        for (let i = 1; i < points.length - 1; i++) {
            const d = perpendicularDistance(points[i], points[0], points[points.length - 1]);
            if (d > maxDist) {
                maxDist = d;
                index = i;
            }
        }
        if (maxDist > epsilon) {
            const left = ramerDouglasPeucker(points.slice(0, index + 1), epsilon);
            const right = ramerDouglasPeucker(points.slice(index), epsilon);
            return left.slice(0, left.length - 1).concat(right);
        } else {
            return [points[0], points[points.length - 1]];
        }
    }

    // --- Great Circle Math ---
    function toRad(deg) { return deg * Math.PI / 180; }
    function toDeg(rad) { return rad * 180 / Math.PI; }

    function calculateDistanceNM(lat1, lon1, lat2, lon2) {
        const R = 3440.065; // Earth radius in Nautical Miles
        const dLat = toRad(lat2 - lat1);
        const dLon = toRad(lon2 - lon1);
        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                  Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
                  Math.sin(dLon / 2) * Math.sin(dLon / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R * c;
    }
    const calcDistanceNM = calculateDistanceNM;

    function calculateBearingDeg(lat1, lon1, lat2, lon2) {
        const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
        const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
                  Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
        const brng = toDeg(Math.atan2(y, x));
        return (brng + 360) % 360;
    }

    function projectLatLng(lat, lon, bearingDeg, distanceNM) {
        const R = 3440.065;
        const dR = distanceNM / R;
        const bRad = toRad(bearingDeg);
        const lat1 = toRad(lat);
        const lon1 = toRad(lon);

        const lat2 = Math.asin(Math.sin(lat1) * Math.cos(dR) + Math.cos(lat1) * Math.sin(dR) * Math.cos(bRad));
        const lon2 = lon1 + Math.atan2(
            Math.sin(bRad) * Math.sin(dR) * Math.cos(lat1),
            Math.cos(dR) - Math.sin(lat1) * Math.sin(lat2)
        );

        return { lat: toDeg(lat2), lon: toDeg(lon2) };
    }

    function normalizeAngleDiff(deg) {
        let diff = (deg + 180) % 360;
        if (diff < 0) diff += 360;
        return diff - 180;
    }

    function analyzeCornerTurn(pPrev, pCorner, pNext, radiusNM = 1.0) {
        const brngIn = calculateBearingDeg(pPrev.lat, pPrev.lon, pCorner.lat, pCorner.lon);
        const brngOut = calculateBearingDeg(pCorner.lat, pCorner.lon, pNext.lat, pNext.lon);
        const turnAngle = normalizeAngleDiff(brngOut - brngIn);
        const rawAlpha = Math.abs(turnAngle);
        const alpha = Math.min(172, rawAlpha);
        const isRightTurn = turnAngle > 0;

        const cosHalf = Math.max(0.05, Math.cos(toRad(alpha / 2)));
        const tanHalf = Math.tan(toRad(alpha / 2));
        const dLead = radiusNM * tanHalf;
        const dCut = radiusNM * (1.0 / cosHalf - 1.0);

        // Clamping by connected leg lengths
        let effectiveLead = dLead;
        let effectiveRadius = radiusNM;
        let effectiveCut = dCut;
        let isClamped = false;
        let maxAllowedLead = Infinity;

        if (pPrev && pCorner && pNext) {
            const legIn = calculateDistanceNM(pPrev.lat, pPrev.lon, pCorner.lat, pCorner.lon);
            const legOut = calculateDistanceNM(pCorner.lat, pCorner.lon, pNext.lat, pNext.lon);
            if (legIn > 0 && legOut > 0) {
                maxAllowedLead = Math.min(legIn * 0.45, legOut * 0.45);
                if (dLead > maxAllowedLead) {
                    isClamped = true;
                    effectiveLead = maxAllowedLead;
                    effectiveRadius = tanHalf > 0.001 ? (effectiveLead / tanHalf) : radiusNM;
                    effectiveCut = effectiveRadius * (1.0 / cosHalf - 1.0);
                }
            }
        }

        return {
            brngIn,
            brngOut,
            turnAngle,
            alpha: rawAlpha,
            clampedAlpha: alpha,
            isRightTurn,
            dLead,
            dCut,
            effectiveLead,
            effectiveRadius,
            effectiveCut,
            isClamped,
            maxAllowedLead
        };
    }

    function generateLeadTurnArc(pPrev, pCorner, pNext, radiusNM = 1.0) {
        const analysis = analyzeCornerTurn(pPrev, pCorner, pNext, radiusNM);
        const { brngIn, brngOut, alpha, clampedAlpha, isRightTurn, effectiveLead, effectiveRadius } = analysis;

        if (alpha < 5 || alpha > 170) return null;

        const effAlpha = clampedAlpha || Math.min(170, alpha);

        const L1 = projectLatLng(pCorner.lat, pCorner.lon, (brngIn + 180) % 360, effectiveLead);
        const L2 = projectLatLng(pCorner.lat, pCorner.lon, brngOut, effectiveLead);

        const centerBearing = isRightTurn ? (brngIn + 90) % 360 : (brngIn - 90 + 360) % 360;
        const O = projectLatLng(L1.lat, L1.lon, centerBearing, effectiveRadius);

        const angleToL1 = calculateBearingDeg(O.lat, O.lon, L1.lat, L1.lon);
        const sweep = isRightTurn ? effAlpha : -effAlpha;
        const arcPts = [L1];
        const steps = 6;
        for (let i = 1; i < steps; i++) {
            const frac = i / steps;
            const curA = (angleToL1 + sweep * frac + 720) % 360;
            arcPts.push(projectLatLng(O.lat, O.lon, curA, effectiveRadius));
        }
        arcPts.push(L2);

        return { analysis, L1, L2, arcPts, effectiveRadius, effectiveLead };
    }

    function generateCornerLoopBack(pPrev, pCorner, pNext, radiusNM = 1.0, numArcPoints = 3) {
        const analysis = analyzeCornerTurn(pPrev, pCorner, pNext, radiusNM);
        const { brngIn, brngOut, alpha, clampedAlpha, isRightTurn } = analysis;

        // Skip loop-backs on gentle turns (< 60) or branch reversals (> 165)
        if (alpha < 60 || alpha > 165) return null;

        const effAlpha = clampedAlpha || Math.min(160, alpha);
        const tanHalf = Math.tan(toRad(Math.min(160, effAlpha) / 2));
        const dExt = Math.min(radiusNM * tanHalf, 1.8 * radiusNM);

        const T1 = projectLatLng(pCorner.lat, pCorner.lon, brngIn, dExt);
        const T2 = projectLatLng(pCorner.lat, pCorner.lon, (brngOut + 180) % 360, dExt);

        const centerBearing = isRightTurn ? (brngIn - 90 + 360) % 360 : (brngIn + 90) % 360;
        const O = projectLatLng(T1.lat, T1.lon, centerBearing, radiusNM);

        const angleToT1 = calculateBearingDeg(O.lat, O.lon, T1.lat, T1.lon);
        const sweep = isRightTurn ? -((360 - effAlpha)) : (360 - effAlpha);

        const arcPts = [];
        for (let i = 1; i <= numArcPoints; i++) {
            const frac = i / (numArcPoints + 1);
            const curA = (angleToT1 + sweep * frac + 720) % 360;
            arcPts.push(projectLatLng(O.lat, O.lon, curA, radiusNM));
        }

        return {
            analysis,
            T1,
            T2,
            O,
            arcPts
        };
    }


    // --- Smooth Wheel Zoom with Speed Ramping & Inertial Easing ---
    if (typeof L !== 'undefined' && L.Handler && !L.Map.SmoothWheelZoom) {
        L.Map.mergeOptions({
            smoothWheelZoom: true,
            smoothSensitivity: 1.0
        });

        L.Map.SmoothWheelZoom = L.Handler.extend({
            addHooks: function () {
                L.DomEvent.on(this._map._container, 'wheel', this._onWheelScroll, this);
                this._map.on('movestart dragstart zoomstart', this._onMapInterrupt, this);
            },

            removeHooks: function () {
                L.DomEvent.off(this._map._container, 'wheel', this._onWheelScroll, this);
                this._map.off('movestart dragstart zoomstart', this._onMapInterrupt, this);
            },

            _onMapInterrupt: function () {
                if (this._internalMove) return;
                if (this._isWheeling || this._moved) {
                    clearTimeout(this._timeoutId);
                    cancelAnimationFrame(this._zoomAnimationId);
                    this._isWheeling = false;
                    if (this._moved) {
                        this._moved = false;
                        this._map._moveEnd(true);
                    }
                    if (this._map._renderer && typeof this._map._renderer._reset === 'function') {
                        this._map._renderer._reset();
                    }
                }
            },

            _onWheelScroll: function (e) {
                if (window.ArtState && ArtState.isDrawing) return;

                if (!this._isWheeling) {
                    this._onWheelStart(e);
                }
                this._onWheeling(e);
            },

            _onWheelStart: function (e) {
                var map = this._map;
                this._isWheeling = true;
                this._wheelMousePosition = map.mouseEventToContainerPoint(e);
                this._centerPoint = map.getSize()._divideBy(2);
                this._startLatLng = map.containerPointToLatLng(this._centerPoint);
                this._wheelMouseLatLng = map.containerPointToLatLng(this._wheelMousePosition);
                this._startZoom = map.getZoom();
                this._moved = false;
                this._zooming = true;
                this._lastWheelTime = performance.now();

                map._stop();
                if (map._panAnim) map._panAnim.stop();

                this._goalZoom = map.getZoom();
                this._prevCenter = map.getCenter();
                this._prevZoom = map.getZoom();

                cancelAnimationFrame(this._zoomAnimationId);
                this._zoomAnimationId = requestAnimationFrame(this._updateWheelZoom.bind(this));
            },

            _onWheeling: function (e) {
                var map = this._map;
                var now = performance.now();
                var timeDelta = Math.max(8, now - (this._lastWheelTime || now));
                this._lastWheelTime = now;

                var deltaPx = e.deltaY;
                if (e.deltaMode === 1) deltaPx *= 28;
                else if (e.deltaMode === 2) deltaPx *= 200;

                // Speed ramping: faster scrolling scales zoom rate exponentially
                var velocity = Math.abs(deltaPx) / timeDelta;
                var speedMultiplier = 1.0;
                if (velocity > 0.3) {
                    speedMultiplier = 1.0 + Math.min(3.0, Math.pow((velocity - 0.3) * 1.5, 1.15));
                }

                var baseScale = 0.0016 * (map.options.smoothSensitivity || 1.0);
                var zoomChange = (deltaPx > 0 ? -1 : 1) * Math.min(Math.abs(deltaPx) * baseScale, 1.2) * speedMultiplier;

                this._goalZoom = this._goalZoom + zoomChange;
                this._goalZoom = Math.max(map.getMinZoom(), Math.min(map.getMaxZoom(), this._goalZoom));

                this._wheelMousePosition = map.mouseEventToContainerPoint(e);
                this._wheelMouseLatLng = map.containerPointToLatLng(this._wheelMousePosition);

                clearTimeout(this._timeoutId);
                this._timeoutId = setTimeout(this._onWheelEnd.bind(this), 200);

                L.DomEvent.preventDefault(e);
                L.DomEvent.stopPropagation(e);
            },

            _onWheelEnd: function () {
                this._isWheeling = false;
                cancelAnimationFrame(this._zoomAnimationId);
                if (this._moved) {
                    this._internalMove = true;
                    this._map._move(this._center || this._map.getCenter(), this._goalZoom);
                    this._moved = false;
                    this._map._moveEnd(true);
                    this._internalMove = false;
                }
                if (this._map._renderer && typeof this._map._renderer._reset === 'function') {
                    this._map._renderer._reset();
                }
            },

            _updateWheelZoom: function () {
                var map = this._map;

                if (!this._prevCenter) {
                    this._prevCenter = map.getCenter();
                    this._prevZoom = map.getZoom();
                }

                if (!map.getCenter().equals(this._prevCenter, 1e-5) || Math.abs(map.getZoom() - this._prevZoom) > 1e-4) {
                    this._isWheeling = false;
                    cancelAnimationFrame(this._zoomAnimationId);
                    if (this._moved) {
                        this._moved = false;
                        map._moveEnd(true);
                    }
                    if (map._renderer && typeof map._renderer._reset === 'function') {
                        map._renderer._reset();
                    }
                    return;
                }

                var currentZoom = map.getZoom();
                var diff = this._goalZoom - currentZoom;

                if (!this._isWheeling && Math.abs(diff) < 0.002) {
                    cancelAnimationFrame(this._zoomAnimationId);
                    if (this._moved) {
                        this._internalMove = true;
                        map._move(this._center || map.getCenter(), this._goalZoom);
                        this._moved = false;
                        map._moveEnd(true);
                        this._internalMove = false;
                    }
                    if (map._renderer && typeof map._renderer._reset === 'function') {
                        map._renderer._reset();
                    }
                    return;
                }

                this._zoom = currentZoom + diff * 0.22;
                this._zoom = Math.round(this._zoom * 1000) / 1000;

                var delta = this._wheelMousePosition ? this._wheelMousePosition.subtract(this._centerPoint) : new L.Point(0, 0);
                if (map.options.smoothWheelZoom === 'center' || (delta.x === 0 && delta.y === 0)) {
                    this._center = this._startLatLng || map.getCenter();
                } else {
                    this._center = map.unproject(map.project(this._wheelMouseLatLng, this._zoom).subtract(delta), this._zoom);
                }

                this._internalMove = true;
                if (!this._moved) {
                    map._moveStart(true, false);
                    this._moved = true;
                }

                map._move(this._center, this._zoom);
                this._internalMove = false;
                this._prevCenter = map.getCenter();
                this._prevZoom = map.getZoom();

                this._zoomAnimationId = requestAnimationFrame(this._updateWheelZoom.bind(this));
            }
        });

        L.Map.addInitHook('addHandler', 'smoothWheelZoom', L.Map.SmoothWheelZoom);
    }

    // --- Map Initialization ---
    function initMap() {
        const cartoKey = 'cb1_272f_1_6642cd2a2abfdf826cc7fc9c';

        const tileDefaults = {
            keepBuffer: 10,
            updateWhenZooming: true,
            updateWhenIdle: false,
            updateInterval: 35
        };

        ArtState.layers.osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 19,
            attribution: '&copy; OpenStreetMap',
            ...tileDefaults
        });

        ArtState.layers.cartoDark = L.tileLayer(`https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png?key=${cartoKey}`, {
            maxZoom: 19,
            attribution: '&copy; CARTO',
            ...tileDefaults
        });

        ArtState.layers.cartoVoyager = L.tileLayer(`https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png?key=${cartoKey}`, {
            maxZoom: 19,
            attribution: '&copy; CARTO',
            ...tileDefaults
        });

        ArtState.layers.satellite = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
            maxZoom: 18,
            attribution: '&copy; Esri World Imagery',
            ...tileDefaults
        });

        const isDarkMode = (typeof document !== 'undefined' && document.body && document.body.classList.contains('dark-mode')) ||
                           (typeof localStorage !== 'undefined' && localStorage.getItem('theme') === 'dark');
        const initialBaseLayer = isDarkMode ? ArtState.layers.cartoDark : ArtState.layers.osm;

        ArtState.map = L.map('artMap', {
            center: [ArtState.center.lat, ArtState.center.lon],
            zoom: 11,
            zoomSnap: 0,
            zoomDelta: 0.5,
            scrollWheelZoom: false,
            smoothWheelZoom: true,
            smoothSensitivity: 1.0,
            layers: [initialBaseLayer]
        });

        const baseMaps = {
            "OpenStreetMap": ArtState.layers.osm,
            "Aero Midnight (Dark)": ArtState.layers.cartoDark,
            "Aviation VFR (Light)": ArtState.layers.cartoVoyager,
            "Satellite Imagery": ArtState.layers.satellite
        };
        L.control.layers(baseMaps, null, { position: 'topright' }).addTo(ArtState.map);

        L.control.scale({ imperial: true, metric: false, position: 'bottomleft' }).addTo(ArtState.map);

        // Keep vector SVG renderer and HTML markers 100% aligned across fractional zooms, pans, and window resizes
        function resyncMapRenderers() {
            if (!ArtState.map) return;
            if (ArtState.map._renderer && typeof ArtState.map._renderer._reset === 'function') {
                ArtState.map._renderer._reset();
            }
            ArtState.map.eachLayer(layer => {
                if (layer._renderer && typeof layer._renderer._reset === 'function') {
                    layer._renderer._reset();
                }
            });
        }
        ArtState.map.on('moveend dragend zoomend viewreset resize', resyncMapRenderers);

        // Center Pin
        createCenterMarker();

        // Setup Freehand and Click listeners
        setupMapDrawingListeners();

        // Default artwork: Airplane
        loadPreset('airplane');
    }

    // --- Map Theme Base Layer Switching ---
    function setMapBaseLayerForTheme(isDark) {
        if (!ArtState.map || !ArtState.layers) return;
        const targetLayer = isDark ? ArtState.layers.cartoDark : ArtState.layers.osm;
        if (!targetLayer) return;

        if (typeof ArtState.map.hasLayer === 'function' && ArtState.map.hasLayer(targetLayer)) {
            return;
        }

        const allBaseLayers = [
            ArtState.layers.osm,
            ArtState.layers.cartoDark,
            ArtState.layers.cartoVoyager,
            ArtState.layers.satellite
        ];
        allBaseLayers.forEach(layer => {
            if (layer && layer !== targetLayer) {
                if (typeof ArtState.map.hasLayer === 'function') {
                    if (ArtState.map.hasLayer(layer)) {
                        ArtState.map.removeLayer(layer);
                    }
                } else if (typeof ArtState.map.removeLayer === 'function') {
                    ArtState.map.removeLayer(layer);
                }
            }
        });

        if (typeof targetLayer.addTo === 'function') {
            targetLayer.addTo(ArtState.map);
        }
        if (typeof targetLayer.bringToBack === 'function') {
            targetLayer.bringToBack();
        }
    }

    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener('themeChanged', function (e) {
            if (e && e.detail && typeof e.detail.isDark === 'boolean') {
                setMapBaseLayerForTheme(e.detail.isDark);
            }
        });
    }

    function createCenterMarker() {
        if (ArtState.centerMarker) {
            ArtState.map.removeLayer(ArtState.centerMarker);
        }

        const centerIcon = L.divIcon({
            className: 'center-pin-icon',
            html: '<div class="center-pin-inner" style="background:#ffc107; color:#000; border:2px solid #000; border-radius:50%; width:26px; height:26px; display:flex; align-items:center; justify-content:center; font-size:13px; font-weight:bold; cursor:grab; box-shadow:0 2px 6px rgba(0,0,0,0.35);">⚓</div>',
            iconSize: [26, 26],
            iconAnchor: [13, 13]
        });

        ArtState.centerMarker = L.marker([ArtState.center.lat, ArtState.center.lon], {
            icon: centerIcon,
            draggable: true,
            zIndexOffset: 2500
        }).addTo(ArtState.map);

        ArtState.centerMarker.on('dragstart', function () {
            HistoryManager.pushState();
        });

        ArtState.centerMarker.on('drag', function (e) {
            const pos = e.target.getLatLng();
            ArtState.center.lat = pos.lat;
            ArtState.center.lon = pos.lng;
            updateCenterInputs();
            applyTransformations();
        });

        ArtState.centerMarker.bindTooltip("Anchor (Drag to move)", { direction: 'top', offset: [0, -12] });
    }

    function updateCenterInputs() {
        const latInput = document.getElementById('centerLatInput');
        const lonInput = document.getElementById('centerLonInput');
        if (latInput) latInput.value = ArtState.center.lat.toFixed(4);
        if (lonInput) lonInput.value = ArtState.center.lon.toFixed(4);
    }

    function updateHomeAirportUI() {
        const home = ArtState.homeAirport || DEFAULT_HOME_AIRPORT;
        const icao = home.icao || home.faa || 'E16';
        const name = home.name || icao;
        const coords = `${Number(home.lat).toFixed(4)}°, ${Number(home.lon).toFixed(4)}°`;

        // Top Search Home Airport elements
        const topBadge = document.getElementById('topHomeAirportBadge');
        const topIcao = document.getElementById('topHomeDropdownIcao');
        const topName = document.getElementById('topHomeDropdownName');
        const topCoords = document.getElementById('topHomeDropdownCoords');

        if (topBadge) topBadge.innerText = icao;
        if (topIcao) topIcao.innerText = icao;
        if (topName) topName.innerText = name;
        if (topCoords) topCoords.innerText = coords;

        // Lower airport card elements
        const label = document.getElementById('connectHomeAirportLabel');
        const badge = document.getElementById('homeAirportHeaderBadge');
        if (label) label.innerText = `Include Airport Transit Legs ( Departure & Arrival )`;
        if (badge) badge.innerText = `Home: ${icao}`;

        // Modal elements
        const modalBadge = document.getElementById('configHomeCurrentBadge');
        const modalName = document.getElementById('configHomeCurrentName');
        const modalCoords = document.getElementById('configHomeCurrentCoords');
        if (modalBadge) modalBadge.innerText = icao;
        if (modalName) modalName.innerText = name;
        if (modalCoords) modalCoords.innerText = coords;

        const depInput = document.getElementById('depAirportInput');
        const depName = document.getElementById('depAirportName');
        if (depInput && !depInput.value) depInput.value = ArtState.depAirport.icao;
        if (depName && ArtState.depAirport) depName.innerText = ArtState.depAirport.name;

        const arrInput = document.getElementById('arrAirportInput');
        const arrName = document.getElementById('arrAirportName');
        if (arrInput && !arrInput.value) arrInput.value = ArtState.arrAirport.icao;
        if (arrName && ArtState.arrAirport) arrName.innerText = ArtState.arrAirport.name;
    }

    // --- Spatial Transformation Engine ---
    // Takes normalized 2D points in [-0.5, 0.5] and projects to Lat/Lon
    function applyTransformations() {
        if (!ArtState.basePoints || ArtState.basePoints.length === 0) {
            clearRenderedRoute();
            return;
        }

        const theta = toRad(ArtState.rotationDeg);
        const cosT = Math.cos(theta);
        const sinT = Math.sin(theta);
        const sizeNM = ArtState.sizeNM;
        const aspect = ArtState.aspectRatio || 1.0;
        const centerLat = ArtState.center.lat;
        const centerLon = ArtState.center.lon;
        const cosLat = Math.cos(toRad(centerLat)) || 1.0;

        // 1 NM = 1/60 degrees latitude
        const nmToLatDeg = 1.0 / 60.0;
        // 1 NM longitude depends on latitude
        const nmToLonDeg = (1.0 / 60.0) / Math.max(cosLat, 0.05);

        const widthNM = ArtState.sizeNM || 12;
        const heightNM = ArtState.heightNM || (widthNM * (ArtState.aspectRatio || 1.0));

        function projectPt(pt) {
            let nx = pt.x;
            let ny = pt.y;

            if (ArtState.flipH) nx = -nx;
            if (ArtState.flipV) ny = -ny;

            // Scale along shape's natural axes
            const sx = nx * widthNM;
            const sy = ny * heightNM;

            // Rotation
            const rx = sx * cosT - sy * sinT;
            const ry = sx * sinT + sy * cosT;

            return {
                lat: centerLat + (ry * nmToLatDeg),
                lon: centerLon + (rx * nmToLonDeg)
            };
        }

        ArtState.rawProjectedPoints = ArtState.basePoints.map(projectPt);

        if (ArtState.baseContours && ArtState.baseContours.length > 0) {
            ArtState.rawProjectedContours = ArtState.baseContours.map(c => c.map(projectPt));
        } else {
            ArtState.rawProjectedContours = null;
        }

        // Simplify using Ramer-Douglas-Peucker & Optimize
        simplifyProjectedRoute();
    }

    // Convert a projected Lat/Lon back to normalized base point [-0.5, 0.5]
    function unprojectPoint(lat, lon) {
        const theta = toRad(ArtState.rotationDeg);
        const cosT = Math.cos(theta);
        const sinT = Math.sin(theta);
        const centerLat = ArtState.center.lat;
        const centerLon = ArtState.center.lon;
        const cosLat = Math.cos(toRad(centerLat)) || 1.0;
        const nmToLatDeg = 1.0 / 60.0;
        const nmToLonDeg = (1.0 / 60.0) / Math.max(cosLat, 0.05);
        const widthNM = ArtState.sizeNM || 12;
        const heightNM = ArtState.heightNM || (widthNM * (ArtState.aspectRatio || 1.0));

        const ry = (lat - centerLat) / nmToLatDeg;
        const rx = (lon - centerLon) / nmToLonDeg;

        let sx = rx * cosT + ry * sinT;
        let sy = -rx * sinT + ry * cosT;

        let nx = sx / widthNM;
        let ny = sy / heightNM;

        if (ArtState.flipH) nx = -nx;
        if (ArtState.flipV) ny = -ny;

        return { x: nx, y: ny };
    }

    // Delete an individual waypoint from the sky art route
    function deleteWaypoint(artIdx) {
        if (!ArtState.projectedPoints || ArtState.projectedPoints.length <= 2) {
            alert("A sky art flight path requires at least 2 waypoints.");
            return;
        }
        if (artIdx < 0 || artIdx >= ArtState.projectedPoints.length) return;

        HistoryManager.pushState();

        const totalPts = ArtState.projectedPoints.length;
        const isLoopClosed = totalPts >= 3 &&
            Math.abs(ArtState.projectedPoints[0].lat - ArtState.projectedPoints[totalPts - 1].lat) < 0.0008 &&
            Math.abs(ArtState.projectedPoints[0].lon - ArtState.projectedPoints[totalPts - 1].lon) < 0.0008;

        if (isLoopClosed && artIdx === 0) {
            // If deleting the start/closing vertex on a closed loop:
            // Remove closing point, remove start point, and re-close at the new start if >= 3 pts
            ArtState.projectedPoints.splice(totalPts - 1, 1);
            ArtState.projectedPoints.splice(0, 1);
            if (ArtState.projectedPoints.length >= 2) {
                const newFirst = ArtState.projectedPoints[0];
                ArtState.projectedPoints.push({ lat: newFirst.lat, lon: newFirst.lon });
            }
        } else {
            ArtState.projectedPoints.splice(artIdx, 1);
        }

        if (ArtState.cornerLoopOverrides) {
            const newOverrides = {};
            if (isLoopClosed && artIdx === 0) {
                for (const [key, val] of Object.entries(ArtState.cornerLoopOverrides)) {
                    const k = parseInt(key, 10);
                    if (k > 0 && k < totalPts - 1) {
                        newOverrides[k - 1] = val;
                    }
                }
            } else {
                for (const [key, val] of Object.entries(ArtState.cornerLoopOverrides)) {
                    const k = parseInt(key, 10);
                    if (k < artIdx) {
                        newOverrides[k] = val;
                    } else if (k > artIdx) {
                        newOverrides[k - 1] = val;
                    }
                }
            }
            ArtState.cornerLoopOverrides = newOverrides;
        }

        ArtState.rawProjectedPoints = ArtState.projectedPoints.map(p => ({ lat: p.lat, lon: p.lon }));
        ArtState.basePoints = ArtState.projectedPoints.map(p => unprojectPoint(p.lat, p.lon));
        ArtState.baseContours = [ArtState.basePoints.slice()];
        ArtState.rawProjectedContours = null;

        buildFullFlightPlan();
        renderRouteOnMap();
        updateStatsHUD();
        renderWaypointTable();
    }

    // Insert a new waypoint in the middle of afterArtIdx and afterArtIdx + 1 (or at specified coords)
    function insertWaypoint(afterArtIdx, lat = null, lon = null) {
        if (!ArtState.projectedPoints || ArtState.projectedPoints.length < 2) return;
        if (afterArtIdx < 0 || afterArtIdx >= ArtState.projectedPoints.length - 1) return;

        const p1 = ArtState.projectedPoints[afterArtIdx];
        const p2 = ArtState.projectedPoints[afterArtIdx + 1];

        const insertLat = (lat !== null && !isNaN(lat)) ? lat : (p1.lat + p2.lat) / 2;
        const insertLon = (lon !== null && !isNaN(lon)) ? lon : (p1.lon + p2.lon) / 2;

        HistoryManager.pushState();

        ArtState.projectedPoints.splice(afterArtIdx + 1, 0, { lat: insertLat, lon: insertLon });

        if (ArtState.cornerLoopOverrides) {
            const newOverrides = {};
            for (const [key, val] of Object.entries(ArtState.cornerLoopOverrides)) {
                const k = parseInt(key, 10);
                if (k <= afterArtIdx) {
                    newOverrides[k] = val;
                } else {
                    newOverrides[k + 1] = val;
                }
            }
            ArtState.cornerLoopOverrides = newOverrides;
        }

        ArtState.rawProjectedPoints = ArtState.projectedPoints.map(p => ({ lat: p.lat, lon: p.lon }));
        ArtState.basePoints = ArtState.projectedPoints.map(p => unprojectPoint(p.lat, p.lon));
        ArtState.baseContours = [ArtState.basePoints.slice()];
        ArtState.rawProjectedContours = null;

        buildFullFlightPlan();
        renderRouteOnMap();
        updateStatsHUD();
        renderWaypointTable();
    }

    // --- Entry / Exit Waypoint Optimization ---
    // Optimizes entry/exit points for connected airports to prevent transit legs
    // from needlessly crossing/cutting through closed artwork loops, multi-letter text, or open shapes.
    function optimizeRouteWaypoints(input) {
        if (!input || input.length === 0) return [];

        const shouldOptimize = ArtState.includeAirport && ArtState.optimizeEntryExit && ArtState.depAirport;
        const dep = ArtState.depAirport;
        const arr = ArtState.arrAirport || dep;

        // Normalize input into an array of contour arrays
        let rawContours = [];
        if (Array.isArray(input) && input.length > 0 && Array.isArray(input[0])) {
            rawContours = input.filter(c => c && c.length > 0);
        } else {
            rawContours = [input];
        }

        // Identify each sub-contour and detect if it is a closed loop
        const subContours = [];
        const shapeSizeNM = ArtState.sizeNM || 12;
        const closureTolNM = Math.max(0.35, shapeSizeNM * 0.08);

        rawContours.forEach(c => {
            if (!c || c.length === 0) return;
            if (c.length < 3) {
                subContours.push({ isClosed: false, pts: c.map(p => ({ lat: p.lat, lon: p.lon })) });
                return;
            }

            const pFirst = c[0];
            const pLast = c[c.length - 1];
            const distEnd = calculateDistanceNM(pFirst.lat, pFirst.lon, pLast.lat, pLast.lon);
            const isClosed = (
                (Math.abs(pFirst.lat - pLast.lat) < 0.001 && Math.abs(pFirst.lon - pLast.lon) < 0.001) ||
                distEnd < 0.005 ||
                (ArtState.sourceType === 'freehand' && distEnd <= closureTolNM)
            );

            if (isClosed) {
                let pts = c.map(p => ({ lat: p.lat, lon: p.lon }));
                // If closing point is within closure tolerance, slice unique vertices
                if (distEnd <= closureTolNM && pts.length > 3) {
                    pts = pts.slice(0, pts.length - 1);
                }
                subContours.push({ isClosed: true, pts: pts });
            } else {
                subContours.push({
                    isClosed: false,
                    pts: c.map(p => ({ lat: p.lat, lon: p.lon }))
                });
            }
        });

        if (!shouldOptimize) {
            const res = [];
            rawContours.forEach(c => {
                if (c && c.length > 0) {
                    res.push(...c.map(p => ({ lat: p.lat, lon: p.lon })));
                }
            });
            if (ArtState.routeReversed) res.reverse();
            return res;
        }

        // Case 1: Single closed loop (e.g. RV-7, heart, circle, diamond)
        if (subContours.length === 1 && subContours[0].isClosed) {
            const uniquePts = subContours[0].pts;
            const M = uniquePts.length;
            if (M < 3) return uniquePts;

            let bestIdx = 0;
            let minTransit = Infinity;
            for (let i = 0; i < M; i++) {
                const pt = uniquePts[i];
                const dDep = calculateDistanceNM(dep.lat, dep.lon, pt.lat, pt.lon);
                const dArr = calculateDistanceNM(pt.lat, pt.lon, arr.lat, arr.lon);
                const totalTransit = dDep + dArr;
                if (totalTransit < minTransit) {
                    minTransit = totalTransit;
                    bestIdx = i;
                }
            }

            const result = [];
            if (ArtState.routeReversed) {
                for (let j = 0; j < M; j++) {
                    const idx = (bestIdx - j + M) % M;
                    result.push({ lat: uniquePts[idx].lat, lon: uniquePts[idx].lon });
                }
            } else {
                for (let j = 0; j < M; j++) {
                    const idx = (bestIdx + j) % M;
                    result.push({ lat: uniquePts[idx].lat, lon: uniquePts[idx].lon });
                }
            }
            result.push({ lat: result[0].lat, lon: result[0].lon });
            return result;
        }

        // Case 2: Multi-contour (text with multiple letters / loops or stick font words)
        if (subContours.length > 1) {
            const firstSc = subContours[0];
            const lastSc = subContours[subContours.length - 1];

            const dDepFirst = Math.min(...firstSc.pts.map(p => calculateDistanceNM(dep.lat, dep.lon, p.lat, p.lon)));
            const dLastArr = Math.min(...lastSc.pts.map(p => calculateDistanceNM(p.lat, p.lon, arr.lat, arr.lon)));
            const dDepLast = Math.min(...lastSc.pts.map(p => calculateDistanceNM(dep.lat, dep.lon, p.lat, p.lon)));
            const dFirstArr = Math.min(...firstSc.pts.map(p => calculateDistanceNM(p.lat, p.lon, arr.lat, arr.lon)));

            const costFwd = dDepFirst + dLastArr;
            const costRev = dDepLast + dFirstArr;

            // When round-trip (dep == arr), costFwd == costRev identically.
            // Choose the direction whose departure transit is shorter!
            const shouldReverse = (costRev < costFwd - 0.01) ||
                                  (Math.abs(costRev - costFwd) <= 0.01 && dDepLast < dDepFirst - 0.01);

            let ordered = shouldReverse ? [...subContours].reverse() : [...subContours];
            if (ArtState.routeReversed) ordered.reverse();

            const result = [];
            let prevPoint = dep;

            ordered.forEach(sc => {
                if (sc.isClosed && sc.pts.length >= 3) {
                    const pts = sc.pts;
                    const M = pts.length;
                    let minDist = Infinity;
                    let bestIdx = 0;
                    for (let i = 0; i < M; i++) {
                        const d = calculateDistanceNM(prevPoint.lat, prevPoint.lon, pts[i].lat, pts[i].lon);
                        if (d < minDist) {
                            minDist = d;
                            bestIdx = i;
                        }
                    }
                    const loop = [];
                    for (let j = 0; j < M; j++) {
                        const idx = (bestIdx + j) % M;
                        loop.push({ lat: pts[idx].lat, lon: pts[idx].lon });
                    }
                    loop.push({ lat: loop[0].lat, lon: loop[0].lon });
                    result.push(...loop);
                    prevPoint = loop[loop.length - 1];
                } else {
                    // Open contour (stick font letter stroke or open line)
                    let pts = sc.pts.map(p => ({ lat: p.lat, lon: p.lon }));
                    if (pts.length >= 2) {
                        const dStart = calculateDistanceNM(prevPoint.lat, prevPoint.lon, pts[0].lat, pts[0].lon);
                        const dEnd = calculateDistanceNM(prevPoint.lat, prevPoint.lon, pts[pts.length - 1].lat, pts[pts.length - 1].lon);
                        if (dEnd < dStart) {
                            pts.reverse();
                        }
                    }
                    result.push(...pts);
                    if (pts.length > 0) {
                        prevPoint = pts[pts.length - 1];
                    }
                }
            });

            return result;
        }

        // Case 3: General single open path (e.g. freehand line)
        let result = subContours[0].pts.map(p => ({ lat: p.lat, lon: p.lon }));
        if (result.length < 2) return result;

        const pFirst = result[0];
        const pLast = result[result.length - 1];

        const dDepFirst = calculateDistanceNM(dep.lat, dep.lon, pFirst.lat, pFirst.lon);
        const dLastArr = calculateDistanceNM(pLast.lat, pLast.lon, arr.lat, arr.lon);
        const dDepLast = calculateDistanceNM(dep.lat, dep.lon, pLast.lat, pLast.lon);
        const dFirstArr = calculateDistanceNM(pFirst.lat, pFirst.lon, arr.lat, arr.lon);

        const costFwd = dDepFirst + dLastArr;
        const costRev = dDepLast + dFirstArr;

        const shouldReverse = (costRev < costFwd - 0.01) ||
                              (Math.abs(costRev - costFwd) <= 0.01 && dDepLast < dDepFirst - 0.01);

        if (shouldReverse) {
            result.reverse();
        }
        if (ArtState.routeReversed) {
            result.reverse();
        }

        return result;
    }

    function simplifyProjectedRoute() {
        if ((!ArtState.rawProjectedPoints || ArtState.rawProjectedPoints.length === 0) &&
            (!ArtState.projectedPoints || ArtState.projectedPoints.length === 0)) {
            clearRenderedRoute();
            return;
        }

        const originLat = ArtState.center.lat;
        const originLon = ArtState.center.lon;
        const cosLat = Math.cos(toRad(originLat)) || 1.0;
        const baseToleranceNM = ArtState.simplificationTolerance || 0.015;

        function runSimplificationWithTol(tol) {
            function simplifyContour(rawPts) {
                if (!rawPts || rawPts.length <= 2) return rawPts.map(p => ({ lat: p.lat, lon: p.lon }));
                const xyPoints = rawPts.map(p => ({
                    x: (p.lon - originLon) * cosLat * 60.0, // in NM
                    y: (p.lat - originLat) * 60.0,          // in NM
                    raw: p
                }));
                const simplifiedXY = ramerDouglasPeucker(xyPoints, tol);
                return simplifiedXY.map(p => ({ lat: p.raw.lat, lon: p.raw.lon }));
            }

            let cList = null;
            if (ArtState.rawProjectedContours && ArtState.rawProjectedContours.length > 0) {
                cList = ArtState.rawProjectedContours.map(c => simplifyContour(c));
            } else if (ArtState.rawProjectedPoints && ArtState.rawProjectedPoints.length > 0) {
                cList = [simplifyContour(ArtState.rawProjectedPoints)];
            } else {
                cList = [ArtState.projectedPoints.map(p => ({ lat: p.lat, lon: p.lon }))];
            }

            return optimizeRouteWaypoints(cList);
        }

        let points = runSimplificationWithTol(baseToleranceNM);

        // Adaptive Max Waypoints ceiling check
        if (ArtState.enforceMaxWaypoints && ArtState.maxWaypoints > 0) {
            const maxWp = ArtState.maxWaypoints;

            function countFullPlanWaypoints(pts) {
                let cnt = pts.length;
                if (ArtState.includeAirport && ArtState.depAirport) cnt++;
                if (ArtState.includeAirport && ArtState.arrAirport) cnt++;
                if (ArtState.enableCornerLoopBacks && pts.length >= 3) {
                    const radius = ArtState.autopilotTurnRadiusNM || 1.0;
                    const minAng = ArtState.autopilotMinAngleDeg || 60;
                    for (let i = 1; i < pts.length - 1; i++) {
                        const an = analyzeCornerTurn(pts[i - 1], pts[i], pts[i + 1], radius);
                        const isOverridden = ArtState.cornerLoopOverrides[i] !== undefined;
                        const shouldLoop = isOverridden ? !!ArtState.cornerLoopOverrides[i] : (an.alpha >= minAng && an.alpha <= 165);
                        if (shouldLoop) cnt += 5; // T1 + 3 arc points + T2
                    }
                }
                return cnt;
            }

            if (countFullPlanWaypoints(points) > maxWp) {
                let lowTol = baseToleranceNM;
                let highTol = Math.max(0.35, (ArtState.sizeNM || 12) * 0.12);
                let bestPoints = points;

                for (let iter = 0; iter < 12; iter++) {
                    const midTol = (lowTol + highTol) / 2;
                    const testPts = runSimplificationWithTol(midTol);
                    const wpCount = countFullPlanWaypoints(testPts);
                    if (wpCount > maxWp) {
                        lowTol = midTol;
                    } else {
                        bestPoints = testPts;
                        highTol = midTol;
                    }
                }
                points = bestPoints;
            }
        }

        ArtState.projectedPoints = points;

        buildFullFlightPlan();
        renderRouteOnMap();
        updateStatsHUD();
        renderWaypointTable();
    }

    // --- Build Full Flight Plan with Airports & Corner Loop-Backs ---
    function buildFullFlightPlan() {
        const full = [];

        // Departure airport if enabled
        if (ArtState.includeAirport && ArtState.depAirport) {
            full.push({
                id: ArtState.depAirport.icao,
                name: ArtState.depAirport.name,
                type: 'AIRPORT',
                lat: ArtState.depAirport.lat,
                lon: ArtState.depAirport.lon,
                isAirport: true,
                isLoopWaypoint: false
            });
        }

        const pts = ArtState.projectedPoints || [];
        const totalPts = pts.length;
        const isLoopClosed = totalPts >= 3 &&
            Math.abs(pts[0].lat - pts[totalPts - 1].lat) < 0.0008 &&
            Math.abs(pts[0].lon - pts[totalPts - 1].lon) < 0.0008;

        const turnRadius = ArtState.autopilotTurnRadiusNM || 1.0;
        const minAngle = ArtState.autopilotMinAngleDeg || 60;
        const enableLoops = !!ArtState.enableCornerLoopBacks;

        // Artwork user waypoints and loop-backs
        for (let i = 0; i < totalPts; i++) {
            const pt = pts[i];
            const wpId = 'WP' + String(i + 1).padStart(2, '0');

            // Add base corner waypoint
            full.push({
                id: wpId,
                name: `Art Pt ${i + 1}`,
                type: 'USER WAYPOINT',
                lat: pt.lat,
                lon: pt.lon,
                isAirport: false,
                isLoopWaypoint: false,
                artIndex: i
            });

            // Check if this vertex qualifies for a loop-back
            // Loops are only generated for intermediate corners flown (not wrap-around between last and first point)
            if (enableLoops && i > 0 && i < totalPts - 1) {
                const pPrev = pts[i - 1];
                const pNext = pts[i + 1];

                if (pPrev && pNext) {
                    const analysis = analyzeCornerTurn(pPrev, pt, pNext, turnRadius);
                    const isOverridden = ArtState.cornerLoopOverrides[i] !== undefined;
                    const shouldLoop = isOverridden ? !!ArtState.cornerLoopOverrides[i] : (analysis.alpha >= minAngle);

                    if (shouldLoop) {
                        const loop = generateCornerLoopBack(pPrev, pt, pNext, turnRadius, 3);
                        if (!loop || !loop.T1 || !loop.T2 || isNaN(loop.T1.lat) || isNaN(loop.T1.lon)) {
                            continue;
                        }
                        const loopSubId = String(i + 1).padStart(2, '0');

                        // T1: Tangent Entry (along incoming heading)
                        full.push({
                            id: `LP${loopSubId}A`,
                            name: `Loop ${i + 1} Entry`,
                            type: 'USER WAYPOINT',
                            lat: loop.T1.lat,
                            lon: loop.T1.lon,
                            isAirport: false,
                            isLoopWaypoint: true,
                            loopParentIdx: i
                        });

                        // Arc waypoints
                        const subLetters = ['B', 'C', 'D'];
                        loop.arcPts.forEach((arcPt, aIdx) => {
                            if (!isNaN(arcPt.lat) && !isNaN(arcPt.lon)) {
                                const letter = subLetters[aIdx] || String(aIdx + 1);
                                full.push({
                                    id: `LP${loopSubId}${letter}`,
                                    name: `Loop ${i + 1} Arc ${aIdx + 1}`,
                                    type: 'USER WAYPOINT',
                                    lat: arcPt.lat,
                                    lon: arcPt.lon,
                                    isAirport: false,
                                    isLoopWaypoint: true,
                                    loopParentIdx: i
                                });
                            }
                        });

                        // T2: Tangent Exit (rolls out heading directly to pCorner and pNext)
                        full.push({
                            id: `LP${loopSubId}E`,
                            name: `Loop ${i + 1} Exit`,
                            type: 'USER WAYPOINT',
                            lat: loop.T2.lat,
                            lon: loop.T2.lon,
                            isAirport: false,
                            isLoopWaypoint: true,
                            loopParentIdx: i
                        });

                        // Rollout passes through corner vertex
                        full.push({
                            id: `WP${loopSubId}R`,
                            name: `Art Pt ${i + 1} Rollout`,
                            type: 'USER WAYPOINT',
                            lat: pt.lat,
                            lon: pt.lon,
                            isAirport: false,
                            isLoopWaypoint: true,
                            loopParentIdx: i
                        });
                    }
                }
            }
        }

        // Arrival airport if enabled
        if (ArtState.includeAirport && ArtState.arrAirport) {
            full.push({
                id: ArtState.arrAirport.icao,
                name: ArtState.arrAirport.name,
                type: 'AIRPORT',
                lat: ArtState.arrAirport.lat,
                lon: ArtState.arrAirport.lon,
                isAirport: true,
                isLoopWaypoint: false
            });
        }

        ArtState.waypoints = full;
    }


    // --- Autopilot Lead Turn Ghost Polyline ---
    function clearAutopilotGhost() {
        if (ArtState.autopilotGhostPolyline && ArtState.map) {
            ArtState.map.removeLayer(ArtState.autopilotGhostPolyline);
        }
        ArtState.autopilotGhostPolyline = null;
    }

    function renderAutopilotGhost() {
        clearAutopilotGhost();
        if (!ArtState.showAutopilotGhost || !ArtState.map) return;

        // Use the active flight plan waypoints (which includes airports and loop-back waypoints if enabled)
        const waypoints = (ArtState.waypoints && ArtState.waypoints.length >= 2)
            ? ArtState.waypoints
            : ArtState.projectedPoints;
        if (!waypoints || waypoints.length < 2) return;

        const totalWps = waypoints.length;
        const turnRadius = ArtState.autopilotTurnRadiusNM || 1.0;
        const ghostPts = [];

        // Flight plan start
        ghostPts.push([waypoints[0].lat, waypoints[0].lon]);

        for (let i = 1; i < totalWps - 1; i++) {
            const pPrev = waypoints[i - 1];
            const pCorner = waypoints[i];
            const pNext = waypoints[i + 1];

            // If consecutive points are identical, just continue
            const dPrev = calculateDistanceNM(pPrev.lat, pPrev.lon, pCorner.lat, pCorner.lon);
            const dNext = calculateDistanceNM(pCorner.lat, pCorner.lon, pNext.lat, pNext.lon);
            if (dPrev < 0.005 || dNext < 0.005) {
                ghostPts.push([pCorner.lat, pCorner.lon]);
                continue;
            }

            const analysis = analyzeCornerTurn(pPrev, pCorner, pNext, turnRadius);
            if (analysis.alpha >= 12 && analysis.alpha <= 170) {
                const lead = generateLeadTurnArc(pPrev, pCorner, pNext, turnRadius);
                if (lead && lead.arcPts && lead.arcPts.length > 0) {
                    lead.arcPts.forEach(pt => {
                        if (!isNaN(pt.lat) && !isNaN(pt.lon)) {
                            ghostPts.push([pt.lat, pt.lon]);
                        }
                    });
                } else {
                    ghostPts.push([pCorner.lat, pCorner.lon]);
                }
            } else {
                ghostPts.push([pCorner.lat, pCorner.lon]);
            }
        }

        // Flight plan end
        ghostPts.push([waypoints[totalWps - 1].lat, waypoints[totalWps - 1].lon]);

        ArtState.autopilotGhostPolyline = L.polyline(ghostPts, {
            color: '#fd7e14',
            weight: 3,
            dashArray: '5, 8',
            opacity: 0.9,
            className: 'ap-ghost-route-line'
        }).addTo(ArtState.map);

        const tooltipMsg = ArtState.enableCornerLoopBacks
            ? `<strong>Autopilot Track Preview</strong><br>Simulated fly-by flight path through all flight plan waypoints & loop-backs (R = ${turnRadius.toFixed(1)} NM)`
            : `<strong>Autopilot Track Preview</strong><br>Lead-turn corner rounding (R = ${turnRadius.toFixed(1)} NM)`;

        ArtState.autopilotGhostPolyline.bindTooltip(
            tooltipMsg,
            { sticky: true, direction: 'top', offset: [0, -8] }
        );

        ArtState.autopilotGhostPolyline.on('mousemove', function (e) {
            if (!ArtState.map || !waypoints || waypoints.length < 3) return;
            const mousePt = ArtState.map.latLngToLayerPoint(e.latlng);
            let minDistSq = Infinity;
            let closestCornerIdx = -1;

            for (let i = 1; i < waypoints.length - 1; i++) {
                const cornerPt = ArtState.map.latLngToLayerPoint([waypoints[i].lat, waypoints[i].lon]);
                const distSq = (mousePt.x - cornerPt.x) ** 2 + (mousePt.y - cornerPt.y) ** 2;
                if (distSq < minDistSq) {
                    minDistSq = distSq;
                    closestCornerIdx = i;
                }
            }

            if (closestCornerIdx > 0 && Math.sqrt(minDistSq) < 70) {
                const pPrev = waypoints[closestCornerIdx - 1];
                const pCorner = waypoints[closestCornerIdx];
                const pNext = waypoints[closestCornerIdx + 1];
                const cornerAnalysis = analyzeCornerTurn(pPrev, pCorner, pNext, turnRadius);
                const wpLabel = pCorner.id || `WP${closestCornerIdx + 1}`;
                const legInDist = calculateDistanceNM(pPrev.lat, pPrev.lon, pCorner.lat, pCorner.lon);
                const legOutDist = calculateDistanceNM(pCorner.lat, pCorner.lon, pNext.lat, pNext.lon);

                this.setTooltipContent(
                    `<div style="text-align:left; line-height:1.4;">` +
                    `<div style="font-weight:700; color:#fd7e14; font-size:0.88rem;"><i class="bi bi-bezier2 me-1"></i>Autopilot Turn at ${wpLabel}</div>` +
                    `<div class="small">Turn Angle: <strong>${Math.round(cornerAnalysis.alpha)}°</strong> | Radius: <strong>${turnRadius.toFixed(1)} NM</strong></div>` +
                    `<div class="small text-danger fw-bold">Corner Cutoff: -${cornerAnalysis.dCut.toFixed(2)} NM (Lead: ${cornerAnalysis.dLead.toFixed(2)} NM)</div>` +
                    `<div class="text-muted small mt-1" style="font-size:0.72rem;">Incoming Leg: ${legInDist.toFixed(2)} NM · Outgoing Leg: ${legOutDist.toFixed(2)} NM</div>` +
                    `</div>`
                );
            } else {
                this.setTooltipContent(tooltipMsg);
            }
        });
    }

    // --- Map Rendering ---
    function clearRenderedRoute() {
        clearAutopilotGhost();
        if (ArtState.routePolyline && ArtState.map) {
            ArtState.map.removeLayer(ArtState.routePolyline);
        }
        ArtState.routePolyline = null;
        if (ArtState.transitPolylineDep && ArtState.map) {
            ArtState.map.removeLayer(ArtState.transitPolylineDep);
        }
        ArtState.transitPolylineDep = null;
        if (ArtState.transitPolylineArr && ArtState.map) {
            ArtState.map.removeLayer(ArtState.transitPolylineArr);
        }
        ArtState.transitPolylineArr = null;
        if (ArtState.mapMarkers) {
            ArtState.mapMarkers.forEach(m => {
                if (ArtState.map) {
                    try {
                        if (typeof m.isTooltipOpen === 'function' && m.isTooltipOpen()) {
                            m.closeTooltip();
                        }
                    } catch (e) {}
                    try {
                        ArtState.map.removeLayer(m);
                    } catch (e) {}
                }
            });
        }
        ArtState.mapMarkers = [];
        ArtState.midpointMarkers = [];
        if (ArtState.loopBackMarkers) {
            ArtState.loopBackMarkers.forEach(m => {
                if (ArtState.map) {
                    try {
                        if (typeof m.isTooltipOpen === 'function' && m.isTooltipOpen()) {
                            m.closeTooltip();
                        }
                    } catch (e) {}
                    try {
                        ArtState.map.removeLayer(m);
                    } catch (e) {}
                }
            });
            ArtState.loopBackMarkers = [];
        }
    }

    function updateMidpointMarkers() {
        if (!ArtState.midpointMarkers || ArtState.midpointMarkers.length === 0) return;
        for (let i = 0; i < ArtState.midpointMarkers.length; i++) {
            const midM = ArtState.midpointMarkers[i];
            if (!midM || !ArtState.projectedPoints[i] || !ArtState.projectedPoints[i + 1]) continue;
            const p1 = ArtState.projectedPoints[i];
            const p2 = ArtState.projectedPoints[i + 1];
            midM.setLatLng([(p1.lat + p2.lat) / 2, (p1.lon + p2.lon) / 2]);
            const legDist = calculateDistanceNM(p1.lat, p1.lon, p2.lat, p2.lon);
            const legBrng = Math.round(calculateBearingDeg(p1.lat, p1.lon, p2.lat, p2.lon));
            if (typeof midM.setTooltipContent === 'function') {
                midM.setTooltipContent(`<strong>Insert Waypoint</strong><br>Leg WP${i + 1} → WP${i + 2}: ${legDist.toFixed(2)} NM (${String(legBrng).padStart(3, '0')}°)`);
            }
        }
    }

    function syncWaypointVisibility() {
        const mapContainer = document.getElementById('artMap');
        if (mapContainer) {
            const isVisible = ArtState.showWaypointIndicators !== false;
            mapContainer.classList.toggle('hide-waypoint-markers', !isVisible);
        }
        const mapWpBtn = document.getElementById('mapToggleWaypointsBtn');
        if (mapWpBtn) {
            const isVisible = ArtState.showWaypointIndicators !== false;
            mapWpBtn.classList.toggle('active', isVisible);
            mapWpBtn.classList.toggle('btn-primary', isVisible);
            mapWpBtn.classList.toggle('text-white', isVisible);
            mapWpBtn.classList.toggle('btn-light', !isVisible);
            mapWpBtn.title = isVisible
                ? 'Hide Waypoint Indicators (View clean art linework)'
                : 'Show Waypoint Indicators (Numbered circles & loop points)';
        }
    }

    function getClosestLegInfo(latlng) {
        if (!ArtState.map) return null;
        const activeRoutePts = ArtState.enableCornerLoopBacks
            ? ArtState.waypoints.filter(w => !w.isAirport)
            : ArtState.projectedPoints;
        if (!activeRoutePts || activeRoutePts.length < 2) return null;

        const mousePt = ArtState.map.latLngToLayerPoint(latlng);
        let minDistSq = Infinity;
        let bestIdx = 0;

        for (let i = 0; i < activeRoutePts.length - 1; i++) {
            const pA = activeRoutePts[i];
            const pB = activeRoutePts[i + 1];
            const ptA = ArtState.map.latLngToLayerPoint([pA.lat, pA.lon]);
            const ptB = ArtState.map.latLngToLayerPoint([pB.lat, pB.lon]);
            const dx = ptB.x - ptA.x;
            const dy = ptB.y - ptA.y;
            const l2 = dx * dx + dy * dy;
            let t = 0.5;
            if (l2 > 0) {
                t = ((mousePt.x - ptA.x) * dx + (mousePt.y - ptA.y) * dy) / l2;
                t = Math.max(0, Math.min(1, t));
            }
            const projX = ptA.x + t * dx;
            const projY = ptA.y + t * dy;
            const distSq = (mousePt.x - projX) ** 2 + (mousePt.y - projY) ** 2;
            if (distSq < minDistSq) {
                minDistSq = distSq;
                bestIdx = i;
            }
        }

        const p1 = activeRoutePts[bestIdx];
        const p2 = activeRoutePts[bestIdx + 1];
        const distNM = calculateDistanceNM(p1.lat, p1.lon, p2.lat, p2.lon);
        const bearing = Math.round(calculateBearingDeg(p1.lat, p1.lon, p2.lat, p2.lon));

        const id1 = p1.id || `WP${bestIdx + 1}`;
        const id2 = p2.id || `WP${bestIdx + 2}`;

        // Turn & cutoff analysis for p1
        let cut1Info = null;
        if (bestIdx > 0) {
            const pPrev = activeRoutePts[bestIdx - 1];
            const a1 = analyzeCornerTurn(pPrev, p1, p2, ArtState.autopilotTurnRadiusNM);
            if (a1.alpha >= 12) {
                cut1Info = {
                    id: id1,
                    alpha: Math.round(a1.alpha),
                    dCut: a1.effectiveCut !== undefined ? a1.effectiveCut : a1.dCut,
                    nominalCut: a1.dCut,
                    isClamped: !!a1.isClamped,
                    effectiveRadius: a1.effectiveRadius || ArtState.autopilotTurnRadiusNM || 1.0
                };
            }
        }

        // Turn & cutoff analysis for p2
        let cut2Info = null;
        if (bestIdx + 1 < activeRoutePts.length - 1) {
            const pNext = activeRoutePts[bestIdx + 2];
            const a2 = analyzeCornerTurn(p1, p2, pNext, ArtState.autopilotTurnRadiusNM);
            if (a2.alpha >= 12) {
                cut2Info = {
                    id: id2,
                    alpha: Math.round(a2.alpha),
                    dCut: a2.effectiveCut !== undefined ? a2.effectiveCut : a2.dCut,
                    nominalCut: a2.dCut,
                    isClamped: !!a2.isClamped,
                    effectiveRadius: a2.effectiveRadius || ArtState.autopilotTurnRadiusNM || 1.0
                };
            }
        }

        return {
            index: bestIdx,
            p1,
            p2,
            id1,
            id2,
            distNM,
            bearing,
            cut1Info,
            cut2Info
        };
    }

    function buildRouteLegTooltipHtml(leg) {
        if (!leg) return "Click on route to insert waypoint";

        let html = `<div style="text-align: left; line-height: 1.4;">`;
        html += `<div style="font-weight: 700; color: #0d6efd; font-size: 0.88rem;">`;
        html += `Leg ${leg.id1} → ${leg.id2}: ${leg.distNM.toFixed(2)} NM`;
        html += `</div>`;
        html += `<div class="text-muted small" style="font-size: 0.75rem;">`;
        html += `Track: ${String(leg.bearing).padStart(3, '0')}°`;
        html += `</div>`;

        if (ArtState.showAutopilotGhost && (leg.cut1Info || leg.cut2Info)) {
            const cuts = [];
            [leg.cut1Info, leg.cut2Info].forEach(c => {
                if (!c) return;
                let cStr = `${c.id}: -${c.dCut.toFixed(2)} NM (${c.alpha}°)`;
                if (c.isClamped) {
                    cStr += ` <span class="badge bg-secondary" style="font-size:0.60rem; font-weight:normal;" title="Turn radius scaled to ${c.effectiveRadius.toFixed(1)} NM to fit short leg (Nominal: -${c.nominalCut.toFixed(2)} NM at R=${(ArtState.autopilotTurnRadiusNM || 1).toFixed(1)} NM)">clamped</span>`;
                }
                cuts.push(cStr);
            });
            html += `<div class="text-warning small mt-1" style="font-size: 0.72rem; font-weight: 600;">`;
            html += `<i class="bi bi-bezier2 me-1"></i>AP Cutoff: ${cuts.join(' · ')}`;
            html += `</div>`;
        }

        html += `<div class="text-secondary small mt-1" style="font-size: 0.70rem; border-top: 1px solid rgba(128,128,128,0.2); padding-top: 2px;">`;
        html += `<i class="bi bi-plus-circle me-1"></i>Click route to insert waypoint`;
        html += `</div>`;
        html += `</div>`;
        return html;
    }

    function renderRouteOnMap() {
        clearRenderedRoute();
        syncWaypointVisibility();

        if (ArtState.map && ArtState.map._renderer && typeof ArtState.map._renderer._reset === 'function') {
            ArtState.map._renderer._reset();
        }

        if (!ArtState.projectedPoints || ArtState.projectedPoints.length < 2) {
            clearAutopilotGhost();
            return;
        }

        const activeRoutePts = ArtState.enableCornerLoopBacks
            ? ArtState.waypoints.filter(w => !w.isAirport)
            : ArtState.projectedPoints;
        const artLatLngs = activeRoutePts.map(p => [p.lat, p.lon]);

        // Main Sky Art Polyline
        ArtState.routePolyline = L.polyline(artLatLngs, {
            color: '#0d6efd',
            weight: 5,
            opacity: 0.9,
            lineJoin: 'round',
            lineCap: 'round',
            className: 'sky-art-route-line',
            dashArray: null
        }).addTo(ArtState.map);

        ArtState.routePolyline.bindTooltip("Click on route to insert waypoint", {
            sticky: true,
            direction: 'top',
            offset: [0, -8]
        });

        ArtState.routePolyline.on('mouseover', function (e) {
            if (ArtState.drawMode) return;
            const leg = getClosestLegInfo(e.latlng);
            if (leg) {
                this.setTooltipContent(buildRouteLegTooltipHtml(leg));
            }
        });

        ArtState.routePolyline.on('mousemove', function (e) {
            if (ArtState.drawMode) return;
            const leg = getClosestLegInfo(e.latlng);
            if (leg) {
                this.setTooltipContent(buildRouteLegTooltipHtml(leg));
            }
        });

        ArtState.routePolyline.on('click', function (e) {
            if (ArtState.drawMode) return;
            L.DomEvent.stopPropagation(e);
            if (!ArtState.projectedPoints || ArtState.projectedPoints.length < 2) return;

            const clickPt = ArtState.map.latLngToLayerPoint(e.latlng);
            let minDistSq = Infinity;
            let bestIdx = -1;
            let snapLat = e.latlng.lat;
            let snapLon = e.latlng.lng;

            for (let i = 0; i < ArtState.projectedPoints.length - 1; i++) {
                const ptA = ArtState.map.latLngToLayerPoint([ArtState.projectedPoints[i].lat, ArtState.projectedPoints[i].lon]);
                const ptB = ArtState.map.latLngToLayerPoint([ArtState.projectedPoints[i + 1].lat, ArtState.projectedPoints[i + 1].lon]);
                const l2 = (ptB.x - ptA.x) ** 2 + (ptB.y - ptA.y) ** 2;
                let t = 0.5;
                if (l2 > 0) {
                    t = ((clickPt.x - ptA.x) * (ptB.x - ptA.x) + (clickPt.y - ptA.y) * (ptB.y - ptA.y)) / l2;
                    t = Math.max(0, Math.min(1, t));
                }
                const projX = ptA.x + t * (ptB.x - ptA.x);
                const projY = ptA.y + t * (ptB.y - ptA.y);
                const distSq = (clickPt.x - projX) ** 2 + (clickPt.y - projY) ** 2;
                if (distSq < minDistSq) {
                    minDistSq = distSq;
                    bestIdx = i;
                    const snapped = ArtState.map.layerPointToLatLng([projX, projY]);
                    snapLat = snapped.lat;
                    snapLon = snapped.lng;
                }
            }

            if (bestIdx >= 0) {
                insertWaypoint(bestIdx, snapLat, snapLon);
            }
        });

        // Departure Transit Line (dotted green)
        if (ArtState.includeAirport && ArtState.depAirport && ArtState.projectedPoints.length > 0) {
            const firstPt = ArtState.projectedPoints[0];
            const depDist = calculateDistanceNM(ArtState.depAirport.lat, ArtState.depAirport.lon, firstPt.lat, firstPt.lon);
            const depBrng = Math.round(calculateBearingDeg(ArtState.depAirport.lat, ArtState.depAirport.lon, firstPt.lat, firstPt.lon));
            ArtState.transitPolylineDep = L.polyline([
                [ArtState.depAirport.lat, ArtState.depAirport.lon],
                [firstPt.lat, firstPt.lon]
            ], {
                color: '#198754',
                weight: 3,
                dashArray: '6, 6',
                opacity: 0.8
            }).addTo(ArtState.map);

            ArtState.transitPolylineDep.bindTooltip(
                `<strong>Departure Transit: ${ArtState.depAirport.icao || 'DEP'} → WP1</strong><br>Distance: ${depDist.toFixed(2)} NM (Track ${String(depBrng).padStart(3, '0')}°)`,
                { sticky: true, direction: 'top', offset: [0, -5] }
            );
        }

        // Arrival Transit Line (dotted red)
        if (ArtState.includeAirport && ArtState.arrAirport && ArtState.projectedPoints.length > 0) {
            const lastPt = ArtState.projectedPoints[ArtState.projectedPoints.length - 1];
            const arrDist = calculateDistanceNM(lastPt.lat, lastPt.lon, ArtState.arrAirport.lat, ArtState.arrAirport.lon);
            const arrBrng = Math.round(calculateBearingDeg(lastPt.lat, lastPt.lon, ArtState.arrAirport.lat, ArtState.arrAirport.lon));
            ArtState.transitPolylineArr = L.polyline([
                [lastPt.lat, lastPt.lon],
                [ArtState.arrAirport.lat, ArtState.arrAirport.lon]
            ], {
                color: '#dc3545',
                weight: 3,
                dashArray: '6, 6',
                opacity: 0.8
            }).addTo(ArtState.map);

            ArtState.transitPolylineArr.bindTooltip(
                `<strong>Arrival Transit: WP${ArtState.projectedPoints.length} → ${ArtState.arrAirport.icao || 'ARR'}</strong><br>Distance: ${arrDist.toFixed(2)} NM (Track ${String(arrBrng).padStart(3, '0')}°)`,
                { sticky: true, direction: 'top', offset: [0, -5] }
            );
        }

        // Waypoint Markers
        const totalPts = ArtState.projectedPoints.length;
        const isLoopClosed = totalPts >= 3 &&
            Math.abs(ArtState.projectedPoints[0].lat - ArtState.projectedPoints[totalPts - 1].lat) < 0.0008 &&
            Math.abs(ArtState.projectedPoints[0].lon - ArtState.projectedPoints[totalPts - 1].lon) < 0.0008;

        // In a closed loop, the start and end points are the exact same physical vertex.
        // We render unique vertices (omitting the duplicate overlapping marker for the closing point)
        // so clicking/dragging the start/end vertex drags both smoothly without leaving an orphaned marker.
        const ptsToRender = isLoopClosed ? ArtState.projectedPoints.slice(0, totalPts - 1) : ArtState.projectedPoints;

        ptsToRender.forEach((pt, idx) => {
            const isFirst = idx === 0;
            const isLast = !isLoopClosed && (idx === totalPts - 1);
            let markerClass = '';
            if (isFirst) markerClass = 'first-pt';
            else if (isLast) markerClass = 'last-pt';

            // Corner turn analysis and leg distances for tooltip and highlighting
            let turnInfo = '';
            let legWarning = '';
            let pPrev = null;
            let pNext = null;
            let prevName = '';
            let nextName = '';

            if (idx > 0 && idx < totalPts - 1) {
                pPrev = ArtState.projectedPoints[idx - 1];
                prevName = `WP${idx}`;
                pNext = ArtState.projectedPoints[idx + 1];
                nextName = (isLoopClosed && (idx + 1 === totalPts - 1)) ? 'WP1' : `WP${idx + 2}`;
            } else if (idx === 0) {
                if (isLoopClosed && totalPts >= 3) {
                    pPrev = ArtState.projectedPoints[totalPts - 2];
                    prevName = `WP${totalPts - 1}`;
                } else if (ArtState.includeAirport && ArtState.depAirport) {
                    pPrev = ArtState.depAirport;
                    prevName = ArtState.depAirport.icao;
                }
                if (totalPts >= 2) {
                    pNext = ArtState.projectedPoints[1];
                    nextName = 'WP2';
                }
            } else if (idx === totalPts - 1) {
                if (totalPts >= 2) {
                    pPrev = ArtState.projectedPoints[totalPts - 2];
                    prevName = `WP${totalPts - 1}`;
                }
                if (ArtState.includeAirport && ArtState.arrAirport) {
                    pNext = ArtState.arrAirport;
                    nextName = ArtState.arrAirport.icao;
                }
            }

            const legInDist = pPrev ? calculateDistanceNM(pPrev.lat, pPrev.lon, pt.lat, pt.lon) : null;
            const legInBrng = pPrev ? Math.round(calculateBearingDeg(pPrev.lat, pPrev.lon, pt.lat, pt.lon)) : null;
            const legOutDist = pNext ? calculateDistanceNM(pt.lat, pt.lon, pNext.lat, pNext.lon) : null;
            const legOutBrng = pNext ? Math.round(calculateBearingDeg(pt.lat, pt.lon, pNext.lat, pNext.lon)) : null;

            let legsHtml = '';
            if (legInDist !== null || legOutDist !== null) {
                legsHtml = `<div class="mt-1 pt-1" style="border-top:1px solid rgba(128,128,128,0.25); font-size:0.75rem; line-height:1.4;">` +
                    (legInDist !== null ? `<div><span class="text-muted">In Leg (${prevName}):</span> <strong>${legInDist.toFixed(2)} NM</strong> <span class="text-muted">(${String(legInBrng).padStart(3, '0')}°)</span></div>` : '') +
                    (legOutDist !== null ? `<div><span class="text-muted">Out Leg (${nextName}):</span> <strong>${legOutDist.toFixed(2)} NM</strong> <span class="text-muted">(${String(legOutBrng).padStart(3, '0')}°)</span></div>` : '') +
                    `</div>`;
            }

            if (pPrev && pNext) {
                const analysis = analyzeCornerTurn(pPrev, pt, pNext, ArtState.autopilotTurnRadiusNM);
                const isOverridden = ArtState.cornerLoopOverrides[idx] !== undefined;
                const loopActive = isOverridden ? !!ArtState.cornerLoopOverrides[idx] : (analysis.alpha >= ArtState.autopilotMinAngleDeg && ArtState.enableCornerLoopBacks);
                const isSharp = analysis.alpha >= ArtState.autopilotMinAngleDeg;

                const cutDistToDisplay = analysis.effectiveCut !== undefined ? analysis.effectiveCut : analysis.dCut;
                const cutBadgeText = analysis.isClamped
                    ? `Turn: ${Math.round(analysis.alpha)}° | Cut: ${cutDistToDisplay.toFixed(2)} NM (Clamped R=${analysis.effectiveRadius.toFixed(1)} NM)`
                    : `Turn: ${Math.round(analysis.alpha)}° | Cut: ${cutDistToDisplay.toFixed(2)} NM`;

                if (isSharp || isOverridden) {
                    if (isSharp) markerClass += ' sharp-corner-marker';
                    turnInfo = `<div class="mt-1"><span class="badge ${loopActive ? 'bg-success' : 'bg-warning text-dark'} small" style="font-size:0.7rem;"><i class="bi bi-compass me-1"></i>${cutBadgeText}</span></div>` +
                        (loopActive ? `<div class="text-success small" style="font-size:0.7rem;"><i class="bi bi-check-circle-fill me-1"></i>Loop-Back Active (Click marker to toggle)</div>` : `<div class="text-warning small" style="font-size:0.7rem;"><i class="bi bi-exclamation-triangle-fill me-1"></i>Autopilot cuts corner (Click marker to toggle)</div>`);
                } else {
                    turnInfo = `<div class="text-muted small mt-1" style="font-size:0.68rem;">Turn: ${Math.round(analysis.alpha)}° (Gentle)</div>`;
                }

                if (legInDist !== null && legOutDist !== null && !loopActive) {
                    if (analysis.isClamped) {
                        legWarning = `<div class="text-warning small mt-1" style="font-size:0.7rem;"><i class="bi bi-info-circle me-1"></i>Unconstrained AP lead (${analysis.dLead.toFixed(2)} NM) exceeds leg length. Turn radius clamped to ${analysis.effectiveRadius.toFixed(2)} NM to fit.</div>`;
                    }
                }
            }

            const wpTooltipText = (isLoopClosed && isFirst
                ? `<strong>WP1 / WP${totalPts} (Start & Finish)</strong><br><span class="text-muted small">${pt.lat.toFixed(4)}°, ${pt.lon.toFixed(4)}°</span>`
                : `<strong>WP${idx + 1}</strong><br><span class="text-muted small">${pt.lat.toFixed(4)}°, ${pt.lon.toFixed(4)}°</span>`) +
                legsHtml +
                turnInfo +
                legWarning +
                `<div class="mt-1 pt-1" style="border-top:1px solid rgba(128,128,128,0.25); font-size:0.72rem;">` +
                `<span class="text-primary"><i class="bi bi-arrows-move me-1"></i>Drag to adjust</span><br>` +
                `<span class="text-danger"><i class="bi bi-trash3 me-1"></i>Right-click to delete</span>` +
                `</div>`;

            const icon = L.divIcon({
                className: 'custom-wp-icon',
                html: `<div class="waypoint-badge-marker ${markerClass}">${idx + 1}</div>`,
                iconSize: [22, 22],
                iconAnchor: [11, 11]
            });

            const marker = L.marker([pt.lat, pt.lon], {
                icon: icon,
                draggable: true
            }).addTo(ArtState.map);

            marker.bindTooltip(wpTooltipText, { direction: 'top' });

            // Click corner marker to toggle loop-back override for this individual corner
            marker.on('click', function (e) {
                if (ArtState.drawMode) return;
                if (pPrev && pNext) {
                    const analysis = analyzeCornerTurn(pPrev, pt, pNext, ArtState.autopilotTurnRadiusNM);
                    if (analysis.alpha >= ArtState.autopilotMinAngleDeg || ArtState.cornerLoopOverrides[idx] !== undefined) {
                        L.DomEvent.stopPropagation(e);
                        HistoryManager.pushState();
                        const currentlyActive = ArtState.cornerLoopOverrides[idx] !== undefined
                            ? !!ArtState.cornerLoopOverrides[idx]
                            : (analysis.alpha >= ArtState.autopilotMinAngleDeg && ArtState.enableCornerLoopBacks);
                        ArtState.cornerLoopOverrides[idx] = !currentlyActive;
                        buildFullFlightPlan();
                        renderRouteOnMap();
                        updateStatsHUD();
                        renderWaypointTable();
                    }
                }
            });

            // Right-click to delete waypoint
            marker.on('contextmenu', function (e) {
                L.DomEvent.stopPropagation(e);
                L.DomEvent.preventDefault(e);
                deleteWaypoint(idx);
            });

            // Push history before dragging
            marker.on('dragstart', function () {
                HistoryManager.pushState();
            });

            // Allow dragging individual waypoint to fine tune flight plan
            marker.on('drag', function (e) {
                const pos = e.target.getLatLng();
                ArtState.projectedPoints[idx].lat = pos.lat;
                ArtState.projectedPoints[idx].lon = pos.lng;

                // If closed loop and dragging the start/end vertex, keep closing vertex synchronized
                if (isLoopClosed && idx === 0) {
                    ArtState.projectedPoints[totalPts - 1].lat = pos.lat;
                    ArtState.projectedPoints[totalPts - 1].lon = pos.lng;
                }

                buildFullFlightPlan();
                updateStatsHUD();
                renderWaypointTable();

                // Update polylines
                const activePts = ArtState.enableCornerLoopBacks
                    ? ArtState.waypoints.filter(w => !w.isAirport)
                    : ArtState.projectedPoints;
                ArtState.routePolyline.setLatLngs(activePts.map(p => [p.lat, p.lon]));

                if (ArtState.transitPolylineDep && ArtState.projectedPoints.length > 0) {
                    ArtState.transitPolylineDep.setLatLngs([
                        [ArtState.depAirport.lat, ArtState.depAirport.lon],
                        [ArtState.projectedPoints[0].lat, ArtState.projectedPoints[0].lon]
                    ]);
                }
                if (ArtState.transitPolylineArr && ArtState.projectedPoints.length > 0) {
                    const lastPt = ArtState.projectedPoints[ArtState.projectedPoints.length - 1];
                    ArtState.transitPolylineArr.setLatLngs([
                        [lastPt.lat, lastPt.lon],
                        [ArtState.arrAirport.lat, ArtState.arrAirport.lon]
                    ]);
                }

                // Keep midpoint "+" handles stuck to the lines in real-time as waypoints are dragged
                updateMidpointMarkers();
                renderAutopilotGhost();
            });

            marker.on('dragend', function (e) {
                const pos = e.target.getLatLng();
                ArtState.projectedPoints[idx].lat = pos.lat;
                ArtState.projectedPoints[idx].lon = pos.lng;
                ArtState.basePoints[idx] = unprojectPoint(pos.lat, pos.lng);
                ArtState.rawProjectedPoints[idx] = { lat: pos.lat, lon: pos.lng };

                if (isLoopClosed && idx === 0) {
                    ArtState.projectedPoints[totalPts - 1].lat = pos.lat;
                    ArtState.projectedPoints[totalPts - 1].lon = pos.lng;
                    ArtState.basePoints[totalPts - 1] = unprojectPoint(pos.lat, pos.lng);
                    ArtState.rawProjectedPoints[totalPts - 1] = { lat: pos.lat, lon: pos.lng };
                }

                ArtState.baseContours = [ArtState.basePoints.slice()];
                ArtState.rawProjectedContours = null;

                buildFullFlightPlan();
                renderRouteOnMap();
                updateStatsHUD();
                renderWaypointTable();
            });

            ArtState.mapMarkers.push(marker);
        });

        // Loop-Back Waypoint Badges (small circular markers along exterior arcs)
        if (ArtState.enableCornerLoopBacks && ArtState.waypoints) {
            ArtState.waypoints.forEach(w => {
                if (w.isLoopWaypoint && w.id.startsWith('LP')) {
                    const isApex = w.id.endsWith('C');
                    const lpIcon = L.divIcon({
                        className: 'custom-wp-icon',
                        html: `<div class="waypoint-badge-marker loop-wp-marker" style="width:18px; height:18px; line-height:16px; font-size:10px; border-radius:50%; text-align:center;">${isApex ? '⟲' : '•'}</div>`,
                        iconSize: [18, 18],
                        iconAnchor: [9, 9]
                    });
                    const lpMarker = L.marker([w.lat, w.lon], {
                        icon: lpIcon,
                        interactive: true,
                        zIndexOffset: 900
                    }).addTo(ArtState.map);

                    lpMarker.bindTooltip(`<strong>${w.id}: ${w.name}</strong><br><span class="text-muted small">${w.lat.toFixed(4)}°, ${w.lon.toFixed(4)}°</span><br><span class="text-primary small" style="font-size:0.72rem;"><i class="bi bi-arrow-repeat me-1"></i>Exterior Loop Waypoint (R = ${ArtState.autopilotTurnRadiusNM.toFixed(1)} NM)</span>`, { direction: 'top' });
                    ArtState.loopBackMarkers.push(lpMarker);
                }
            });
        }

        // Midpoint "+" handles between consecutive waypoints for quick insertion
        ArtState.midpointMarkers = [];
        if (ArtState.projectedPoints.length <= 150) {
            for (let i = 0; i < ArtState.projectedPoints.length - 1; i++) {
                const p1 = ArtState.projectedPoints[i];
                const p2 = ArtState.projectedPoints[i + 1];
                const midLat = (p1.lat + p2.lat) / 2;
                const midLon = (p1.lon + p2.lon) / 2;
                const legDist = calculateDistanceNM(p1.lat, p1.lon, p2.lat, p2.lon);
                const legBrng = Math.round(calculateBearingDeg(p1.lat, p1.lon, p2.lat, p2.lon));

                const midIcon = L.divIcon({
                    className: 'custom-wp-midpoint-icon',
                    html: `<div class="waypoint-midpoint-marker" title="Insert waypoint (Leg WP${i + 1} → WP${i + 2}: ${legDist.toFixed(2)} NM, ${String(legBrng).padStart(3, '0')}°)">+</div>`,
                    iconSize: [16, 16],
                    iconAnchor: [8, 8]
                });

                const midMarker = L.marker([midLat, midLon], {
                    icon: midIcon,
                    interactive: true
                }).addTo(ArtState.map);

                midMarker.bindTooltip(
                    `<strong>Insert Waypoint</strong><br>Leg WP${i + 1} → WP${i + 2}: ${legDist.toFixed(2)} NM (${String(legBrng).padStart(3, '0')}°)`,
                    { direction: 'top', offset: [0, -5] }
                );

                const currentIdx = i;
                midMarker.on('click', function (e) {
                    if (ArtState.drawMode) return;
                    L.DomEvent.stopPropagation(e);
                    const curPos = midMarker.getLatLng();
                    insertWaypoint(currentIdx, curPos.lat, curPos.lng);
                });

                ArtState.mapMarkers.push(midMarker);
                ArtState.midpointMarkers.push(midMarker);
            }
        }

        // Airport Markers
        if (ArtState.includeAirport) {
            const isDepColocated = ArtState.depAirport &&
                Math.abs(ArtState.center.lat - ArtState.depAirport.lat) < 0.0008 &&
                Math.abs(ArtState.center.lon - ArtState.depAirport.lon) < 0.0008;

            if (ArtState.depAirport) {
                // If colocated with center anchor, shift badge below anchor [30, -15] so anchor is completely accessible
                const anchorY = isDepColocated ? -15 : 10;
                const depIcon = L.divIcon({
                    className: 'dep-apt-icon' + (isDepColocated ? ' colocated-with-center' : ''),
                    html: '<div class="apt-badge-inner" style="background:#198754; color:#fff; border-radius:4px; padding:2px 6px; font-weight:bold; font-size:11px; box-shadow:0 1px 4px rgba(0,0,0,0.3); border:1px solid #fff; cursor:default;">🛫 ' + ArtState.depAirport.icao + '</div>',
                    iconSize: [60, 20],
                    iconAnchor: [30, anchorY]
                });
                const depMarker = L.marker([ArtState.depAirport.lat, ArtState.depAirport.lon], {
                    icon: depIcon,
                    zIndexOffset: isDepColocated ? 1000 : 1500
                }).addTo(ArtState.map);

                const tooltipDir = isDepColocated ? 'bottom' : 'top';
                const tooltipOffset = isDepColocated ? [0, 12] : [0, -10];
                depMarker.bindTooltip(ArtState.depAirport.name + ' (Departure)', { direction: tooltipDir, offset: tooltipOffset });

                if (isDepColocated) {
                    depMarker.on('mouseover', function () {
                        const pinEl = document.querySelector('.center-pin-icon');
                        if (pinEl) pinEl.classList.add('colocated-highlight');
                    });
                    depMarker.on('mouseout', function () {
                        const pinEl = document.querySelector('.center-pin-icon');
                        if (pinEl) pinEl.classList.remove('colocated-highlight');
                    });
                }

                ArtState.mapMarkers.push(depMarker);
            }

            if (ArtState.arrAirport && (ArtState.arrAirport.icao !== ArtState.depAirport?.icao || ArtState.arrAirport.lat !== ArtState.depAirport?.lat)) {
                const isArrColocated = Math.abs(ArtState.center.lat - ArtState.arrAirport.lat) < 0.0008 &&
                    Math.abs(ArtState.center.lon - ArtState.arrAirport.lon) < 0.0008;
                const arrAnchorY = isArrColocated ? -15 : 10;
                const arrIcon = L.divIcon({
                    className: 'arr-apt-icon' + (isArrColocated ? ' colocated-with-center' : ''),
                    html: '<div class="apt-badge-inner" style="background:#dc3545; color:#fff; border-radius:4px; padding:2px 6px; font-weight:bold; font-size:11px; box-shadow:0 1px 4px rgba(0,0,0,0.3); border:1px solid #fff; cursor:default;">🛬 ' + ArtState.arrAirport.icao + '</div>',
                    iconSize: [60, 20],
                    iconAnchor: [30, arrAnchorY]
                });
                const arrMarker = L.marker([ArtState.arrAirport.lat, ArtState.arrAirport.lon], {
                    icon: arrIcon,
                    zIndexOffset: isArrColocated ? 1000 : 1500
                }).addTo(ArtState.map);

                const arrTooltipDir = isArrColocated ? 'bottom' : 'top';
                const arrTooltipOffset = isArrColocated ? [0, 12] : [0, -10];
                arrMarker.bindTooltip(ArtState.arrAirport.name + ' (Arrival)', { direction: arrTooltipDir, offset: arrTooltipOffset });

                if (isArrColocated) {
                    arrMarker.on('mouseover', function () {
                        const pinEl = document.querySelector('.center-pin-icon');
                        if (pinEl) pinEl.classList.add('colocated-highlight');
                    });
                    arrMarker.on('mouseout', function () {
                        const pinEl = document.querySelector('.center-pin-icon');
                        if (pinEl) pinEl.classList.remove('colocated-highlight');
                    });
                }

                ArtState.mapMarkers.push(arrMarker);
            }
        }

        renderAutopilotGhost();
    }

    // --- Statistics & Calculations ---
    function updateStatsHUD() {
        let totalNM = 0;
        let artNM = 0;
        let transitNM = 0;

        // Artwork legs (using full path including loop-backs if enabled)
        if (ArtState.enableCornerLoopBacks && ArtState.waypoints && ArtState.waypoints.length > 0) {
            const artWps = ArtState.waypoints.filter(w => !w.isAirport);
            for (let i = 0; i < artWps.length - 1; i++) {
                artNM += calculateDistanceNM(artWps[i].lat, artWps[i].lon, artWps[i + 1].lat, artWps[i + 1].lon);
            }
        } else {
            for (let i = 0; i < ArtState.projectedPoints.length - 1; i++) {
                const p1 = ArtState.projectedPoints[i];
                const p2 = ArtState.projectedPoints[i + 1];
                artNM += calculateDistanceNM(p1.lat, p1.lon, p2.lat, p2.lon);
            }
        }

        // Transit legs
        if (ArtState.includeAirport && ArtState.projectedPoints.length > 0) {
            if (ArtState.depAirport) {
                const first = ArtState.projectedPoints[0];
                transitNM += calculateDistanceNM(ArtState.depAirport.lat, ArtState.depAirport.lon, first.lat, first.lon);
            }
            if (ArtState.arrAirport) {
                const last = ArtState.projectedPoints[ArtState.projectedPoints.length - 1];
                transitNM += calculateDistanceNM(last.lat, last.lon, ArtState.arrAirport.lat, ArtState.arrAirport.lon);
            }
        }

        totalNM = artNM + transitNM;

        const speed = ArtState.cruiseSpeedKts || 150;
        const gph = ArtState.fuelFlowGPH || 8.5;

        const hours = totalNM / speed;
        const totalMinutes = Math.round(hours * 60);
        const dispHours = Math.floor(totalMinutes / 60);
        const dispMins = totalMinutes % 60;
        const eteStr = dispHours > 0 ? `${dispHours}h ${dispMins}m` : `${dispMins}m`;

        const fuelBurn = hours * gph;

        const elTotalDist = document.getElementById('statTotalDist');
        const elArtDist = document.getElementById('statArtDist');
        const elWaypoints = document.getElementById('statWaypoints');
        const elETE = document.getElementById('statETE');
        const elFuel = document.getElementById('statFuel');

        if (elTotalDist) elTotalDist.innerText = totalNM.toFixed(1) + ' NM';
        if (elArtDist) elArtDist.innerText = artNM.toFixed(1) + ' NM';
        if (elWaypoints) {
            const count = ArtState.waypoints.length;
            if (ArtState.enforceMaxWaypoints && ArtState.maxWaypoints > 0) {
                const max = ArtState.maxWaypoints;
                const isOver = count > max;
                elWaypoints.innerHTML = `${count} <span class="badge ${isOver ? 'bg-danger' : 'bg-primary'} text-white ms-1" title="Max waypoints limit: ${max}" style="font-size:0.65rem;">Max ${max}</span>`;
            } else if (count > 99) {
                elWaypoints.innerHTML = `${count} <span class="badge bg-warning text-dark ms-1" title="Garmin 99 waypoint limit exceeded" style="font-size:0.6rem;">>99</span>`;
            } else {
                elWaypoints.innerText = count;
            }
        }
        if (elETE) elETE.innerText = eteStr;
        if (elFuel) elFuel.innerText = fuelBurn.toFixed(1) + ' gal';

        // Autopilot corner sharpness analysis
        const pts = ArtState.projectedPoints || [];
        const totalPts = pts.length;
        const turnRadius = ArtState.autopilotTurnRadiusNM || 1.0;
        const minAngle = ArtState.autopilotMinAngleDeg || 60;
        let sharpCount = 0;
        let maxCutNM = 0;

        function checkCorner(pPrev, pCorner, pNext) {
            if (!pPrev || !pCorner || !pNext) return;
            const analysis = analyzeCornerTurn(pPrev, pCorner, pNext, turnRadius);
            if (analysis.alpha >= minAngle) {
                sharpCount++;
                if (analysis.dCut > maxCutNM) maxCutNM = analysis.dCut;
            }
        }

        // 1. Entry corner at WP 1 if coming from departure airport
        if (ArtState.includeAirport && ArtState.depAirport && totalPts >= 2) {
            checkCorner(ArtState.depAirport, pts[0], pts[1]);
        }

        // 2. Intermediate artwork corners
        for (let i = 1; i < totalPts - 1; i++) {
            checkCorner(pts[i - 1], pts[i], pts[i + 1]);
        }

        // 3. Exit corner at final point if going to arrival airport
        if (ArtState.includeAirport && ArtState.arrAirport && totalPts >= 2) {
            checkCorner(pts[totalPts - 2], pts[totalPts - 1], ArtState.arrAirport);
        }

        const badgeEl = document.getElementById('sharpCornerCountBadge');
        const summaryEl = document.getElementById('autopilotSummaryText');
        if (badgeEl) {
            badgeEl.innerText = `${sharpCount} sharp corner${sharpCount === 1 ? '' : 's'}`;
            badgeEl.className = sharpCount > 0 ? 'badge bg-warning text-dark' : 'badge bg-secondary';
        }
        if (summaryEl) {
            if (ArtState.enableCornerLoopBacks && sharpCount > 0) {
                summaryEl.innerHTML = `<span class="text-success fw-bold"><i class="bi bi-check-circle me-1"></i>${sharpCount} loop-back${sharpCount === 1 ? '' : 's'} active</span> (R = ${turnRadius.toFixed(1)} NM). Preserves sharp corners on flight tracks.`;
            } else if (sharpCount > 0) {
                summaryEl.innerHTML = `${sharpCount} sharp turn${sharpCount === 1 ? '' : 's'} (> ${minAngle}°). Autopilot cuts inside up to <strong>${maxCutNM.toFixed(2)} NM</strong>. Turn on Loop-Backs to overfly corners cleanly.`;
            } else {
                summaryEl.innerText = `No corners sharper than ${minAngle}°. Turn radius R = ${turnRadius.toFixed(1)} NM easily handled by autopilot.`;
            }
        }
    }

    // --- Waypoint Leg Table ---
    function renderWaypointTable() {
        const tbody = document.getElementById('waypointTableBody');
        if (!tbody) return;

        if (!ArtState.waypoints || ArtState.waypoints.length === 0) {
            tbody.innerHTML = '<tr><td colspan="7" class="text-center text-muted py-3">No waypoints loaded</td></tr>';
            return;
        }

        let cumDist = 0;
        let html = '';

        for (let i = 0; i < ArtState.waypoints.length; i++) {
            const wp = ArtState.waypoints[i];
            let legDist = 0;
            let legBearing = 0;

            if (i > 0) {
                const prev = ArtState.waypoints[i - 1];
                legDist = calculateDistanceNM(prev.lat, prev.lon, wp.lat, wp.lon);
                legBearing = calculateBearingDeg(prev.lat, prev.lon, wp.lat, wp.lon);
                cumDist += legDist;
            }

            let badgeStyle = '';
            let badgeClass = 'bg-primary';
            if (wp.isAirport) {
                badgeClass = 'bg-success';
            } else if (wp.isLoopWaypoint) {
                badgeClass = 'text-white';
                badgeStyle = 'style="background-color: #6f42c1;"';
            }

            html += `<tr>
                <td><span class="badge ${badgeClass}" ${badgeStyle}>${wp.id}</span></td>
                <td class="small">${wp.name}</td>
                <td class="text-nowrap font-monospace small">${wp.lat.toFixed(4)}°, ${wp.lon.toFixed(4)}°</td>
                <td>${i === 0 ? '--' : legDist.toFixed(1) + ' NM'}</td>
                <td>${i === 0 ? '--' : Math.round(legBearing) + '°'}</td>
                <td class="fw-bold">${cumDist.toFixed(1)} NM</td>
                <td class="text-center text-nowrap">
                    ${wp.isAirport ? '<span class="text-muted small opacity-50" title="Airport endpoint">--</span>' : (wp.isLoopWaypoint ? '<span class="text-muted small opacity-75" title="Auto-generated loop-back waypoint"><i class="bi bi-arrow-repeat text-purple"></i> Loop</span>' : `
                    ${wp.artIndex < ArtState.projectedPoints.length - 1 ? `
                    <button class="btn btn-outline-primary btn-sm py-0 px-2 me-1 insert-waypoint-leg-btn" data-art-idx="${wp.artIndex}" title="Insert waypoint between WP${wp.artIndex + 1} and WP${wp.artIndex + 2}">
                        <i class="bi bi-plus-lg"></i>
                    </button>` : ''}
                    <button class="btn btn-outline-danger btn-sm py-0 px-2 delete-waypoint-leg-btn" data-art-idx="${wp.artIndex}" title="Delete WP${wp.artIndex + 1}">
                        <i class="bi bi-trash3"></i>
                    </button>`)}
                </td>
            </tr>`;
        }

        tbody.innerHTML = html;

        // Attach insert listeners
        tbody.querySelectorAll('.insert-waypoint-leg-btn').forEach(btn => {
            btn.addEventListener('click', function (e) {
                e.preventDefault();
                const artIdx = parseInt(this.getAttribute('data-art-idx'), 10);
                if (!isNaN(artIdx)) {
                    insertWaypoint(artIdx);
                }
            });
        });

        // Attach delete listeners
        tbody.querySelectorAll('.delete-waypoint-leg-btn').forEach(btn => {
            btn.addEventListener('click', function (e) {
                e.preventDefault();
                const artIdx = parseInt(this.getAttribute('data-art-idx'), 10);
                if (!isNaN(artIdx)) {
                    deleteWaypoint(artIdx);
                }
            });
        });
    }

    // --- Path Chaining Helper (Nearest Neighbor TSP) ---
    function chainPathsNearestNeighbor(segments) {
        if (!segments || segments.length === 0) return [];
        if (segments.length === 1) return segments[0];

        const unvisited = [...segments];
        const chained = [...unvisited.shift()];

        while (unvisited.length > 0) {
            const lastPt = chained[chained.length - 1];
            let bestIdx = 0;
            let bestDist = Infinity;
            let shouldFlip = false;

            for (let i = 0; i < unvisited.length; i++) {
                const seg = unvisited[i];
                const startPt = seg[0];
                const endPt = seg[seg.length - 1];
                const dStart = Math.hypot(startPt.x - lastPt.x, startPt.y - lastPt.y);
                const dEnd = Math.hypot(endPt.x - lastPt.x, endPt.y - lastPt.y);

                if (dStart < bestDist) {
                    bestDist = dStart;
                    bestIdx = i;
                    shouldFlip = false;
                }
                if (dEnd < bestDist) {
                    bestDist = dEnd;
                    bestIdx = i;
                    shouldFlip = true;
                }
            }

            const [nextSeg] = unvisited.splice(bestIdx, 1);
            if (shouldFlip) nextSeg.reverse();
            chained.push(...nextSeg);
        }
        return chained;
    }

    // --- Silhouette Outline Extraction (Exterior Boundary Flood-Fill) ---
    function extractOutlineFromCanvas(canvas, options = {}) {
        const w = (options && options.width) || canvas.width;
        const h = (options && options.height) || canvas.height;
        let grid = options && options.grid;

        if (!grid) {
            const ctx = canvas.getContext('2d');
            const imgData = ctx.getImageData(0, 0, w, h);
            const data = imgData.data;

            // Detect if background is transparent vs white/light
            const cornerAlphas = [
                data[3],
                data[(w - 1) * 4 + 3],
                data[((h - 1) * w) * 4 + 3],
                data[((h - 1) * w + (w - 1)) * 4 + 3]
            ];
            const isTransparentBg = cornerAlphas.some(a => a < 30);

            grid = Array.from({ length: h }, () => new Uint8Array(w));
            let fgCount = 0;

            for (let y = 0; y < h; y++) {
                for (let x = 0; x < w; x++) {
                    const idx = (y * w + x) * 4;
                    const r = data[idx];
                    const g = data[idx + 1];
                    const b = data[idx + 2];
                    const a = data[idx + 3];

                    let isForeground = false;
                    if (isTransparentBg) {
                        isForeground = (a > 30);
                    } else {
                        const lum = (r * 299 + g * 587 + b * 114) / 1000;
                        isForeground = (a > 30 && lum < 220);
                    }

                    if (isForeground) {
                        grid[y][x] = 1;
                        fgCount++;
                    }
                }
            }

            if (fgCount < 10) {
                throw new Error("No artwork detected in image/SVG.");
            }
        }

        // Morphological dilation (radius 2) to seal sub-pixel CAD joints & panel lines
        const dilated = Array.from({ length: h }, () => new Uint8Array(w));
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                if (grid[y][x]) {
                    for (let dy = -2; dy <= 2; dy++) {
                        for (let dx = -2; dx <= 2; dx++) {
                            const ny = y + dy;
                            const nx = x + dx;
                            if (ny >= 0 && ny < h && nx >= 0 && nx < w) {
                                dilated[ny][nx] = 1;
                            }
                        }
                    }
                }
            }
        }

        // Flood fill exterior starting from canvas edges
        const exterior = Array.from({ length: h }, () => new Uint8Array(w));
        const queue = [];
        for (let x = 0; x < w; x++) {
            if (!dilated[0][x]) { exterior[0][x] = 1; queue.push([x, 0]); }
            if (!dilated[h - 1][x]) { exterior[h - 1][x] = 1; queue.push([x, h - 1]); }
        }
        for (let y = 0; y < h; y++) {
            if (!dilated[y][0] && !exterior[y][0]) { exterior[y][0] = 1; queue.push([0, y]); }
            if (!dilated[y][w - 1] && !exterior[y][w - 1]) { exterior[y][w - 1] = 1; queue.push([w - 1, y]); }
        }

        let head = 0;
        while (head < queue.length) {
            const [cx, cy] = queue[head++];
            const neighbors = [
                [cx + 1, cy],
                [cx - 1, cy],
                [cx, cy + 1],
                [cx, cy - 1]
            ];
            for (let i = 0; i < 4; i++) {
                const nx = neighbors[i][0];
                const ny = neighbors[i][1];
                if (nx >= 0 && nx < w && ny >= 0 && ny < h && !dilated[ny][nx] && !exterior[ny][nx]) {
                    exterior[ny][nx] = 1;
                    queue.push([nx, ny]);
                }
            }
        }

        // Solid interior = !exterior
        const solid = Array.from({ length: h }, () => new Uint8Array(w));
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                if (!exterior[y][x]) solid[y][x] = 1;
            }
        }

        const targetGrid = (options && options.includeHoles) ? grid : solid;

        const CLOCKWISE_8 = [
            { dx: 0, dy: -1 },  // N
            { dx: 1, dy: -1 },  // NE
            { dx: 1, dy: 0 },   // E
            { dx: 1, dy: 1 },   // SE
            { dx: 0, dy: 1 },   // S
            { dx: -1, dy: 1 },  // SW
            { dx: -1, dy: 0 },  // W
            { dx: -1, dy: -1 }  // NW
        ];

        // Find all outer/hole boundary contours of target regions
        const visitedContour = Array.from({ length: h }, () => new Uint8Array(w));
        const allContours = [];

        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                if (targetGrid[y][x] && !visitedContour[y][x] && (y === 0 || !targetGrid[y - 1][x])) {
                    const singleContour = [];
                    let cx = x;
                    let cy = y;
                    let backtrackDir = 0;
                    singleContour.push({ x: cx, y: cy });
                    visitedContour[cy][cx] = 1;

                    const maxSteps = w * h;
                    let steps = 0;

                    while (steps < maxSteps) {
                        steps++;
                        let nextX = null;
                        let nextY = null;
                        let foundDir = -1;

                        for (let i = 0; i < 8; i++) {
                            const checkIdx = (backtrackDir + i) % 8;
                            const nx = cx + CLOCKWISE_8[checkIdx].dx;
                            const ny = cy + CLOCKWISE_8[checkIdx].dy;
                            if (nx >= 0 && nx < w && ny >= 0 && ny < h && targetGrid[ny][nx]) {
                                nextX = nx;
                                nextY = ny;
                                foundDir = checkIdx;
                                break;
                            }
                        }

                        if (foundDir === -1) break;
                        if (nextX === x && nextY === y && singleContour.length > 2) break;

                        singleContour.push({ x: nextX, y: nextY });
                        visitedContour[nextY][nextX] = 1;
                        cx = nextX;
                        cy = nextY;
                        backtrackDir = (foundDir + 5) % 8;
                    }

                    if (singleContour.length >= 8) {
                        allContours.push(singleContour);
                    }
                }
            }
        }

        if (allContours.length === 0) {
            throw new Error("Could not find outer boundary of shape.");
        }

        // Filter out tiny noise specks (< 10px or < 12% / 4% of largest contour)
        const maxLen = Math.max(...allContours.map(c => c.length));
        const minSignificance = Math.max(10, maxLen * (options && options.includeHoles ? 0.04 : 0.12));
        let significantContours = allContours.filter(c => c.length >= minSignificance);

        if (significantContours.length === 0) {
            allContours.sort((a, b) => b.length - a.length);
            significantContours = [allContours[0]];
        }

        if (options && options.singleObjectOnly) {
            // Pick only the single largest object
            significantContours.sort((a, b) => b.length - a.length);
            significantContours = [significantContours[0]];
        } else {
            // Sort contours left-to-right (minX) for natural reading and flying order, top-to-bottom for ties
            significantContours.sort((a, b) => {
                const minAx = Math.min(...a.map(p => p.x));
                const minBx = Math.min(...b.map(p => p.x));
                if (Math.abs(minAx - minBx) > 2) {
                    return minAx - minBx;
                }
                const minAy = Math.min(...a.map(p => p.y));
                const minBy = Math.min(...b.map(p => p.y));
                return minAy - minBy;
            });
        }

        const offsetX = (options && options.offsetX) || 0;
        const offsetY = (options && options.offsetY) || 0;
        const mergedPoints = [];
        const contours = [];
        let prevPt = null;
        significantContours.forEach(c => {
            if (prevPt && c.length > 2) {
                let minDist = Infinity;
                let bestIdx = 0;
                for (let i = 0; i < c.length; i++) {
                    const d = (c[i].x - prevPt.x) ** 2 + (c[i].y - prevPt.y) ** 2;
                    if (d < minDist) {
                        minDist = d;
                        bestIdx = i;
                    }
                }
                if (bestIdx > 0) {
                    c = c.slice(bestIdx).concat(c.slice(0, bestIdx));
                }
            }
            c.push({ x: c[0].x, y: c[0].y });
            const simplified = ramerDouglasPeucker(c, 2.0);
            if (offsetX || offsetY) {
                simplified.forEach(p => {
                    p.x -= offsetX;
                    p.y -= offsetY;
                });
            }
            contours.push(simplified);
            mergedPoints.push(...simplified);
            prevPt = simplified[simplified.length - 1];
        });

        mergedPoints.contours = contours;
        return mergedPoints;
    }

    // --- Direct Vector SVG Path Parser (with nearest-neighbor chaining) ---
    function parseSvgDirect(svgEl, shouldFitBounds = true) {
        const container = document.createElement("div");
        container.style.position = "absolute";
        container.style.visibility = "hidden";
        container.style.width = "500px";
        container.style.height = "500px";
        container.appendChild(svgEl);
        document.body.appendChild(container);

        const pathElements = svgEl.querySelectorAll("path, polyline, line, polygon, circle, ellipse, rect");
        if (pathElements.length === 0) {
            document.body.removeChild(container);
            alert("No vector paths found in SVG.");
            return;
        }

        const segments = [];

        pathElements.forEach(el => {
            const tag = el.tagName.toLowerCase();
            const seg = [];
            if (tag === 'path') {
                const len = el.getTotalLength ? el.getTotalLength() : 0;
                if (len > 0) {
                    const numSteps = Math.max(10, Math.min(250, Math.round(len / 4)));
                    for (let s = 0; s <= numSteps; s++) {
                        const pt = el.getPointAtLength((s / numSteps) * len);
                        seg.push({ x: pt.x, y: pt.y });
                    }
                }
            } else if (tag === 'polyline' || tag === 'polygon') {
                const pts = el.points;
                if (pts) {
                    for (let p = 0; p < pts.numberOfItems; p++) {
                        const pt = pts.getItem(p);
                        seg.push({ x: pt.x, y: pt.y });
                    }
                }
            } else if (tag === 'line') {
                const x1 = el.x1?.baseVal?.value || 0;
                const y1 = el.y1?.baseVal?.value || 0;
                const x2 = el.x2?.baseVal?.value || 0;
                const y2 = el.y2?.baseVal?.value || 0;
                seg.push({ x: x1, y: y1 }, { x: x2, y: y2 });
            } else if (tag === 'rect') {
                const x = el.x?.baseVal?.value || 0;
                const y = el.y?.baseVal?.value || 0;
                const w = el.width?.baseVal?.value || 10;
                const h = el.height?.baseVal?.value || 10;
                seg.push({ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }, { x, y });
            } else if (tag === 'circle' || tag === 'ellipse') {
                const cx = (el.cx?.baseVal?.value) || 0;
                const cy = (el.cy?.baseVal?.value) || 0;
                const rx = (el.r?.baseVal?.value) || (el.rx?.baseVal?.value) || 10;
                const ry = (el.r?.baseVal?.value) || (el.ry?.baseVal?.value) || 10;
                for (let a = 0; a <= Math.PI * 2; a += 0.1) {
                    seg.push({ x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) });
                }
            }
            if (seg.length >= 2) segments.push(seg);
        });

        document.body.removeChild(container);

        if (segments.length === 0) {
            alert("SVG did not contain enough valid vector paths.");
            return;
        }

        let selectedSegments = segments;
        const mode = document.querySelector('input[name="importModeRadio"]:checked')?.value || 'lineart';
        if (mode === 'lineart') {
            const thresholdSlider = document.getElementById('importThresholdSlider');
            const sliderVal = thresholdSlider ? (parseFloat(thresholdSlider.value) || 10) : 10;
            const detailFactor = Math.max(0, Math.min(1, (sliderVal - 1) / 19.0));
            segments.sort((a, b) => b.length - a.length);
            const maxLen = segments[0].length;
            const minRatio = 0.18 * Math.pow(1.0 - detailFactor, 1.7) + 0.012;
            const minKeep = Math.max(3, maxLen * minRatio);
            const maxSegments = Math.round(4 + detailFactor * 36);
            selectedSegments = segments.filter(s => s.length >= minKeep).slice(0, maxSegments);
            if (selectedSegments.length === 0) selectedSegments = [segments[0]];

            const thresholdBadge = document.getElementById('importThresholdBadge');
            if (thresholdBadge) {
                let level = 'Medium';
                if (sliderVal <= 4) level = 'Minimal';
                else if (sliderVal <= 8) level = 'Clean';
                else if (sliderVal <= 13) level = 'Medium';
                else if (sliderVal <= 17) level = 'Detailed';
                else level = 'Full';
                const ptCount = selectedSegments.reduce((sum, c) => sum + c.length, 0);
                thresholdBadge.innerText = `${level}: ${selectedSegments.length} vectors (${ptCount} pts)`;
            }
        } else if (mode === 'singlestroke') {
            const thresholdBadge = document.getElementById('importThresholdBadge');
            if (thresholdBadge) {
                thresholdBadge.innerText = `Single Stroke (${selectedSegments.length} vectors)`;
            }
        }

        const chained = chainPathsNearestNeighbor(selectedSegments);
        const subContours = (mode === 'singlestroke') ? null : selectedSegments;
        normalizeAndSetBasePoints(chained, shouldFitBounds, subContours);
    }

    // --- Vector SVG Parser ---
    function parseSvg(svgText, shouldFitBounds = true) {
        HistoryManager.pushState();
        ArtState.sourceType = 'import';
        ArtState.strokeCount = 0;
        updateStrokeCountBadge();
        const mode = document.querySelector('input[name="importModeRadio"]:checked')?.value || 'outline';

        try {
            const parser = new DOMParser();
            const doc = parser.parseFromString(svgText, "image/svg+xml");
            const svgEl = doc.querySelector("svg");
            if (!svgEl) {
                alert("Could not find an <svg> element in the uploaded file.");
                return;
            }

            if (mode === 'outline') {
                // Outline Only: Render to canvas and extract solid exterior silhouette
                let vbW = 600, vbH = 600;
                const vb = svgEl.getAttribute("viewBox");
                if (vb) {
                    const parts = vb.trim().split(/[\s,]+/).map(Number);
                    if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) {
                        vbW = parts[2];
                        vbH = parts[3];
                    }
                } else {
                    vbW = parseFloat(svgEl.getAttribute("width")) || 600;
                    vbH = parseFloat(svgEl.getAttribute("height")) || 600;
                }

                const aspect = vbH / vbW;
                let targetW = 600, targetH = 600;
                if (aspect >= 1) {
                    targetH = 700;
                    targetW = Math.max(200, Math.round(700 / aspect));
                } else {
                    targetW = 700;
                    targetH = Math.max(200, Math.round(700 * aspect));
                }

                svgEl.setAttribute("width", targetW);
                svgEl.setAttribute("height", targetH);

                const serializer = new XMLSerializer();
                const cleanSvg = serializer.serializeToString(doc);
                const blob = new Blob([cleanSvg], { type: 'image/svg+xml;charset=utf-8' });
                const url = URL.createObjectURL(blob);
                const img = new Image();

                img.onload = function () {
                    URL.revokeObjectURL(url);
                    const canvas = document.createElement('canvas');
                    canvas.width = targetW + 60;
                    canvas.height = targetH + 60;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 30, 30, targetW, targetH);

                    try {
                        const outlinePts = extractOutlineFromCanvas(canvas);
                        if (outlinePts && outlinePts.length >= 4) {
                            normalizeAndSetBasePoints(outlinePts, shouldFitBounds);
                        } else {
                            throw new Error("Extracted outline had too few points");
                        }
                    } catch (e) {
                        console.warn("Canvas silhouette extraction fallback to vector chain:", e);
                        parseSvgDirect(svgEl, shouldFitBounds);
                    }
                };

                img.onerror = function () {
                    URL.revokeObjectURL(url);
                    parseSvgDirect(svgEl, shouldFitBounds);
                };

                img.src = url;
            } else {
                parseSvgDirect(svgEl, shouldFitBounds);
            }
        } catch (err) {
            console.error("SVG parsing error:", err);
            alert("Error parsing SVG file: " + err.message);
        }
    }

    // --- Single-Stroke Stick Font Definitions (for clean, low-waypoint text flight paths) ---
    const STICK_FONT = {
        'A': [[0, 1], [0.5, 0], [1, 1], [0.75, 0.6], [0.25, 0.6]],
        'B': [[0, 1], [0, 0], [0.7, 0], [0.9, 0.25], [0.7, 0.5], [0, 0.5], [0.8, 0.5], [1.0, 0.75], [0.8, 1], [0, 1]],
        'C': [[1, 0.2], [0.7, 0], [0.3, 0], [0, 0.3], [0, 0.7], [0.3, 1], [0.7, 1], [1, 0.8]],
        'D': [[0, 1], [0, 0], [0.6, 0], [1, 0.35], [1, 0.65], [0.6, 1], [0, 1]],
        'E': [[1, 0], [0, 0], [0, 0.5], [0.7, 0.5], [0, 0.5], [0, 1], [1, 1]],
        'F': [[0, 1], [0, 0], [1, 0], [0, 0], [0, 0.5], [0.7, 0.5]],
        'G': [[1, 0.2], [0.7, 0], [0.3, 0], [0, 0.3], [0, 0.7], [0.3, 1], [0.7, 1], [1, 0.8], [1, 0.5], [0.6, 0.5]],
        'H': [[0, 0], [0, 1], [0, 0.5], [1, 0.5], [1, 0], [1, 1]],
        'I': [[0.2, 0], [0.8, 0], [0.5, 0], [0.5, 1], [0.2, 1], [0.8, 1]],
        'J': [[0.8, 0], [0.8, 0.8], [0.6, 1], [0.2, 1], [0, 0.7]],
        'K': [[0, 0], [0, 1], [0, 0.5], [1, 0], [0, 0.5], [1, 1]],
        'L': [[0, 0], [0, 1], [1, 1]],
        'M': [[0, 1], [0, 0], [0.5, 0.6], [1, 0], [1, 1]],
        'N': [[0, 1], [0, 0], [1, 1], [1, 0]],
        'O': [[0.5, 0], [0.85, 0.15], [1, 0.5], [0.85, 0.85], [0.5, 1], [0.15, 0.85], [0, 0.5], [0.15, 0.15], [0.5, 0]],
        'P': [[0, 1], [0, 0], [0.8, 0], [1, 0.25], [0.8, 0.5], [0, 0.5]],
        'Q': [[0.5, 0], [0.85, 0.15], [1, 0.5], [0.85, 0.85], [0.5, 1], [0.15, 0.85], [0, 0.5], [0.15, 0.15], [0.5, 0], [0.7, 0.7], [1, 1]],
        'R': [[0, 1], [0, 0], [0.8, 0], [1, 0.25], [0.8, 0.5], [0, 0.5], [1, 1]],
        'S': [[1, 0.2], [0.8, 0], [0.2, 0], [0, 0.25], [0.3, 0.5], [0.7, 0.5], [1, 0.75], [0.8, 1], [0.2, 1], [0, 0.8]],
        'T': [[0, 0], [1, 0], [0.5, 0], [0.5, 1]],
        'U': [[0, 0], [0, 0.75], [0.25, 1], [0.75, 1], [1, 0.75], [1, 0]],
        'V': [[0, 0], [0.5, 1], [1, 0]],
        'W': [[0, 0], [0.25, 1], [0.5, 0.4], [0.75, 1], [1, 0]],
        'X': [[0, 0], [1, 1], [0.5, 0.5], [0, 1], [1, 0]],
        'Y': [[0, 0], [0.5, 0.5], [1, 0], [0.5, 0.5], [0.5, 1]],
        'Z': [[0, 0], [1, 0], [0, 1], [1, 1]],
        '0': [[0.5, 0], [0.85, 0.15], [1, 0.5], [0.85, 0.85], [0.5, 1], [0.15, 0.85], [0, 0.5], [0.15, 0.15], [0.5, 0]],
        '1': [[0.2, 0.2], [0.5, 0], [0.5, 1], [0.2, 1], [0.8, 1]],
        '2': [[0, 0.25], [0.2, 0], [0.8, 0], [1, 0.25], [0, 1], [1, 1]],
        '3': [[0, 0.2], [0.2, 0], [0.8, 0], [1, 0.25], [0.6, 0.5], [1, 0.75], [0.8, 1], [0.2, 1], [0, 0.8]],
        '4': [[0.8, 1], [0.8, 0], [0, 0.7], [1, 0.7]],
        '5': [[1, 0], [0, 0], [0, 0.45], [0.7, 0.45], [1, 0.65], [0.8, 1], [0.2, 1], [0, 0.8]],
        '6': [[0.8, 0.15], [0.4, 0], [0.1, 0.3], [0, 0.7], [0.3, 1], [0.7, 1], [1, 0.7], [0.7, 0.5], [0, 0.6]],
        '7': [[0, 0], [1, 0], [0.4, 1]],
        '8': [[0.5, 0.5], [0.2, 0.3], [0.3, 0], [0.7, 0], [0.8, 0.3], [0.5, 0.5], [0.8, 0.7], [0.7, 1], [0.3, 1], [0.2, 0.7], [0.5, 0.5]],
        '9': [[1, 0.4], [0.3, 0.5], [0, 0.3], [0.3, 0], [0.7, 0], [1, 0.3], [0.9, 0.7], [0.6, 1], [0.2, 0.85]],
        '-': [[0.2, 0.5], [0.8, 0.5]],
        '.': [[0.4, 0.95], [0.6, 0.95], [0.6, 1], [0.4, 1], [0.4, 0.95]],
        ' ': []
    };

    function generateStickTextArt(text) {
        const chars = text.toUpperCase().split('');
        const pts = [];
        const contours = [];
        const charWidth = 1.0;
        const charSpacing = 0.35;

        chars.forEach((ch, idx) => {
            const strokeDef = STICK_FONT[ch];
            if (!strokeDef || strokeDef.length === 0) return;
            const offsetX = idx * (charWidth + charSpacing);
            const letterPts = [];

            strokeDef.forEach(p => {
                const pt = {
                    x: offsetX + p[0],
                    y: p[1]
                };
                pts.push(pt);
                letterPts.push(pt);
            });
            if (letterPts.length > 0) {
                contours.push(letterPts);
            }
        });

        pts.contours = contours;
        return pts;
    }

    // Fast separable 1D box blur for Difference-of-Gaussians (DoG) sketch vectorization
    function boxBlur1D(src, w, h, r) {
        const temp = new Float32Array(w * h);
        for (let y = 0; y < h; y++) {
            const rowOffset = y * w;
            let winSum = 0;
            let winCount = 0;
            for (let x = -r; x <= r; x++) {
                if (x >= 0 && x < w) {
                    winSum += src[rowOffset + x];
                    winCount++;
                }
            }
            temp[rowOffset] = winSum / winCount;
            for (let x = 1; x < w; x++) {
                if (x - r - 1 >= 0) {
                    winSum -= src[rowOffset + x - r - 1];
                    winCount--;
                }
                if (x + r < w) {
                    winSum += src[rowOffset + x + r];
                    winCount++;
                }
                temp[rowOffset + x] = winSum / winCount;
            }
        }

        const dst = new Float32Array(w * h);
        for (let x = 0; x < w; x++) {
            let winSum = 0;
            let winCount = 0;
            for (let y = -r; y <= r; y++) {
                if (y >= 0 && y < h) {
                    winSum += temp[y * w + x];
                    winCount++;
                }
            }
            dst[x] = winSum / winCount;
            for (let y = 1; y < h; y++) {
                if (y - r - 1 >= 0) {
                    winSum -= temp[(y - r - 1) * w + x];
                    winCount--;
                }
                if (y + r < h) {
                    winSum += temp[(y + r) * w + x];
                    winCount++;
                }
                dst[y * w + x] = winSum / winCount;
            }
        }
        return dst;
    }

    // --- Single-Stroke Centerline Skeletonization (Zhang-Suen Thinning + Eulerian Graph Tour) ---
    // Extracts the exact 1-pixel medial axis of any line drawing regardless of line thickness,
    // and turns it into one continuous single-stroke flight path.
    function traceSingleStrokeCenterline(imgElement, shouldFitBounds = true) {
        try {
            const maxDim = 600; // Constrain to 600px for instant sub-30ms thinning
            let w = imgElement.naturalWidth || imgElement.width || 400;
            let h = imgElement.naturalHeight || imgElement.height || 400;

            if (w > maxDim || h > maxDim) {
                if (w > h) {
                    h = Math.round((h * maxDim) / w);
                    w = maxDim;
                } else {
                    w = Math.round((w * maxDim) / h);
                    h = maxDim;
                }
            }

            const canvas = document.createElement('canvas');
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(imgElement, 0, 0, w, h);
            const imgData = ctx.getImageData(0, 0, w, h).data;

            // Sensitivity / threshold slider (1 to 20, default 10)
            const thresholdSlider = document.getElementById('importThresholdSlider');
            const sliderVal = thresholdSlider ? (parseFloat(thresholdSlider.value) || 10) : 10;
            // Higher slider = higher threshold (captures lighter ink/pencil); Lower = only bold dark lines
            const inkThreshold = Math.max(90, Math.min(235, Math.round(155 + (sliderVal - 10) * 6)));

            // 1. Build flat binary grid: 1 = ink stroke, 0 = background
            const totalPixels = w * h;
            const binGrid = new Uint8Array(totalPixels);
            let inkCount = 0;

            // Suppress 3px boundary margin to eliminate any camera/screenshot crop border lines
            const borderPad = 3;
            for (let y = borderPad; y < h - borderPad; y++) {
                const rowOffset = y * w;
                for (let x = borderPad; x < w - borderPad; x++) {
                    const idx = (rowOffset + x) * 4;
                    const a = imgData[idx + 3];
                    if (a < 50) continue; // transparent pixel
                    const lum = (imgData[idx] * 299 + imgData[idx + 1] * 587 + imgData[idx + 2] * 114) / 1000;
                    if (lum < inkThreshold) {
                        binGrid[rowOffset + x] = 1;
                        inkCount++;
                    }
                }
            }

            if (inkCount < 20) {
                alert("No clear line artwork detected. Try moving the Line Sensitivity slider to More Detail.");
                return;
            }

            // 2. Zhang-Suen Thinning: Reduce strokes of ANY thickness down to an exact 1-pixel medial axis
            let changed = true;
            let maxIters = 60;
            while (changed && maxIters-- > 0) {
                changed = false;

                // Sub-iteration 1
                const toDelete1 = [];
                for (let y = 1; y < h - 1; y++) {
                    const rowOffset = y * w;
                    for (let x = 1; x < w - 1; x++) {
                        const idx = rowOffset + x;
                        if (binGrid[idx] !== 1) continue;

                        const p2 = binGrid[idx - w];
                        const p3 = binGrid[idx - w + 1];
                        const p4 = binGrid[idx + 1];
                        const p5 = binGrid[idx + w + 1];
                        const p6 = binGrid[idx + w];
                        const p7 = binGrid[idx + w - 1];
                        const p8 = binGrid[idx - 1];
                        const p9 = binGrid[idx - w - 1];

                        const B = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
                        if (B >= 2 && B <= 6) {
                            let A = 0;
                            if (p2 === 0 && p3 === 1) A++;
                            if (p3 === 0 && p4 === 1) A++;
                            if (p4 === 0 && p5 === 1) A++;
                            if (p5 === 0 && p6 === 1) A++;
                            if (p6 === 0 && p7 === 1) A++;
                            if (p7 === 0 && p8 === 1) A++;
                            if (p8 === 0 && p9 === 1) A++;
                            if (p9 === 0 && p2 === 1) A++;

                            if (A === 1) {
                                if (p2 * p4 * p6 === 0 && p4 * p6 * p8 === 0) {
                                    toDelete1.push(idx);
                                }
                            }
                        }
                    }
                }
                if (toDelete1.length > 0) {
                    for (let i = 0; i < toDelete1.length; i++) binGrid[toDelete1[i]] = 0;
                    changed = true;
                }

                // Sub-iteration 2
                const toDelete2 = [];
                for (let y = 1; y < h - 1; y++) {
                    const rowOffset = y * w;
                    for (let x = 1; x < w - 1; x++) {
                        const idx = rowOffset + x;
                        if (binGrid[idx] !== 1) continue;

                        const p2 = binGrid[idx - w];
                        const p3 = binGrid[idx - w + 1];
                        const p4 = binGrid[idx + 1];
                        const p5 = binGrid[idx + w + 1];
                        const p6 = binGrid[idx + w];
                        const p7 = binGrid[idx + w - 1];
                        const p8 = binGrid[idx - 1];
                        const p9 = binGrid[idx - w - 1];

                        const B = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
                        if (B >= 2 && B <= 6) {
                            let A = 0;
                            if (p2 === 0 && p3 === 1) A++;
                            if (p3 === 0 && p4 === 1) A++;
                            if (p4 === 0 && p5 === 1) A++;
                            if (p5 === 0 && p6 === 1) A++;
                            if (p6 === 0 && p7 === 1) A++;
                            if (p7 === 0 && p8 === 1) A++;
                            if (p8 === 0 && p9 === 1) A++;
                            if (p9 === 0 && p2 === 1) A++;

                            if (A === 1) {
                                if (p2 * p4 * p8 === 0 && p2 * p6 * p8 === 0) {
                                    toDelete2.push(idx);
                                }
                            }
                        }
                    }
                }
                if (toDelete2.length > 0) {
                    for (let i = 0; i < toDelete2.length; i++) binGrid[toDelete2[i]] = 0;
                    changed = true;
                }
            }

            // Cleanup redundant 2x2 clumps
            for (let y = 1; y < h - 1; y++) {
                const rowOffset = y * w;
                for (let x = 1; x < w - 1; x++) {
                    const idx = rowOffset + x;
                    if (binGrid[idx] === 1 && binGrid[idx + 1] === 1 && binGrid[idx + w] === 1 && binGrid[idx + w + 1] === 1) {
                        binGrid[idx] = 0;
                    }
                }
            }

            // 3. Graph Adjacency Construction
            const nbrOffsets = [
                -w - 1, -w, -w + 1,
                -1,          1,
                 w - 1,  w,  w + 1
            ];
            const adj = new Map();
            for (let y = 1; y < h - 1; y++) {
                const rowOffset = y * w;
                for (let x = 1; x < w - 1; x++) {
                    const idx = rowOffset + x;
                    if (binGrid[idx] === 1) {
                        const nbrs = [];
                        for (let k = 0; k < 8; k++) {
                            const nIdx = idx + nbrOffsets[k];
                            if (binGrid[nIdx] === 1) nbrs.push(nIdx);
                        }
                        adj.set(idx, nbrs);
                    }
                }
            }

            if (adj.size === 0) {
                alert("Could not extract centerline from image.");
                return;
            }

            // 4. Extract unbranched strokes between critical nodes (deg != 2)
            // Critical nodes are endpoints (deg = 1), junctions (deg >= 3), or isolated (deg = 0)
            const criticalNodes = [];
            for (const [u, nbrs] of adj) {
                if (nbrs.length !== 2) {
                    criticalNodes.push(u);
                }
            }

            const visitedEdges = new Set();
            const edgeKey = (a, b) => (a < b ? `${a}_${b}` : `${b}_${a}`);
            const rawStrokes = [];

            // Minimum stroke length based on slider sensitivity (filter micro-spurs/noise)
            const minStrokeLen = (sliderVal <= 5) ? 8 : (sliderVal <= 10 ? 6 : (sliderVal <= 15 ? 5 : 4));

            // Walk paths originating from critical nodes
            for (let c = 0; c < criticalNodes.length; c++) {
                const startNode = criticalNodes[c];
                const nbrs = adj.get(startNode) || [];
                for (let i = 0; i < nbrs.length; i++) {
                    const nxt = nbrs[i];
                    const eKey = edgeKey(startNode, nxt);
                    if (visitedEdges.has(eKey)) continue;
                    visitedEdges.add(eKey);

                    const stroke = [startNode, nxt];
                    let curr = nxt;
                    let prev = startNode;

                    while (true) {
                        const currNbrs = adj.get(curr) || [];
                        if (currNbrs.length !== 2) break;
                        const nextStep = (currNbrs[0] !== prev) ? currNbrs[0] : currNbrs[1];
                        const stepKey = edgeKey(curr, nextStep);
                        if (visitedEdges.has(stepKey)) break;
                        visitedEdges.add(stepKey);
                        stroke.push(nextStep);
                        prev = curr;
                        curr = nextStep;
                    }

                    if (stroke.length >= minStrokeLen) {
                        rawStrokes.push(stroke);
                    }
                }
            }

            // Also capture isolated closed loops where every node has degree == 2 (e.g. eyes, leaves, circles)
            for (const [u, nbrs] of adj) {
                if (nbrs.length === 2) {
                    for (let i = 0; i < nbrs.length; i++) {
                        const nxt = nbrs[i];
                        const eKey = edgeKey(u, nxt);
                        if (!visitedEdges.has(eKey)) {
                            visitedEdges.add(eKey);
                            const stroke = [u, nxt];
                            let curr = nxt;
                            let prev = u;
                            while (true) {
                                const currNbrs = adj.get(curr) || [];
                                if (currNbrs.length !== 2 || curr === u) break;
                                const nextStep = (currNbrs[0] !== prev) ? currNbrs[0] : currNbrs[1];
                                const stepKey = edgeKey(curr, nextStep);
                                if (visitedEdges.has(stepKey)) break;
                                visitedEdges.add(stepKey);
                                stroke.push(nextStep);
                                prev = curr;
                                curr = nextStep;
                            }
                            if (stroke.length >= minStrokeLen) {
                                rawStrokes.push(stroke);
                            }
                        }
                    }
                }
            }

            if (rawStrokes.length === 0) {
                alert("Artwork too faint or fragmented. Try increasing the sensitivity slider.");
                return;
            }

            // Sort strokes descending by pixel length
            rawStrokes.sort((a, b) => b.length - a.length);

            // Check active mode for stroke selection
            const activeMode = document.querySelector('input[name="importModeRadio"]:checked')?.value || 'singlestroke';
            let selectedStrokes = rawStrokes;
            if (activeMode === 'lineart') {
                // Line Art mode: dynamically keep most prominent strokes according to slider
                const detailFactor = Math.max(0, Math.min(1, (sliderVal - 1) / 19.0));
                const maxStrokes = Math.round(15 + detailFactor * 80);
                selectedStrokes = rawStrokes.slice(0, maxStrokes);
            }

            // Convert to {x, y} coordinate stroke arrays
            const strokePointArrays = selectedStrokes.map(s => s.map(idx => ({
                x: idx % w,
                y: Math.floor(idx / w)
            })));

            // 5. Connect all strokes into ONE continuous single stroke using Nearest-Neighbor TSP with flip
            // Each stroke is traversed FORWARD ONCE. No backtracking down-and-back along any branch!
            const unvisited = strokePointArrays.slice(1);
            const chained = [...strokePointArrays[0]];

            while (unvisited.length > 0) {
                const lastPt = chained[chained.length - 1];
                let bestDist = Infinity;
                let bestIdx = 0;
                let bestReverse = false;

                for (let i = 0; i < unvisited.length; i++) {
                    const s = unvisited[i];
                    const pStart = s[0];
                    const pEnd = s[s.length - 1];
                    const dStart = Math.hypot(pStart.x - lastPt.x, pStart.y - lastPt.y);
                    const dEnd = Math.hypot(pEnd.x - lastPt.x, pEnd.y - lastPt.y);

                    if (dStart < bestDist) {
                        bestDist = dStart;
                        bestIdx = i;
                        bestReverse = false;
                    }
                    if (dEnd < bestDist) {
                        bestDist = dEnd;
                        bestIdx = i;
                        bestReverse = true;
                    }
                }

                const [nextStroke] = unvisited.splice(bestIdx, 1);
                if (bestReverse) nextStroke.reverse();
                chained.push(...nextStroke);
            }

            // 6. Decimate waypoints: respect Max Waypoints ceiling if enforced
            let simplified = null;
            if (ArtState.enforceMaxWaypoints && ArtState.maxWaypoints > 0) {
                const targetWp = ArtState.maxWaypoints;
                let lowEps = 0.5;
                let highEps = 35.0;
                simplified = ramerDouglasPeucker(chained, 1.5);

                for (let iter = 0; iter < 16; iter++) {
                    const midEps = (lowEps + highEps) / 2;
                    const testSimp = ramerDouglasPeucker(chained, midEps);
                    if (testSimp.length > targetWp) {
                        lowEps = midEps;
                    } else {
                        simplified = testSimp;
                        highEps = midEps;
                    }
                }
            } else {
                const eps = Math.max(1.1, Math.min(3.6, 3.6 - ((sliderVal - 1) / 19.0) * 2.4));
                simplified = ramerDouglasPeucker(chained, eps);
            }

            if (!simplified || simplified.length < 4) {
                alert("Could not generate valid single-stroke waypoints.");
                return;
            }

            // Clean consecutive duplicate waypoints or sub-pixel micro-jitter
            const cleanPts = [];
            for (let i = 0; i < simplified.length; i++) {
                const pt = simplified[i];
                if (cleanPts.length > 0) {
                    const prev = cleanPts[cleanPts.length - 1];
                    if (Math.hypot(pt.x - prev.x, pt.y - prev.y) < 0.5) continue;
                }
                cleanPts.push(pt);
            }

            if (cleanPts.length < 4) {
                alert("Could not generate valid single-stroke waypoints.");
                return;
            }

            // Keep reference to decoded image for real-time slider & max waypoint adjustments
            ArtState.lastDecodedImage = imgElement;

            // Set as base points with single open contour
            normalizeAndSetBasePoints(cleanPts, shouldFitBounds, [cleanPts]);

            // Update threshold badge
            const thresholdBadge = document.getElementById('importThresholdBadge');
            if (thresholdBadge) {
                const modeName = activeMode === 'lineart' ? 'Line Art' : (activeMode === 'strokes' ? 'All Strokes' : 'Single Stroke');
                thresholdBadge.innerText = `${modeName} (${selectedStrokes.length} strokes, ${cleanPts.length} pts)`;
            }
        } catch (err) {
            console.error("Single-stroke centerline error:", err);
            alert("Error in single-stroke tracing: " + err.message);
        }
    }

    // --- Raster Image Tracer (PNG, JPEG, HEIF): Difference-of-Gaussians & Vector Sketching ---
    // Converts transparent PNGs or photos/sketches (JPEG, HEIF) into clean vector flight paths
    function traceRasterImage(imgElement, shouldFitBounds = true) {
        HistoryManager.pushState();
        ArtState.sourceType = 'import';
        ArtState.strokeCount = 0;
        updateStrokeCountBadge();

        const activeMode = document.querySelector('input[name="importModeRadio"]:checked')?.value || 'singlestroke';
        if (activeMode === 'singlestroke' || activeMode === 'lineart' || activeMode === 'strokes') {
            traceSingleStrokeCenterline(imgElement, shouldFitBounds);
            return;
        }

        try {
            const maxDim = 450; // Constrain for rapid responsive tracing
            let w = imgElement.naturalWidth || imgElement.width || 300;
            let h = imgElement.naturalHeight || imgElement.height || 300;

            if (w > maxDim || h > maxDim) {
                if (w > h) {
                    h = Math.round((h * maxDim) / w);
                    w = maxDim;
                } else {
                    w = Math.round((w * maxDim) / h);
                    h = maxDim;
                }
            }

            // Draw to source canvas
            const srcCanvas = document.createElement('canvas');
            srcCanvas.width = w;
            srcCanvas.height = h;
            const srcCtx = srcCanvas.getContext('2d');
            srcCtx.drawImage(imgElement, 0, 0, w, h);
            const srcData = srcCtx.getImageData(0, 0, w, h).data;

            // Check if image has real transparency
            let transparentPixelCount = 0;
            const totalPixels = w * h;
            const sampleStep = Math.max(1, Math.floor(totalPixels / 10000));
            for (let i = 3; i < srcData.length; i += 4 * sampleStep) {
                if (srcData[i] < 128) transparentPixelCount++;
            }
            const hasTransparency = (transparentPixelCount > 10);

            // Binarization: Build 2D binary grid [y][x] where 1 = foreground linework, 0 = background
            const grid = Array.from({ length: h }, () => new Uint8Array(w));
            let fgCount = 0;

            if (hasTransparency) {
                // Transparent PNG: alpha defines artwork
                for (let y = 0; y < h; y++) {
                    for (let x = 0; x < w; x++) {
                        const idx = (y * w + x) * 4;
                        const a = srcData[idx + 3];
                        const lum = (srcData[idx] * 299 + srcData[idx + 1] * 587 + srcData[idx + 2] * 114) / 1000;
                        if (a > 40 && lum < 220) {
                            grid[y][x] = 1;
                            fgCount++;
                        }
                    }
                }
            } else {
                // Opaque JPEG / HEIF (sketches, portraits, photos, line art)
                // Difference of Gaussians (DoG) bandpass edge detection
                const lumArr = new Float32Array(totalPixels);
                for (let i = 0; i < totalPixels; i++) {
                    const idx = i * 4;
                    lumArr[i] = (srcData[idx] * 299 + srcData[idx + 1] * 587 + srcData[idx + 2] * 114) / 1000;
                }

                // Blur 1 (r=1) and Blur 2 (r=4)
                const b1 = boxBlur1D(lumArr, w, h, 1);
                const b2 = boxBlur1D(lumArr, w, h, 4);

                // Threshold from sensitivity slider (default 10)
                const thresholdSlider = document.getElementById('importThresholdSlider');
                const sliderVal = thresholdSlider ? (parseFloat(thresholdSlider.value) || 10) : 10;
                let edgeThreshold = 8;
                const activeMode = document.querySelector('input[name="importModeRadio"]:checked')?.value || 'lineart';

                if (activeMode === 'lineart') {
                    // Smoothly adapt edge contrast threshold: lower detail = bolder edge filter (14); higher detail = finer line capture (5)
                    const df = Math.max(0, Math.min(1, (sliderVal - 1) / 19.0));
                    edgeThreshold = Math.max(5, Math.round(14 - df * 8));
                } else if (activeMode === 'strokes') {
                    edgeThreshold = Math.max(3, Math.round(18 - (sliderVal / 20.0) * 14));
                } else {
                    edgeThreshold = Math.max(4, sliderVal);
                }

                // Border margin suppression: zero out 8px boundary so camera/photo borders are never captured
                const pad = 8;
                for (let y = 0; y < h; y++) {
                    for (let x = 0; x < w; x++) {
                        if (x < pad || x >= w - pad || y < pad || y >= h - pad) {
                            grid[y][x] = 0;
                            continue;
                        }
                        const idx = y * w + x;
                        const diff = b2[idx] - b1[idx];
                        if (diff > edgeThreshold) {
                            grid[y][x] = 1;
                            fgCount++;
                        }
                    }
                }
            }

            if (fgCount < 10) {
                alert("No clear line artwork or high-contrast shape detected. Try moving the Line Detail slider to More Detail.");
                return;
            }

            const mode = document.querySelector('input[name="importModeRadio"]:checked')?.value || 'lineart';

            if (hasTransparency && mode === 'outline') {
                try {
                    const pad = 20;
                    const pw = w + pad * 2;
                    const ph = h + pad * 2;
                    const paddedGrid = Array.from({ length: ph }, () => new Uint8Array(pw));
                    for (let y = 0; y < h; y++) {
                        for (let x = 0; x < w; x++) {
                            paddedGrid[y + pad][x + pad] = grid[y][x];
                        }
                    }

                    const outlinePts = extractOutlineFromCanvas(srcCanvas, {
                        grid: paddedGrid,
                        width: pw,
                        height: ph,
                        offsetX: pad,
                        offsetY: pad,
                        singleObjectOnly: false
                    });

                    if (outlinePts && outlinePts.length >= 4) {
                        normalizeAndSetBasePoints(outlinePts, shouldFitBounds, [outlinePts]);
                        const thresholdBadge = document.getElementById('importThresholdBadge');
                        if (thresholdBadge) thresholdBadge.innerText = `Outline (${outlinePts.length} pts)`;
                        return;
                    }
                } catch (err) {
                    console.warn("Outline extraction fallback to multi-contour:", err);
                }
            }

            // Moore-neighbor boundary contour tracing
            const CLOCKWISE_8 = [
                { dx: 0, dy: -1 },  // N
                { dx: 1, dy: -1 },  // NE
                { dx: 1, dy: 0 },   // E
                { dx: 1, dy: 1 },   // SE
                { dx: 0, dy: 1 },   // S
                { dx: -1, dy: 1 },  // SW
                { dx: -1, dy: 0 },  // W
                { dx: -1, dy: -1 }  // NW
            ];

            const visited = Array.from({ length: h }, () => new Uint8Array(w));
            const contours = [];

            function isFg(x, y) {
                return x >= 0 && x < w && y >= 0 && y < h && grid[y][x] === 1;
            }

            for (let y = 0; y < h; y++) {
                for (let x = 0; x < w; x++) {
                    if (grid[y][x] === 1 && !visited[y][x] && (y === 0 || grid[y - 1][x] === 0)) {
                        const contour = [];
                        let cx = x;
                        let cy = y;
                        let backtrackDir = 0;

                        contour.push({ x: cx, y: cy });
                        const maxSteps = w * h * 2;
                        let steps = 0;

                        while (steps < maxSteps) {
                            steps++;
                            let nextX = null;
                            let nextY = null;
                            let foundDir = -1;

                            for (let i = 0; i < 8; i++) {
                                const checkIdx = (backtrackDir + i) % 8;
                                const nx = cx + CLOCKWISE_8[checkIdx].dx;
                                const ny = cy + CLOCKWISE_8[checkIdx].dy;

                                if (isFg(nx, ny)) {
                                    nextX = nx;
                                    nextY = ny;
                                    foundDir = checkIdx;
                                    break;
                                }
                            }

                            if (foundDir === -1) break;
                            if (nextX === x && nextY === y && contour.length > 2) break;

                            contour.push({ x: nextX, y: nextY });
                            cx = nextX;
                            cy = nextY;
                            backtrackDir = (foundDir + 5) % 8;
                        }

                        if (contour.length >= 15) {
                            for (let p = 0; p < contour.length; p++) {
                                visited[contour[p].y][contour[p].x] = 1;
                            }
                            contour.push({ x: contour[0].x, y: contour[0].y });
                            const simplified = ramerDouglasPeucker(contour, 1.8);
                            if (simplified.length >= 3) {
                                contours.push(simplified);
                            }
                        }
                    }
                }
            }

            if (contours.length === 0) {
                alert("Could not extract clean vector outlines from image. Try lowering the Line Detail threshold.");
                return;
            }

            // Sort contours by length descending
            contours.sort((a, b) => b.length - a.length);

            const thresholdBadge = document.getElementById('importThresholdBadge');

            if (mode === 'outline') {
                // Outline mode: take the single largest contour (subject outer silhouette)
                normalizeAndSetBasePoints(contours[0], shouldFitBounds, [contours[0]]);
                if (thresholdBadge) {
                    thresholdBadge.innerText = `Outline (${contours[0].length} pts)`;
                }
                return;
            }

            const maxLen = contours[0].length;
            const thresholdSlider = document.getElementById('importThresholdSlider');
            const sliderVal = thresholdSlider ? (parseFloat(thresholdSlider.value) || 10) : 10;
            let selectedContours = [];

            if (mode === 'lineart') {
                // Selective Line Art mode:
                // Smoothly controls feature line count and filters out secondary clutter/signatures based on the slider
                const detailFactor = Math.max(0, Math.min(1, (sliderVal - 1) / 19.0)); // 0.0 to 1.0
                const minRatio = 0.18 * Math.pow(1.0 - detailFactor, 1.7) + 0.012;
                const minKeep = Math.max(12, maxLen * minRatio);
                const maxContours = Math.round(4 + detailFactor * 36); // 4 to 40 contours

                selectedContours = contours.filter(c => c.length >= minKeep).slice(0, maxContours);
                if (selectedContours.length === 0) {
                    selectedContours = [contours[0]];
                }

                if (thresholdBadge) {
                    let level = 'Medium';
                    if (sliderVal <= 4) level = 'Minimal';
                    else if (sliderVal <= 8) level = 'Clean';
                    else if (sliderVal <= 13) level = 'Medium';
                    else if (sliderVal <= 17) level = 'Detailed';
                    else level = 'Full';
                    const ptCount = selectedContours.reduce((sum, c) => sum + c.length, 0);
                    thresholdBadge.innerText = `${level}: ${selectedContours.length} lines (${ptCount} pts)`;
                }
            } else {
                // All Vector Strokes mode: keep all significant contours up to 60
                const minKeep = Math.max(14, maxLen * 0.015);
                selectedContours = contours.filter(c => c.length >= minKeep).slice(0, 60);

                if (thresholdBadge) {
                    const ptCount = selectedContours.reduce((sum, c) => sum + c.length, 0);
                    thresholdBadge.innerText = `All: ${selectedContours.length} lines (${ptCount} pts)`;
                }
            }

            // Order and chain contours using nearest-neighbor TSP
            const chained = chainPathsNearestNeighbor(selectedContours);
            normalizeAndSetBasePoints(chained, shouldFitBounds, selectedContours);
        } catch (err) {
            console.error("Raster tracing error:", err);
            alert("Error processing image: " + err.message);
        }
    }

    // Backwards-compatible alias for text art fallback or external calls
    function tracePngImage(imgElement) {
        return traceRasterImage(imgElement);
    }

    // --- Normalize Base Points to [-0.5, 0.5] ---
    function normalizeAndSetBasePoints(points, shouldFitBounds = true, rawContours = null) {
        if (!points || points.length < 2) return;

        let minX = Infinity, maxX = -Infinity;
        let minY = Infinity, maxY = -Infinity;

        points.forEach(p => {
            if (p.x < minX) minX = p.x;
            if (p.x > maxX) maxX = p.x;
            if (p.y < minY) minY = p.y;
            if (p.y > maxY) maxY = p.y;
        });

        const spanX = maxX - minX || 1;
        const spanY = maxY - minY || 1;

        ArtState.aspectRatio = spanY / spanX;

        ArtState.basePoints = points.map(p => ({
            x: (p.x - (minX + maxX) / 2) / spanX,
            y: -((p.y - (minY + maxY) / 2) / spanY)
        }));

        const inputContours = rawContours || points.contours;
        if (inputContours && inputContours.length > 0) {
            ArtState.baseContours = inputContours.map(c => c.map(p => ({
                x: (p.x - (minX + maxX) / 2) / spanX,
                y: -((p.y - (minY + maxY) / 2) / spanY)
            })));
        } else {
            ArtState.baseContours = [ArtState.basePoints];
        }

        if (ArtState.lockAspect) {
            ArtState.heightNM = Math.max(1, Math.min(100, Math.round(ArtState.sizeNM * (ArtState.aspectRatio || 1.0) * 10) / 10));
        }

        ArtState.routeReversed = false;
        updateReverseButtons();

        syncDimensionInputs();
        applyTransformations();

        if (shouldFitBounds && ArtState.projectedPoints.length > 0) {
            const bounds = L.latLngBounds(ArtState.projectedPoints.map(p => [p.lat, p.lon]));
            ArtState.map.fitBounds(bounds, { padding: [50, 50], animate: false });
        }
    }

    // --- Shape Presets ---
    function loadPreset(shapeName) {
        HistoryManager.pushState();
        ArtState.sourceType = 'preset';
        ArtState.strokeCount = 0;
        updateStrokeCountBadge();
        const pts = [];
        if (shapeName === 'rv7') {
            const rv7Outline = [
                {"x":-0.009,"y":0.5},{"x":0.004,"y":0.5},{"x":-0.006,"y":0.453},{"x":-0.006,"y":0.068},{"x":0.29,"y":0.028},
                {"x":0.324,"y":0.177},{"x":0.392,"y":0.18},{"x":0.426,"y":0.175},{"x":0.447,"y":0.025},{"x":0.407,"y":0.011},
                {"x":0.451,"y":0.008},{"x":0.453,"y":0.014},{"x":0.462,"y":0.014},{"x":0.464,"y":0.008},{"x":0.5,"y":0.003},
                {"x":0.498,"y":-0.005},{"x":0.464,"y":-0.008},{"x":0.462,"y":-0.014},{"x":0.453,"y":-0.014},{"x":0.451,"y":-0.008},
                {"x":0.407,"y":-0.011},{"x":0.447,"y":-0.025},{"x":0.428,"y":-0.174},{"x":0.39,"y":-0.18},{"x":0.324,"y":-0.177},
                {"x":0.29,"y":-0.028},{"x":-0.004,"y":-0.067},{"x":-0.006,"y":-0.455},{"x":0.004,"y":-0.5},{"x":-0.21,"y":-0.478},
                {"x":-0.244,"y":-0.458},{"x":-0.25,"y":-0.439},{"x":-0.25,"y":-0.154},{"x":-0.275,"y":-0.151},{"x":-0.294,"y":-0.138},
                {"x":-0.292,"y":-0.126},{"x":-0.258,"y":-0.112},{"x":-0.295,"y":-0.07},{"x":-0.43,"y":-0.056},{"x":-0.437,"y":-0.028},
                {"x":-0.491,"y":-0.012},{"x":-0.5,"y":0.005},{"x":-0.475,"y":0.019},{"x":-0.441,"y":0.025},{"x":-0.43,"y":0.056},
                {"x":-0.295,"y":0.07},{"x":-0.258,"y":0.112},{"x":-0.292,"y":0.126},{"x":-0.294,"y":0.138},{"x":-0.275,"y":0.151},
                {"x":-0.25,"y":0.154},{"x":-0.25,"y":0.439},{"x":-0.237,"y":0.466},{"x":-0.21,"y":0.478},{"x":-0.011,"y":0.498}
            ];
            rv7Outline.forEach(p => pts.push({ x: p.x, y: p.y }));
            pts.push({ x: pts[0].x, y: pts[0].y }); // Explicitly close RV-7 loop
        } else if (shapeName === 'heart') {
            for (let t = 0; t <= Math.PI * 2; t += 0.08) {
                const x = 16 * Math.pow(Math.sin(t), 3);
                const y = 13 * Math.cos(t) - 5 * Math.cos(2*t) - 2 * Math.cos(3*t) - Math.cos(4*t);
                pts.push({ x: x / 35, y: y / 35 });
            }
            pts.push({ x: pts[0].x, y: pts[0].y }); // Explicitly close Heart loop
        } else if (shapeName === 'airplane') {
            const raw = [
                {x: 0, y: 1.0}, {x: 0.1, y: 0.8}, {x: 0.1, y: 0.3},
                {x: 1.0, y: -0.2}, {x: 1.0, y: -0.35}, {x: 0.1, y: -0.15},
                {x: 0.1, y: -0.7}, {x: 0.35, y: -0.85}, {x: 0.35, y: -0.95},
                {x: 0, y: -0.88},
                {x: -0.35, y: -0.95}, {x: -0.35, y: -0.85}, {x: -0.1, y: -0.7},
                {x: -0.1, y: -0.15}, {x: -1.0, y: -0.35}, {x: -1.0, y: -0.2},
                {x: -0.1, y: 0.3}, {x: -0.1, y: 0.8}, {x: 0, y: 1.0}
            ];
            raw.forEach(p => pts.push({ x: p.x * 0.5, y: p.y * 0.5 }));
        } else if (shapeName === 'star') {
            const numPoints = 5;
            for (let i = 0; i <= numPoints * 2; i++) {
                const r = i % 2 === 0 ? 0.5 : 0.22;
                const angle = (i * Math.PI / numPoints) - (Math.PI / 2);
                pts.push({ x: r * Math.cos(angle), y: r * Math.sin(angle) });
            }
        } else if (shapeName === 'clover') {
            for (let t = 0; t <= Math.PI * 2; t += 0.05) {
                const r = 0.45 * Math.cos(2 * t);
                pts.push({ x: r * Math.cos(t), y: r * Math.sin(t) });
            }
            pts.push({ x: pts[0].x, y: pts[0].y }); // Explicitly close Clover loop
        } else if (shapeName === 'diamond') {
            pts.push({x: 0, y: 0.5}, {x: 0.5, y: 0}, {x: 0, y: -0.5}, {x: -0.5, y: 0}, {x: 0, y: 0.5});
        }

        if (pts.length > 0) {
            normalizeAndSetBasePoints(pts, true, [pts]);
        }
    }

    // --- Saved Custom Drawings / Presets Management ---
    const SAVED_DRAWINGS_STORAGE_KEY = 'sky_art_saved_drawings';
    const LEGACY_SAVED_DRAWINGS_STORAGE_KEY = 'flight_art_saved_drawings';

    function getUserStorageKey() {
        return SAVED_DRAWINGS_STORAGE_KEY + '_' + getUserInstanceId();
    }

    let inMemorySavedDrawings = null;

    function getSavedDrawings() {
        if (inMemorySavedDrawings !== null) return inMemorySavedDrawings;
        try {
            const userKey = getUserStorageKey();
            let raw = localStorage.getItem(userKey);
            if (!raw) {
                // Check if user previously saved under global key
                raw = localStorage.getItem(SAVED_DRAWINGS_STORAGE_KEY) || localStorage.getItem(LEGACY_SAVED_DRAWINGS_STORAGE_KEY);
                if (raw) {
                    localStorage.setItem(userKey, raw);
                    localStorage.removeItem(SAVED_DRAWINGS_STORAGE_KEY);
                    localStorage.removeItem(LEGACY_SAVED_DRAWINGS_STORAGE_KEY);
                }
            }
            inMemorySavedDrawings = raw ? JSON.parse(raw) : [];
        } catch (err) {
            console.error("Error loading saved drawings from localStorage:", err);
            inMemorySavedDrawings = [];
        }
        return inMemorySavedDrawings;
    }

    async function syncSavedDrawingsWithServer() {
        try {
            const res = await fetch('/api/sky_art/drawings', {
                headers: getApiHeaders()
            });
            if (res.ok) {
                const serverDrawings = await res.json();
                const localDrawings = getSavedDrawings();

                const mergedMap = new Map();
                // Add server drawings first
                serverDrawings.forEach(d => mergedMap.set(d.id, d));

                // Check for local drawings that aren't on server yet, and upload them
                for (const localD of localDrawings) {
                    if (!mergedMap.has(localD.id)) {
                        mergedMap.set(localD.id, localD);
                        fetch('/api/sky_art/drawings', {
                            method: 'POST',
                            headers: getApiHeaders({ 'Content-Type': 'application/json' }),
                            body: JSON.stringify(localD)
                        }).catch(e => console.warn("Background upload error:", e));
                    }
                }

                inMemorySavedDrawings = Array.from(mergedMap.values());
                inMemorySavedDrawings.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

                try {
                    localStorage.setItem(getUserStorageKey(), JSON.stringify(inMemorySavedDrawings));
                } catch (e) {}

                renderSavedDrawingsDropdown();
            }
        } catch (err) {
            console.warn("Could not sync saved drawings with server (using local cache):", err);
        }
    }

    function saveDrawingToStorage(name) {
        if (!ArtState.basePoints || ArtState.basePoints.length < 2) {
            alert("No sky artwork to save. Please generate text, pick a preset, or draw/import a shape first.");
            return false;
        }

        const drawings = getSavedDrawings();
        const trimmedName = (name || '').trim() || `Drawing ${drawings.length + 1}`;
        const newDrawing = {
            id: 'art_' + Date.now(),
            name: trimmedName,
            createdAt: new Date().toISOString(),
            aspectRatio: ArtState.aspectRatio || 1.0,
            sizeNM: ArtState.sizeNM,
            heightNM: ArtState.heightNM,
            lockAspect: ArtState.lockAspect,
            routeReversed: ArtState.routeReversed,
            rotationDeg: ArtState.rotationDeg || 0,
            flipH: !!ArtState.flipH,
            flipV: !!ArtState.flipV,
            sourceType: ArtState.sourceType || 'saved',
            basePoints: ArtState.basePoints.map(p => ({ x: p.x, y: p.y })),
            baseContours: (ArtState.baseContours && ArtState.baseContours.length > 0)
                ? ArtState.baseContours.map(c => c.map(p => ({ x: p.x, y: p.y })))
                : [ArtState.basePoints.map(p => ({ x: p.x, y: p.y }))],
            pointCount: ArtState.basePoints.length
        };

        drawings.unshift(newDrawing); // Newest at top
        inMemorySavedDrawings = drawings;
        try {
            localStorage.setItem(getUserStorageKey(), JSON.stringify(drawings));
        } catch (err) {
            console.error("Error saving drawing to localStorage:", err);
            alert("Could not save drawing to browser storage.");
            return false;
        }

        renderSavedDrawingsDropdown();

        // Also persist to server database
        fetch('/api/sky_art/drawings', {
            method: 'POST',
            headers: getApiHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify(newDrawing)
        }).then(res => {
            if (!res.ok) console.warn("Server save returned non-OK status");
        }).catch(err => {
            console.error("Error persisting drawing to server:", err);
        });

        return true;
    }

    function deleteSavedDrawing(id) {
        let drawings = getSavedDrawings();
        drawings = drawings.filter(d => d.id !== id);
        inMemorySavedDrawings = drawings;
        try {
            localStorage.setItem(getUserStorageKey(), JSON.stringify(drawings));
        } catch (err) {
            console.error("Error updating saved drawings:", err);
        }
        renderSavedDrawingsDropdown();

        // Also delete from server database
        fetch('/api/sky_art/drawings/' + encodeURIComponent(id), {
            method: 'DELETE',
            headers: getApiHeaders()
        }).catch(err => {
            console.error("Error deleting drawing from server:", err);
        });
    }

    function loadSavedDrawing(id) {
        HistoryManager.pushState();
        const drawings = getSavedDrawings();
        const found = drawings.find(d => d.id === id);
        if (!found || !found.basePoints || found.basePoints.length === 0) {
            alert("Saved drawing not found or empty.");
            return;
        }

        // Deactivate drawing/clicking modes if active
        if (typeof toggleDrawMode === 'function') toggleDrawMode(false);
        if (typeof toggleClickMode === 'function') toggleClickMode(false);

        ArtState.sourceType = found.sourceType || 'saved';
        ArtState.strokeCount = 0;
        updateStrokeCountBadge();

        ArtState.aspectRatio = found.aspectRatio || 1.0;
        ArtState.basePoints = found.basePoints.map(p => ({ x: p.x, y: p.y }));

        // Restore baseContours if present; otherwise fallback to single contour of basePoints
        if (found.baseContours && Array.isArray(found.baseContours) && found.baseContours.length > 0) {
            ArtState.baseContours = found.baseContours.map(c => c.map(p => ({ x: p.x, y: p.y })));
        } else {
            ArtState.baseContours = [ArtState.basePoints.map(p => ({ x: p.x, y: p.y }))];
        }

        // Clear stale projected contours and points
        ArtState.rawProjectedContours = null;
        ArtState.rawProjectedPoints = null;

        // Restore rotation and flips
        ArtState.rotationDeg = (found.rotationDeg !== undefined) ? found.rotationDeg : 0;
        ArtState.flipH = !!found.flipH;
        ArtState.flipV = !!found.flipV;

        // Restore dimensions with exact aspect ratio
        if (found.sizeNM && found.heightNM) {
            ArtState.sizeNM = found.sizeNM;
            ArtState.heightNM = found.heightNM;
        } else {
            // Compute heightNM from the drawing's aspectRatio so it immediately displays in true proportion
            ArtState.heightNM = Math.max(1, Math.min(100, Math.round(ArtState.sizeNM * (ArtState.aspectRatio || 1.0) * 10) / 10));
        }

        if (found.lockAspect !== undefined) {
            ArtState.lockAspect = !!found.lockAspect;
        }

        if (found.routeReversed !== undefined) {
            ArtState.routeReversed = !!found.routeReversed;
            updateReverseButtons();
        }

        syncAllControls();
        applyTransformations();

        if (ArtState.projectedPoints && ArtState.projectedPoints.length > 0) {
            const bounds = L.latLngBounds(ArtState.projectedPoints.map(p => [p.lat, p.lon]));
            ArtState.map.fitBounds(bounds, { padding: [50, 50] });
        }

        // Update dropdown label to reflect the loaded drawing
        const labelEl = document.getElementById('tabPresetsDropdownLabel');
        if (labelEl) {
            labelEl.innerHTML = `<i class="bi bi-bookmark-check text-primary me-2"></i><strong>${found.name || 'Saved Drawing'}</strong>`;
        }
    }

    const BUILTIN_PRESETS = [
        { id: 'rv7', name: "Van's RV-7", icon: '✈️', badge: '55 pts', desc: "Van's RV-7 top silhouette" },
        { id: 'airplane', name: 'Jet Silhouette', icon: '✈️', badge: '19 pts', desc: 'Low-poly cartoon jet' },
        { id: 'heart', name: 'Heart', icon: '❤️', badge: '79 pts', desc: 'Classic parametric heart' },
        { id: 'star', name: '5-Point Star', icon: '⭐', badge: '11 pts', desc: 'Geometric 5-point star' },
        { id: 'clover', name: 'Four-Leaf Clover', icon: '🍀', badge: '126 pts', desc: 'Lucky 4-leaf clover curve' },
        { id: 'diamond', name: 'Diamond', icon: '💎', badge: '5 pts', desc: 'Geometric diamond facet' }
    ];

    function renderSavedDrawingsDropdown() {
        const drawings = getSavedDrawings();
        const container = document.getElementById('tabPresetsUnifiedContainer');
        if (!container) return;

        let html = '';

        // 1. Built-in Presets section (No delete button)
        html += `<li><h6 class="dropdown-header small py-1 text-uppercase fw-bold text-muted" style="font-size: 0.68rem; letter-spacing: 0.5px;"><i class="bi bi-stars text-warning me-1"></i> Built-in Presets</h6></li>`;

        BUILTIN_PRESETS.forEach(p => {
            html += `<li>
                <button class="dropdown-item py-1 px-3 d-flex align-items-center justify-content-between load-preset-item-btn text-start border-0 bg-transparent" type="button" data-shape="${p.id}" title="${p.desc}">
                    <span class="d-flex align-items-center text-truncate">
                        <span class="me-2">${p.icon}</span>
                        <span class="fw-semibold small text-truncate">${p.name}</span>
                    </span>
                    <span class="badge bg-light text-dark border ms-2" style="font-size: 0.65rem;">${p.badge}</span>
                </button>
            </li>`;
        });

        // 2. Divider & My Saved Drawings section (With delete button)
        html += `<li><hr class="dropdown-divider my-1"></li>`;
        html += `<li>
            <div class="d-flex justify-content-between align-items-center px-3 py-1">
                <h6 class="dropdown-header p-0 small text-uppercase fw-bold text-muted" style="font-size: 0.68rem; letter-spacing: 0.5px;">
                    <i class="bi bi-bookmark-fill text-primary me-1"></i> My Saved Drawings
                </h6>
                <span class="badge bg-primary text-white" style="font-size: 0.65rem;">${drawings.length}</span>
            </div>
        </li>`;

        if (drawings.length === 0) {
            html += `<li><span class="dropdown-item-text small text-muted fst-italic px-3 py-1">No custom saved drawings yet</span></li>`;
        } else {
            drawings.forEach(d => {
                const safeName = d.name.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
                html += `<li class="d-flex align-items-center justify-content-between px-2 py-1 saved-drawing-row">
                    <button class="dropdown-item p-1 text-truncate flex-grow-1 load-saved-drawing-btn text-start border-0 bg-transparent" type="button" data-id="${d.id}" title="${safeName}">
                        <i class="bi bi-bookmark-check text-primary me-2"></i>
                        <span class="fw-semibold small">${safeName}</span>
                        <span class="text-muted small ms-1" style="font-size:0.7rem;">(${d.pointCount || d.basePoints?.length || 0} pts)</span>
                    </button>
                    <button class="btn btn-link btn-sm text-danger p-0 px-2 delete-saved-drawing-btn" type="button" data-id="${d.id}" title="Delete saved drawing" style="text-decoration: none;">
                        <i class="bi bi-trash3 small"></i>
                    </button>
                </li>`;
            });
        }

        // 3. Save Action at the bottom
        html += `<li><hr class="dropdown-divider my-1"></li>`;
        html += `<li>
            <button class="dropdown-item small text-primary fw-semibold py-1 px-3 d-flex align-items-center gap-2 trigger-save-drawing-btn text-start border-0 bg-transparent w-100" type="button">
                <i class="bi bi-plus-circle-fill"></i> Save Current Drawing...
            </button>
        </li>`;

        container.innerHTML = html;

        // Bind built-in preset click
        container.querySelectorAll('.load-preset-item-btn').forEach(btn => {
            btn.addEventListener('click', function (e) {
                e.preventDefault();
                const shape = this.getAttribute('data-shape');
                loadPreset(shape);
                const preset = BUILTIN_PRESETS.find(p => p.id === shape);
                const labelEl = document.getElementById('tabPresetsDropdownLabel');
                if (labelEl && preset) {
                    labelEl.innerHTML = `<span class="me-2">${preset.icon}</span><strong>${preset.name}</strong>`;
                }
            });
        });

        // Bind saved drawing click
        container.querySelectorAll('.load-saved-drawing-btn').forEach(btn => {
            btn.addEventListener('click', function (e) {
                e.preventDefault();
                const id = this.getAttribute('data-id');
                loadSavedDrawing(id);
                const d = drawings.find(item => item.id === id);
                const labelEl = document.getElementById('tabPresetsDropdownLabel');
                if (labelEl && d) {
                    labelEl.innerHTML = `<i class="bi bi-bookmark-check text-primary me-2"></i><strong>${d.name}</strong>`;
                }
            });
        });

        // Bind delete button click
        container.querySelectorAll('.delete-saved-drawing-btn').forEach(btn => {
            btn.addEventListener('click', function (e) {
                e.preventDefault();
                e.stopPropagation();
                const id = this.getAttribute('data-id');
                if (confirm("Delete this saved drawing preset?")) {
                    deleteSavedDrawing(id);
                }
            });
        });

        // Bind save action click
        container.querySelectorAll('.trigger-save-drawing-btn').forEach(btn => {
            btn.addEventListener('click', function (e) {
                e.preventDefault();
                openSaveDrawingModal();
            });
        });
    }

    function openSaveDrawingModal() {
        if (!ArtState.basePoints || ArtState.basePoints.length < 2) {
            alert("No sky artwork to save. Please generate text, pick a preset, or draw/import a shape first.");
            return;
        }

        const modalPointsBadge = document.getElementById('saveDrawingModalPointsBadge');
        const modalInput = document.getElementById('saveDrawingNameInput');
        if (modalPointsBadge) modalPointsBadge.innerText = `${ArtState.basePoints.length} points`;

        const textInput = document.getElementById('textArtInput');
        const drawings = getSavedDrawings();
        if (modalInput) {
            if (textInput && textInput.value.trim().length > 0) {
                modalInput.value = textInput.value.trim().toUpperCase() + ' Art';
            } else {
                modalInput.value = `Custom Drawing ${drawings.length + 1}`;
            }
        }

        const modalEl = document.getElementById('saveDrawingModal');
        if (modalEl && typeof bootstrap !== 'undefined') {
            const modal = new bootstrap.Modal(modalEl);
            modal.show();
            setTimeout(() => {
                modalInput?.focus();
                modalInput?.select();
            }, 350);
        }
    }

    // --- Text-to-Sky Art Generator ---
    function generateTextArt(text) {
        if (!text || text.trim() === '') return;
        text = text.trim().toUpperCase();

        ArtState.sourceType = 'text';
        ArtState.strokeCount = 0;
        updateStrokeCountBadge();

        const isStick = document.getElementById('textStyleStick')?.checked;
        if (isStick) {
            const stickPts = generateStickTextArt(text);
            if (stickPts && stickPts.length >= 2) {
                normalizeAndSetBasePoints(stickPts);
                return;
            }
        }

        // Outline Mode: Draws clean outline perimeter of the text with zero solid hatching/zigzags
        const canvas = document.createElement('canvas');
        const fontSize = 100;
        const charWidth = 85;
        const totalW = Math.max(600, text.length * charWidth + 140);
        const totalH = 220;

        canvas.width = totalW;
        canvas.height = totalH;
        const ctx = canvas.getContext('2d');

        ctx.fillStyle = '#000000';
        ctx.font = `bold ${fontSize}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        // Draw each letter with generous spacing so outlines don't merge into each other
        const letterSpacing = 28;
        const chars = text.split('');
        let totalTextWidth = 0;
        const metrics = chars.map(ch => {
            const w = ctx.measureText(ch).width;
            totalTextWidth += w;
            return { ch, w };
        });
        totalTextWidth += (chars.length - 1) * letterSpacing;

        let curX = (totalW - totalTextWidth) / 2;
        const baselineY = totalH / 2;

        metrics.forEach(m => {
            ctx.fillText(m.ch, curX + m.w / 2, baselineY);
            curX += m.w + letterSpacing;
        });

        try {
            const outlinePts = extractOutlineFromCanvas(canvas, { singleObjectOnly: false, includeHoles: true });
            if (outlinePts && outlinePts.length >= 4) {
                normalizeAndSetBasePoints(outlinePts);
                return;
            }
        } catch (e) {
            console.warn("Text outline extraction fallback:", e);
        }

        tracePngImage(canvas);
    }

    // --- Smart Multi-Stroke Freehand Connection ---
    function updateStrokeCountBadge() {
        const badge = document.getElementById('strokeCountBadge');
        if (badge) {
            const count = ArtState.strokeCount || 0;
            badge.innerText = `${count} stroke${count === 1 ? '' : 's'}`;
            badge.className = count > 0 ? 'badge bg-primary text-white' : 'badge bg-light text-muted border';
        }
    }

    function smartConnectStroke(existingPoints, newStroke) {
        if (!existingPoints || existingPoints.length === 0) {
            return newStroke.slice();
        }

        const P = existingPoints.map(p => ({ lat: p.lat, lon: (p.lon !== undefined ? p.lon : p.lng) }));
        const S = newStroke.map(p => ({ lat: p.lat, lon: (p.lon !== undefined ? p.lon : p.lng) }));

        if (S.length === 0) return P;
        if (P.length === 0) return S;

        const pStart = P[0];
        const pEnd = P[P.length - 1];
        const sStart = S[0];
        const sEnd = S[S.length - 1];

        // 4 connection candidate distances
        const dEndToStart = calcDistanceNM(pEnd.lat, pEnd.lon, sStart.lat, sStart.lon);
        const dEndToEnd = calcDistanceNM(pEnd.lat, pEnd.lon, sEnd.lat, sEnd.lon);
        const dStartToEnd = calcDistanceNM(pStart.lat, pStart.lon, sEnd.lat, sEnd.lon);
        const dStartToStart = calcDistanceNM(pStart.lat, pStart.lon, sStart.lat, sStart.lon);

        const minDist = Math.min(dEndToStart, dEndToEnd, dStartToEnd, dStartToStart);
        const SNAP_THRESHOLD_NM = 0.08; // ~500 ft / 150m snap threshold

        let combined = [];

        if (minDist === dEndToStart) {
            // Append forward: P -> S
            const snap = (dEndToStart <= SNAP_THRESHOLD_NM);
            combined = P.concat(snap ? S.slice(1) : S);
        } else if (minDist === dEndToEnd) {
            // Append reversed: P -> S_reversed
            const sRev = S.slice().reverse();
            const snap = (dEndToEnd <= SNAP_THRESHOLD_NM);
            combined = P.concat(snap ? sRev.slice(1) : sRev);
        } else if (minDist === dStartToEnd) {
            // Prepend forward: S -> P
            const snap = (dStartToEnd <= SNAP_THRESHOLD_NM);
            combined = (snap ? S.slice(0, -1) : S).concat(P);
        } else {
            // Prepend reversed: S_reversed -> P
            const sRev = S.slice().reverse();
            const snap = (dStartToStart <= SNAP_THRESHOLD_NM);
            combined = (snap ? sRev.slice(0, -1) : sRev).concat(P);
        }

        return combined;
    }

    // --- Freehand and Click Drawing Setup ---
    function setupMapDrawingListeners() {
        ArtState.map.on('mousedown touchstart', function (e) {
            if (!ArtState.drawMode) return;
            ArtState.isDrawing = true;
            ArtState.currentFreehandPoints = [e.latlng];

            if (ArtState.tempFreehandPolyline) {
                ArtState.map.removeLayer(ArtState.tempFreehandPolyline);
            }

            ArtState.tempFreehandPolyline = L.polyline([e.latlng], {
                color: '#0d6efd',
                weight: 4,
                opacity: 0.8
            }).addTo(ArtState.map);

            ArtState.map.dragging.disable();
        });

        ArtState.map.on('mousemove touchmove', function (e) {
            if (!ArtState.drawMode || !ArtState.isDrawing) return;
            ArtState.currentFreehandPoints.push(e.latlng);
            ArtState.tempFreehandPolyline.addLatLng(e.latlng);
        });

        ArtState.map.on('mouseup touchend', function () {
            if (!ArtState.drawMode || !ArtState.isDrawing) return;
            ArtState.isDrawing = false;
            ArtState.map.dragging.enable();

            if (ArtState.tempFreehandPolyline) {
                ArtState.map.removeLayer(ArtState.tempFreehandPolyline);
                ArtState.tempFreehandPolyline = null;
            }

            if (ArtState.currentFreehandPoints && ArtState.currentFreehandPoints.length >= 2) {
                // Downsample raw points to eliminate micro-jitter
                const rawPts = ArtState.currentFreehandPoints.map(ll => ({
                    lat: ll.lat,
                    lon: (ll.lng !== undefined) ? ll.lng : ll.lon
                }));

                const stroke = [rawPts[0]];
                for (let i = 1; i < rawPts.length; i++) {
                    const prev = stroke[stroke.length - 1];
                    const cur = rawPts[i];
                    const d = calcDistanceNM(prev.lat, prev.lon, cur.lat, cur.lon);
                    if (d >= 0.005 || i === rawPts.length - 1) {
                        stroke.push(cur);
                    }
                }

                if (stroke.length < 2) return;

                HistoryManager.pushState();

                const isConnected = (
                    ArtState.smartConnect !== false &&
                    ArtState.sourceType === 'freehand' &&
                    ArtState.projectedPoints &&
                    ArtState.projectedPoints.length >= 2
                );

                let combined = [];
                if (isConnected) {
                    combined = smartConnectStroke(ArtState.projectedPoints, stroke);
                    ArtState.strokeCount = (ArtState.strokeCount || 1) + 1;
                } else {
                    combined = stroke;
                    ArtState.sourceType = 'freehand';
                    ArtState.strokeCount = 1;
                }

                updateStrokeCountBadge();

                // Compute geographic bounding box of combined points
                let minLat = Infinity, maxLat = -Infinity;
                let minLon = Infinity, maxLon = -Infinity;

                combined.forEach(pt => {
                    if (pt.lat < minLat) minLat = pt.lat;
                    if (pt.lat > maxLat) maxLat = pt.lat;
                    if (pt.lon < minLon) minLon = pt.lon;
                    if (pt.lon > maxLon) maxLon = pt.lon;
                });

                const centerLat = (minLat + maxLat) / 2;
                const centerLon = (minLon + maxLon) / 2;
                const cosLat = Math.cos(toRad(centerLat)) || 1.0;

                // Actual size in Nautical Miles
                const drawnWidthNM = Math.max(0.5, (maxLon - minLon) * cosLat * 60.0);
                const drawnHeightNM = Math.max(0.5, (maxLat - minLat) * 60.0);

                // Update ArtState center to where the shape was drawn
                ArtState.center.lat = centerLat;
                ArtState.center.lon = centerLon;
                if (ArtState.centerMarker) {
                    ArtState.centerMarker.setLatLng([centerLat, centerLon]);
                }

                // Update size and height in NM
                ArtState.sizeNM = Math.max(1, Math.min(100, Math.round(drawnWidthNM * 10) / 10));
                ArtState.heightNM = Math.max(1, Math.min(100, Math.round(drawnHeightNM * 10) / 10));
                ArtState.aspectRatio = drawnHeightNM / drawnWidthNM;
                ArtState.rotationDeg = 0;
                ArtState.flipH = false;
                ArtState.flipV = false;
                ArtState.routeReversed = false;

                const spanX = (maxLon - minLon) || 0.0001;
                const spanY = (maxLat - minLat) || 0.0001;

                ArtState.basePoints = combined.map(pt => ({
                    x: (pt.lon - centerLon) / spanX,
                    y: (pt.lat - centerLat) / spanY
                }));
                ArtState.baseContours = null;

                syncAllControls();
                applyTransformations();
                // Stay in drawing mode so subsequent strokes can be added continuously!
            }
        });

        ArtState.map.on('click', function (e) {
            if (!ArtState.clickMode) return;
            const newPt = {
                lat: e.latlng.lat,
                lon: e.latlng.lng
            };

            ArtState.projectedPoints.push(newPt);
            ArtState.rawProjectedPoints = ArtState.projectedPoints.map(p => ({ lat: p.lat, lon: p.lon }));
            ArtState.basePoints = ArtState.projectedPoints.map(p => unprojectPoint(p.lat, p.lon));
            ArtState.baseContours = [ArtState.basePoints.slice()];
            ArtState.rawProjectedContours = null;
            buildFullFlightPlan();
            renderRouteOnMap();
            updateStatsHUD();
            renderWaypointTable();
        });
    }

    function toggleDrawMode(active) {
        ArtState.drawMode = active;
        const btn = document.getElementById('drawModeBtn');
        const mapEl = document.getElementById('artMap');
        const statusEl = document.getElementById('drawModeStatus');

        if (active) {
            ArtState.clickMode = false;
            document.getElementById('clickModeBtn')?.classList.remove('active');
            if (btn) {
                btn.classList.add('active', 'btn-primary');
                btn.classList.remove('btn-outline-primary');
                btn.innerHTML = '<i class="bi bi-check-circle-fill me-1"></i> Finish Sketch';
            }
            if (statusEl) statusEl.classList.remove('d-none');
            mapEl.classList.add('drawing-active');
        } else {
            if (btn) {
                btn.classList.remove('active', 'btn-primary');
                btn.classList.add('btn-outline-primary');
                btn.innerHTML = '<i class="bi bi-brush-fill me-1"></i> Freehand Sketch';
            }
            if (statusEl) statusEl.classList.add('d-none');
            mapEl.classList.remove('drawing-active');
            ArtState.map.dragging.enable();
        }
    }

    function toggleClickMode(active) {
        ArtState.clickMode = active;
        const btn = document.getElementById('clickModeBtn');
        if (active) {
            ArtState.drawMode = false;
            document.getElementById('drawModeBtn')?.classList.remove('active');
            document.getElementById('artMap')?.classList.remove('drawing-active');
            if (btn) btn.classList.add('active');
        } else {
            if (btn) btn.classList.remove('active');
        }
    }

    // --- ForeFlight Formats & Exports ---
    function generateForeFlightRouteString() {
        if (!ArtState.waypoints || ArtState.waypoints.length === 0) return '';

        const parts = [];
        ArtState.waypoints.forEach(wp => {
            if (wp.isAirport) {
                parts.push(wp.id);
            } else {
                parts.push(`${wp.lat.toFixed(4)}/${wp.lon.toFixed(4)}`);
            }
        });

        return parts.join(' ');
    }

    function generateForeFlightMobileUrl() {
        const routeStr = generateForeFlightRouteString();
        if (!routeStr) return '';
        return `foreflightmobile://maps/search?q=${encodeURIComponent(routeStr)}`;
    }

    function generateGarminFplXml() {
        const nowIso = new Date().toISOString();
        const routeName = 'SKY_ART';

        let xml = `<?xml version="1.0" encoding="utf-8"?>\n`;
        xml += `<flight-plan xmlns="http://www8.garmin.com/xmlschemas/FlightPlan/v1">\n`;
        xml += `  <created>${nowIso}</created>\n`;
        xml += `  <waypoint-table>\n`;

        ArtState.waypoints.forEach(wp => {
            xml += `    <waypoint>\n`;
            xml += `      <identifier>${wp.id}</identifier>\n`;
            xml += `      <type>${wp.type}</type>\n`;
            xml += `      <country-code>${wp.isAirport ? 'US' : ''}</country-code>\n`;
            xml += `      <lat>${wp.lat.toFixed(6)}</lat>\n`;
            xml += `      <lon>${wp.lon.toFixed(6)}</lon>\n`;
            xml += `      <comment>${wp.name || wp.id}</comment>\n`;
            xml += `    </waypoint>\n`;
        });

        xml += `  </waypoint-table>\n`;
        xml += `  <route>\n`;
        xml += `    <route-name>${routeName}</route-name>\n`;
        xml += `    <flight-plan-index>1</flight-plan-index>\n`;

        ArtState.waypoints.forEach(wp => {
            xml += `    <route-point>\n`;
            xml += `      <waypoint-identifier>${wp.id}</waypoint-identifier>\n`;
            xml += `      <waypoint-type>${wp.type}</waypoint-type>\n`;
            if (wp.isAirport) {
                xml += `      <country-code>US</country-code>\n`;
            }
            xml += `    </route-point>\n`;
        });

        xml += `  </route>\n`;
        xml += `</flight-plan>\n`;

        return xml;
    }

    function generateGpxXml() {
        const routeName = 'SkyArt Flight Plan';
        let xml = `<?xml version="1.0" encoding="UTF-8"?>\n`;
        xml += `<gpx version="1.1" creator="SkyArt Flight Art Studio" xmlns="http://www.topografix.com/GPX/1/1">\n`;
        xml += `  <metadata><name>${routeName}</name></metadata>\n`;
        xml += `  <rte>\n`;
        xml += `    <name>${routeName}</name>\n`;

        ArtState.waypoints.forEach(wp => {
            xml += `    <rtept lat="${wp.lat.toFixed(6)}" lon="${wp.lon.toFixed(6)}">\n`;
            xml += `      <name>${wp.id}</name>\n`;
            xml += `      <desc>${wp.name || wp.id}</desc>\n`;
            xml += `    </rtept>\n`;
        });

        xml += `  </rte>\n`;
        xml += `</gpx>\n`;
        return xml;
    }

    function generateKmlXml() {
        const routeName = 'SkyArt Flight Plan';
        let xml = `<?xml version="1.0" encoding="UTF-8"?>\n`;
        xml += `<kml xmlns="http://www.opengis.net/kml/2.2">\n`;
        xml += `  <Document>\n`;
        xml += `    <name>${routeName}</name>\n`;
        xml += `    <Placemark>\n`;
        xml += `      <name>${routeName} Path</name>\n`;
        xml += `      <LineString>\n`;
        xml += `        <tessellate>1</tessellate>\n`;
        xml += `        <coordinates>\n`;

        ArtState.waypoints.forEach(wp => {
            xml += `          ${wp.lon.toFixed(6)},${wp.lat.toFixed(6)},0\n`;
        });

        xml += `        </coordinates>\n`;
        xml += `      </LineString>\n`;
        xml += `    </Placemark>\n`;
        xml += `  </Document>\n`;
        xml += `</kml>\n`;
        return xml;
    }

    function triggerFileDownload(content, filename, mimeType) {
        const blob = new Blob([content], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }, 100);
    }

    function showQrCodeModal() {
        const url = generateForeFlightMobileUrl();
        const routeStr = generateForeFlightRouteString();
        const container = document.getElementById('qrCodeContainer');
        const textDisplay = document.getElementById('qrCodeRouteText');

        if (!container) return;
        container.innerHTML = '';

        if (!routeStr) {
            alert("No flight plan generated yet.");
            return;
        }

        if (textDisplay) textDisplay.innerText = routeStr;

        if (typeof QRCode !== 'undefined') {
            new QRCode(container, {
                text: url,
                width: 256,
                height: 256,
                colorDark: "#000000",
                colorLight: "#ffffff",
                correctLevel: QRCode.CorrectLevel.M
            });
        }

        const modalEl = document.getElementById('foreflightQrModal');
        if (modalEl && typeof bootstrap !== 'undefined') {
            const modal = new bootstrap.Modal(modalEl);
            modal.show();
        }
    }

    // --- Helper: Generic Airport Lookup by Query ---
    function searchAirports(query, callback) {
        const q = (query || '').trim();
        if (q.length < 2) {
            callback([]);
            return;
        }
        fetch(`/api/airports/search?q=${encodeURIComponent(q)}`)
            .then(res => res.json())
            .then(data => callback(data || []))
            .catch(err => {
                console.error("Airport search error:", err);
                callback([]);
            });
    }

    // --- Single Airport Input Autocomplete & Resolver ---
    function setupSingleAirportInput(inputId, dropdownId, nameLabelId, onSelectCallback) {
        const inputEl = document.getElementById(inputId);
        const listEl = document.getElementById(dropdownId);
        const nameEl = document.getElementById(nameLabelId);
        let timeout = null;

        if (!inputEl || !listEl) return;

        inputEl.addEventListener('input', function () {
            clearTimeout(timeout);
            const q = inputEl.value.trim().toUpperCase();
            if (q.length < 2) {
                listEl.classList.add('d-none');
                listEl.innerHTML = '';
                return;
            }

            timeout = setTimeout(() => {
                searchAirports(q, function (data) {
                    if (!data || data.length === 0) {
                        listEl.innerHTML = '<div class="p-2 text-muted small">No airport found</div>';
                        listEl.classList.remove('d-none');
                        return;
                    }

                    let html = '';
                    data.forEach(ap => {
                        html += `<div class="airport-autocomplete-item" data-lat="${ap.lat}" data-lon="${ap.lon}" data-icao="${ap.icao || ap.faa}" data-name="${ap.name}">
                            <strong>${ap.icao || ap.faa}</strong> - ${ap.name} <span class="text-muted small">(${ap.city || ''}, ${ap.state || ''})</span>
                        </div>`;
                    });
                    listEl.innerHTML = html;
                    listEl.classList.remove('d-none');
                });
            }, 180);
        });

        listEl.addEventListener('click', function (e) {
            const item = e.target.closest('.airport-autocomplete-item');
            if (!item) return;

            const lat = parseFloat(item.getAttribute('data-lat'));
            const lon = parseFloat(item.getAttribute('data-lon'));
            const icao = item.getAttribute('data-icao');
            const name = item.getAttribute('data-name');

            if (!isNaN(lat) && !isNaN(lon)) {
                inputEl.value = icao;
                if (nameEl) nameEl.innerText = name;
                listEl.classList.add('d-none');
                onSelectCallback({ icao, name, lat, lon });
            }
        });

        // Resolve on blur / enter if user just typed an ICAO and pressed Tab/Enter
        function resolveDirectInput() {
            const val = inputEl.value.trim().toUpperCase();
            if (!val || val.length < 2) return;

            searchAirports(val, function (data) {
                if (data && data.length > 0) {
                    const exact = data.find(a => (a.icao || '').toUpperCase() === val || (a.faa || '').toUpperCase() === val) || data[0];
                    inputEl.value = exact.icao || exact.faa;
                    if (nameEl) nameEl.innerText = exact.name;
                    onSelectCallback({
                        icao: exact.icao || exact.faa,
                        name: exact.name,
                        lat: exact.lat,
                        lon: exact.lon
                    });
                }
            });
        }

        inputEl.addEventListener('change', resolveDirectInput);
        inputEl.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                resolveDirectInput();
                listEl.classList.add('d-none');
            }
        });

        document.addEventListener('click', function (e) {
            if (!inputEl.contains(e.target) && !listEl.contains(e.target)) {
                listEl.classList.add('d-none');
            }
        });
    }

    // --- Airport Search Autocomplete & Controls ---
    function setupAirportControls() {
        // Top Global Search Bar
        const searchInput = document.getElementById('airportSearchInput');
        const listEl = document.getElementById('airportSearchResults');
        let searchTimeout = null;

        if (searchInput && listEl) {
            searchInput.addEventListener('input', function () {
                clearTimeout(searchTimeout);
                const q = searchInput.value.trim();
                if (q.length < 2) {
                    listEl.classList.add('d-none');
                    listEl.innerHTML = '';
                    return;
                }

                searchTimeout = setTimeout(() => {
                    searchAirports(q, function (data) {
                        if (!data || data.length === 0) {
                            listEl.innerHTML = '<div class="p-2 text-muted small">No airports found</div>';
                            listEl.classList.remove('d-none');
                            return;
                        }

                        let html = '';
                        data.forEach(ap => {
                            const icao = ap.icao || ap.faa;
                            html += `<div class="airport-autocomplete-item d-flex align-items-center justify-content-between py-1 px-2" data-lat="${ap.lat}" data-lon="${ap.lon}" data-icao="${icao}" data-name="${ap.name}">
                                <div class="text-truncate flex-grow-1 pe-2" title="${icao} - ${ap.name}">
                                    <strong>${icao}</strong> - ${ap.name} <span class="text-muted small">(${ap.city || ''}, ${ap.state || ''})</span>
                                </div>
                                <button class="btn btn-outline-primary btn-sm py-0 px-2 set-search-item-home-btn text-nowrap" type="button" title="Set ${icao} as default Home Airport" style="font-size: 0.68rem;">
                                    <i class="bi bi-house-door-fill me-1"></i>Set Home
                                </button>
                            </div>`;
                        });
                        listEl.innerHTML = html;
                        listEl.classList.remove('d-none');
                    });
                }, 180);
            });

            listEl.addEventListener('click', function (e) {
                const homeBtn = e.target.closest('.set-search-item-home-btn');
                const item = e.target.closest('.airport-autocomplete-item');
                if (!item) return;

                const lat = parseFloat(item.getAttribute('data-lat'));
                const lon = parseFloat(item.getAttribute('data-lon'));
                const icao = item.getAttribute('data-icao');
                const name = item.getAttribute('data-name');
                if (isNaN(lat) || isNaN(lon)) return;

                if (homeBtn) {
                    e.preventDefault();
                    e.stopPropagation();
                    saveConfiguredHomeAirport({ icao, name, lat, lon });
                    homeBtn.innerHTML = '<i class="bi bi-check-lg text-success me-1"></i>Saved!';
                    homeBtn.classList.remove('btn-outline-primary');
                    homeBtn.classList.add('btn-success', 'text-white');
                    setTimeout(() => {
                        homeBtn.innerHTML = '<i class="bi bi-house-door-fill me-1"></i>Set Home';
                        homeBtn.classList.remove('btn-success', 'text-white');
                        homeBtn.classList.add('btn-outline-primary');
                    }, 2000);
                    return;
                }

                // Set as new center
                ArtState.center.lat = lat;
                ArtState.center.lon = lon;
                updateCenterInputs();
                if (ArtState.centerMarker) {
                    ArtState.centerMarker.setLatLng([lat, lon]);
                }
                ArtState.map.setView([lat, lon], 11);

                // Update departure & arrival airport
                ArtState.depAirport = { icao, name, lat, lon };
                ArtState.arrAirport = { icao, name, lat, lon };

                const depInput = document.getElementById('depAirportInput');
                const arrInput = document.getElementById('arrAirportInput');
                const depName = document.getElementById('depAirportName');
                const arrName = document.getElementById('arrAirportName');

                if (depInput) depInput.value = icao;
                if (arrInput) arrInput.value = icao;
                if (depName) depName.innerText = name;
                if (arrName) arrName.innerText = name;

                applyTransformations();

                listEl.classList.add('d-none');
                searchInput.value = `${icao} - ${name}`;
            });

            document.addEventListener('click', function (e) {
                if (!searchInput.contains(e.target) && !listEl.contains(e.target)) {
                    listEl.classList.add('d-none');
                }
            });
        }

        // Jump to Home Airport Button
        document.getElementById('jumpToHomeBtn')?.addEventListener('click', () => {
            const home = ArtState.homeAirport || DEFAULT_HOME_AIRPORT;
            if (home && !isNaN(home.lat) && !isNaN(home.lon)) {
                ArtState.center.lat = home.lat;
                ArtState.center.lon = home.lon;
                updateCenterInputs();
                if (ArtState.centerMarker) {
                    ArtState.centerMarker.setLatLng([home.lat, home.lon]);
                }
                ArtState.map.setView([home.lat, home.lon], 11);

                // Update departure and arrival
                ArtState.depAirport = { ...home };
                ArtState.arrAirport = { ...home };
                const depInput = document.getElementById('depAirportInput');
                const arrInput = document.getElementById('arrAirportInput');
                const depName = document.getElementById('depAirportName');
                const arrName = document.getElementById('arrAirportName');
                if (depInput) depInput.value = home.icao;
                if (arrInput) arrInput.value = home.icao;
                if (depName) depName.innerText = home.name;
                if (arrName) arrName.innerText = home.name;

                applyTransformations();
            }
        });

        // Editable Departure & Arrival Airport Inputs
        setupSingleAirportInput('depAirportInput', 'depAirportSearchResults', 'depAirportName', (airport) => {
            ArtState.depAirport = airport;
            simplifyProjectedRoute();
        });

        setupSingleAirportInput('arrAirportInput', 'arrAirportSearchResults', 'arrAirportName', (airport) => {
            ArtState.arrAirport = airport;
            simplifyProjectedRoute();
        });

        // "Round Trip" Button (Sync Arrival to Departure)
        document.getElementById('syncArrToDepBtn')?.addEventListener('click', () => {
            if (ArtState.depAirport) {
                ArtState.arrAirport = { ...ArtState.depAirport };
                const arrInput = document.getElementById('arrAirportInput');
                const arrName = document.getElementById('arrAirportName');
                if (arrInput) arrInput.value = ArtState.depAirport.icao;
                if (arrName) arrName.innerText = ArtState.depAirport.name;

                simplifyProjectedRoute();
            }
        });

        // Modal: Configure Home Airport
        let modalSelectedHome = { ...ArtState.homeAirport };
        const modalInput = document.getElementById('configHomeAirportInput');
        const modalList = document.getElementById('configHomeSearchResults');
        const airportCardHeader = document.getElementById('airportCardHeader');
        const airportCollapseEl = document.getElementById('airportControlsCollapse');

        // Reset modal state on show
        document.getElementById('configHomeAirportModal')?.addEventListener('show.bs.modal', () => {
            modalSelectedHome = { ...(ArtState.homeAirport || DEFAULT_HOME_AIRPORT) };
            if (modalInput) modalInput.value = '';
            if (modalList) {
                modalList.innerHTML = '';
                modalList.classList.add('d-none');
            }
            updateHomeAirportUI();
        });

        if (airportCardHeader && airportCollapseEl) {
            airportCardHeader.addEventListener('click', function (e) {
                if (e.target.closest('.btn')) {
                    return;
                }
                if (typeof bootstrap !== 'undefined') {
                    const bsCollapse = bootstrap.Collapse.getOrCreateInstance(airportCollapseEl);
                    bsCollapse.toggle();
                }
            });

            airportCollapseEl.addEventListener('show.bs.collapse', function () {
                airportCardHeader.classList.remove('collapsed');
                airportCardHeader.setAttribute('aria-expanded', 'true');
            });
            airportCollapseEl.addEventListener('hide.bs.collapse', function () {
                airportCardHeader.classList.add('collapsed');
                airportCardHeader.setAttribute('aria-expanded', 'false');
            });
        }
        let modalTimeout = null;

        if (modalInput && modalList) {
            modalInput.addEventListener('input', function () {
                clearTimeout(modalTimeout);
                const q = modalInput.value.trim();
                if (q.length < 2) {
                    modalList.classList.add('d-none');
                    modalList.innerHTML = '';
                    return;
                }

                modalTimeout = setTimeout(() => {
                    searchAirports(q, function (data) {
                        if (!data || data.length === 0) {
                            modalList.innerHTML = '<div class="p-2 text-muted small">No airports found</div>';
                            modalList.classList.remove('d-none');
                            return;
                        }

                        let html = '';
                        data.forEach(ap => {
                            html += `<div class="airport-autocomplete-item" data-lat="${ap.lat}" data-lon="${ap.lon}" data-icao="${ap.icao || ap.faa}" data-name="${ap.name}">
                                <strong>${ap.icao || ap.faa}</strong> - ${ap.name} <span class="text-muted small">(${ap.city || ''}, ${ap.state || ''})</span>
                            </div>`;
                        });
                        modalList.innerHTML = html;
                        modalList.classList.remove('d-none');
                    });
                }, 180);
            });

            modalList.addEventListener('click', function (e) {
                const item = e.target.closest('.airport-autocomplete-item');
                if (!item) return;

                const lat = parseFloat(item.getAttribute('data-lat'));
                const lon = parseFloat(item.getAttribute('data-lon'));
                const icao = item.getAttribute('data-icao');
                const name = item.getAttribute('data-name');

                if (!isNaN(lat) && !isNaN(lon)) {
                    modalSelectedHome = { icao, name, lat, lon };
                    document.getElementById('configHomeCurrentBadge').innerText = icao;
                    document.getElementById('configHomeCurrentName').innerText = name;
                    document.getElementById('configHomeCurrentCoords').innerText = `${lat.toFixed(4)}°, ${lon.toFixed(4)}°`;
                }

                modalList.classList.add('d-none');
                modalInput.value = `${icao} - ${name}`;
            });

            document.addEventListener('click', function (e) {
                if (!modalInput.contains(e.target) && !modalList.contains(e.target)) {
                    modalList.classList.add('d-none');
                }
            });
        }

        document.getElementById('saveHomeAirportModalBtn')?.addEventListener('click', () => {
            saveConfiguredHomeAirport(modalSelectedHome);

            // Also switch current departure & arrival to the newly chosen home airport
            ArtState.depAirport = { ...modalSelectedHome };
            ArtState.arrAirport = { ...modalSelectedHome };

            const depInput = document.getElementById('depAirportInput');
            const arrInput = document.getElementById('arrAirportInput');
            const depName = document.getElementById('depAirportName');
            const arrName = document.getElementById('arrAirportName');

            if (depInput) depInput.value = modalSelectedHome.icao;
            if (arrInput) arrInput.value = modalSelectedHome.icao;
            if (depName) depName.innerText = modalSelectedHome.name;
            if (arrName) arrName.innerText = modalSelectedHome.name;

            buildFullFlightPlan();
            renderRouteOnMap();
            updateStatsHUD();
            renderWaypointTable();

            const modalEl = document.getElementById('configHomeAirportModal');
            if (modalEl && typeof bootstrap !== 'undefined') {
                const modal = bootstrap.Modal.getInstance(modalEl);
                if (modal) modal.hide();
            }
        });
    }

    // --- UI Controls Binding ---
    function bindUiControls() {
        // Undo / Redo Buttons
        ['undoBtn', 'mapUndoBtn'].forEach(id => {
            document.getElementById(id)?.addEventListener('click', () => HistoryManager.undo());
        });
        ['redoBtn', 'mapRedoBtn'].forEach(id => {
            document.getElementById(id)?.addEventListener('click', () => HistoryManager.redo());
        });

        // Theme toggle button listener (syncs map base layer on click)
        document.getElementById('themeToggle')?.addEventListener('click', () => {
            setTimeout(() => {
                const isDark = document.body.classList.contains('dark-mode');
                setMapBaseLayerForTheme(isDark);
            }, 0);
        });

        // Global Keyboard Shortcuts (Cmd+Z / Ctrl+Z for Undo, Cmd+Shift+Z / Ctrl+Y for Redo)
        document.addEventListener('keydown', (e) => {
            const tag = (e.target.tagName || '').toLowerCase();
            if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return;

            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
                e.preventDefault();
                if (e.shiftKey) {
                    HistoryManager.redo();
                } else {
                    HistoryManager.undo();
                }
            } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
                e.preventDefault();
                HistoryManager.redo();
            }
        });

        // Width (Size) Slider & Input
        const sizeSlider = document.getElementById('sizeSlider');
        const sizeInput = document.getElementById('sizeInput');
        if (sizeSlider && sizeInput) {
            sizeSlider.addEventListener('mousedown', () => HistoryManager.pushState());
            sizeSlider.addEventListener('touchstart', () => HistoryManager.pushState(), { passive: true });
            sizeInput.addEventListener('focus', () => HistoryManager.pushState());

            sizeSlider.addEventListener('input', () => {
                ArtState.sizeNM = parseFloat(sizeSlider.value) || 12;
                if (ArtState.lockAspect) {
                    ArtState.heightNM = Math.max(1, Math.min(100, Math.round(ArtState.sizeNM * (ArtState.aspectRatio || 1.0) * 10) / 10));
                }
                syncDimensionInputs();
                applyTransformations();
            });
            sizeInput.addEventListener('change', () => {
                ArtState.sizeNM = Math.max(1, Math.min(100, parseFloat(sizeInput.value) || 12));
                if (ArtState.lockAspect) {
                    ArtState.heightNM = Math.max(1, Math.min(100, Math.round(ArtState.sizeNM * (ArtState.aspectRatio || 1.0) * 10) / 10));
                }
                syncDimensionInputs();
                applyTransformations();
            });
        }

        // Height Slider & Input
        const heightSlider = document.getElementById('heightSlider');
        const heightInput = document.getElementById('heightInput');
        if (heightSlider && heightInput) {
            heightSlider.addEventListener('mousedown', () => HistoryManager.pushState());
            heightSlider.addEventListener('touchstart', () => HistoryManager.pushState(), { passive: true });
            heightInput.addEventListener('focus', () => HistoryManager.pushState());

            heightSlider.addEventListener('input', () => {
                ArtState.heightNM = parseFloat(heightSlider.value) || 12;
                if (ArtState.lockAspect) {
                    const asp = ArtState.aspectRatio || 1.0;
                    ArtState.sizeNM = Math.max(1, Math.min(100, Math.round((ArtState.heightNM / asp) * 10) / 10));
                }
                syncDimensionInputs();
                applyTransformations();
            });
            heightInput.addEventListener('change', () => {
                ArtState.heightNM = Math.max(1, Math.min(100, parseFloat(heightInput.value) || 12));
                if (ArtState.lockAspect) {
                    const asp = ArtState.aspectRatio || 1.0;
                    ArtState.sizeNM = Math.max(1, Math.min(100, Math.round((ArtState.heightNM / asp) * 10) / 10));
                }
                syncDimensionInputs();
                applyTransformations();
            });
        }

        // Aspect Ratio Lock Toggle Button
        document.getElementById('aspectLockBtn')?.addEventListener('click', () => {
            HistoryManager.pushState();
            ArtState.lockAspect = !ArtState.lockAspect;
            if (ArtState.lockAspect) {
                ArtState.heightNM = Math.max(1, Math.min(100, Math.round(ArtState.sizeNM * (ArtState.aspectRatio || 1.0) * 10) / 10));
                applyTransformations();
            } else {
                if (ArtState.sizeNM > 0) {
                    ArtState.aspectRatio = ArtState.heightNM / ArtState.sizeNM;
                }
            }
            syncDimensionInputs();
        });

        // Rotation slider
        const rotSlider = document.getElementById('rotSlider');
        const rotBadge = document.getElementById('rotBadge');
        if (rotSlider) {
            rotSlider.addEventListener('mousedown', () => HistoryManager.pushState());
            rotSlider.addEventListener('touchstart', () => HistoryManager.pushState(), { passive: true });
            rotSlider.addEventListener('input', () => {
                ArtState.rotationDeg = parseInt(rotSlider.value) || 0;
                if (rotBadge) rotBadge.innerText = ArtState.rotationDeg + '°';
                applyTransformations();
            });
        }

        // Simplification / Smoothing slider
        const smoothSlider = document.getElementById('smoothSlider');
        if (smoothSlider) {
            smoothSlider.addEventListener('mousedown', () => HistoryManager.pushState());
            smoothSlider.addEventListener('touchstart', () => HistoryManager.pushState(), { passive: true });
            smoothSlider.addEventListener('input', () => {
                ArtState.simplificationTolerance = parseFloat(smoothSlider.value) || 0.015;
                simplifyProjectedRoute();
            });
        }

        // Max Waypoints Limit Synchronization & Enforcer
        function setMaxWaypoints(val, enforce) {
            const numVal = parseInt(val, 10);
            if (enforce !== undefined) {
                ArtState.enforceMaxWaypoints = !!enforce;
            }
            if (!isNaN(numVal)) {
                ArtState.maxWaypoints = numVal;
            }

            const importInput = document.getElementById('importMaxWaypointsInput');
            const importPreset = document.getElementById('importMaxWaypointsPreset');
            const spatialInput = document.getElementById('maxWaypointsInput');
            const spatialPreset = document.getElementById('maxWaypointsPresetSelect');
            const enforceCheck = document.getElementById('enforceMaxWaypointsCheck');

            if (importInput && parseInt(importInput.value, 10) !== ArtState.maxWaypoints) {
                importInput.value = ArtState.maxWaypoints;
            }
            if (spatialInput && parseInt(spatialInput.value, 10) !== ArtState.maxWaypoints) {
                spatialInput.value = ArtState.maxWaypoints;
            }

            const presetStr = String(ArtState.maxWaypoints);
            const validPresets = ['50', '75', '99', '150', '200', '0'];
            if (importPreset) {
                importPreset.value = validPresets.includes(presetStr) ? presetStr : '';
            }
            if (spatialPreset) {
                spatialPreset.value = validPresets.includes(presetStr) ? presetStr : '';
            }
            if (enforceCheck) {
                enforceCheck.checked = !!ArtState.enforceMaxWaypoints;
            }

            if (ArtState.lastDecodedImage) {
                traceRasterImage(ArtState.lastDecodedImage, false);
            } else {
                simplifyProjectedRoute();
            }
        }

        document.getElementById('importMaxWaypointsInput')?.addEventListener('change', (e) => {
            setMaxWaypoints(e.target.value);
        });
        document.getElementById('importMaxWaypointsPreset')?.addEventListener('change', (e) => {
            const val = parseInt(e.target.value, 10);
            if (val === 0) {
                setMaxWaypoints(0, false);
            } else {
                setMaxWaypoints(val, true);
            }
        });
        document.getElementById('maxWaypointsInput')?.addEventListener('change', (e) => {
            setMaxWaypoints(e.target.value);
        });
        document.getElementById('maxWaypointsPresetSelect')?.addEventListener('change', (e) => {
            const val = parseInt(e.target.value, 10);
            if (val === 0) {
                setMaxWaypoints(0, false);
            } else {
                setMaxWaypoints(val, true);
            }
        });
        document.getElementById('enforceMaxWaypointsCheck')?.addEventListener('change', (e) => {
            ArtState.enforceMaxWaypoints = !!e.target.checked;
            const spatialInput = document.getElementById('maxWaypointsInput');
            const val = spatialInput ? parseInt(spatialInput.value, 10) : ArtState.maxWaypoints;
            setMaxWaypoints(val, ArtState.enforceMaxWaypoints);
        });

        // Flip buttons
        document.getElementById('flipHBtn')?.addEventListener('click', () => {
            HistoryManager.pushState();
            ArtState.flipH = !ArtState.flipH;
            applyTransformations();
        });
        document.getElementById('flipVBtn')?.addEventListener('click', () => {
            HistoryManager.pushState();
            ArtState.flipV = !ArtState.flipV;
            applyTransformations();
        });

        // Center Coordinate Inputs
        const centerLatInput = document.getElementById('centerLatInput');
        const centerLonInput = document.getElementById('centerLonInput');
        function onCenterChanged() {
            const lat = parseFloat(centerLatInput?.value);
            const lon = parseFloat(centerLonInput?.value);
            if (!isNaN(lat) && !isNaN(lon)) {
                ArtState.center.lat = lat;
                ArtState.center.lon = lon;
                if (ArtState.centerMarker) ArtState.centerMarker.setLatLng([lat, lon]);
                applyTransformations();
            }
        }
        centerLatInput?.addEventListener('change', onCenterChanged);
        centerLonInput?.addEventListener('change', onCenterChanged);

        // Center to Map button
        document.getElementById('centerToMapBtn')?.addEventListener('click', () => {
            const center = ArtState.map.getCenter();
            ArtState.center.lat = center.lat;
            ArtState.center.lon = center.lng;
            updateCenterInputs();
            if (ArtState.centerMarker) ArtState.centerMarker.setLatLng(center);
            applyTransformations();
        });

        // Speed & Fuel inputs
        const speedInput = document.getElementById('cruiseSpeedInput');
        const fuelInput = document.getElementById('fuelFlowInput');
        speedInput?.addEventListener('change', () => {
            ArtState.cruiseSpeedKts = parseFloat(speedInput.value) || 150;
            updateStatsHUD();
        });
        fuelInput?.addEventListener('change', () => {
            ArtState.fuelFlowGPH = parseFloat(fuelInput.value) || 8.5;
            updateStatsHUD();
        });

        // Include Airport toggle
        const airportToggle = document.getElementById('includeAirportCheck');
        airportToggle?.addEventListener('change', () => {
            ArtState.includeAirport = !!airportToggle.checked;
            simplifyProjectedRoute();
        });

        // Optimize Start/End Waypoint toggle
        const optToggle = document.getElementById('optimizeEntryExitCheck');
        optToggle?.addEventListener('change', () => {
            HistoryManager.pushState();
            ArtState.optimizeEntryExit = !!optToggle.checked;
            simplifyProjectedRoute();
        });

        // Reverse Route Direction Buttons
        function handleReverseRoute() {
            HistoryManager.pushState();
            ArtState.routeReversed = !ArtState.routeReversed;
            updateReverseButtons();
            simplifyProjectedRoute();
        }
        document.getElementById('reverseRouteBtn')?.addEventListener('click', handleReverseRoute);
        document.getElementById('mapReverseBtn')?.addEventListener('click', handleReverseRoute);

        // Autopilot Lead Turn Preview (Ghost Path) Toggles
        function handleToggleAutopilotGhost(enabled) {
            ArtState.showAutopilotGhost = enabled;
            const check = document.getElementById('showAutopilotGhostCheck');
            if (check) check.checked = ArtState.showAutopilotGhost;
            const btn = document.getElementById('mapAutopilotGhostBtn');
            if (btn) {
                btn.classList.toggle('active', ArtState.showAutopilotGhost);
                btn.classList.toggle('btn-warning', ArtState.showAutopilotGhost);
                btn.classList.toggle('text-dark', ArtState.showAutopilotGhost);
                btn.classList.toggle('btn-light', !ArtState.showAutopilotGhost);
            }
            renderAutopilotGhost();
        }

        document.getElementById('showAutopilotGhostCheck')?.addEventListener('change', (e) => {
            handleToggleAutopilotGhost(!!e.target.checked);
        });

        document.getElementById('mapAutopilotGhostBtn')?.addEventListener('click', () => {
            handleToggleAutopilotGhost(!ArtState.showAutopilotGhost);
        });

        // Sharp Corner Loop-Back Toggles
        function handleToggleLoopBacks(enabled) {
            HistoryManager.pushState();
            ArtState.enableCornerLoopBacks = enabled;
            const check = document.getElementById('enableCornerLoopBacksCheck');
            if (check) check.checked = ArtState.enableCornerLoopBacks;
            const btn = document.getElementById('mapLoopBackBtn');
            if (btn) {
                btn.classList.toggle('active', ArtState.enableCornerLoopBacks);
                btn.classList.toggle('btn-primary', ArtState.enableCornerLoopBacks);
                btn.classList.toggle('text-white', ArtState.enableCornerLoopBacks);
                btn.classList.toggle('btn-light', !ArtState.enableCornerLoopBacks);
            }
            buildFullFlightPlan();
            renderRouteOnMap();
            updateStatsHUD();
            renderWaypointTable();
        }

        document.getElementById('enableCornerLoopBacksCheck')?.addEventListener('change', (e) => {
            handleToggleLoopBacks(!!e.target.checked);
        });

        document.getElementById('mapLoopBackBtn')?.addEventListener('click', () => {
            handleToggleLoopBacks(!ArtState.enableCornerLoopBacks);
        });

        // Toggle Waypoint Indicators Button (Show/Hide numbered circles & loop markers to view art cleanly)
        document.getElementById('mapToggleWaypointsBtn')?.addEventListener('click', () => {
            ArtState.showWaypointIndicators = !ArtState.showWaypointIndicators;
            syncWaypointVisibility();
        });

        // Autopilot Turn Radius Slider & Input
        const apRadiusSlider = document.getElementById('autopilotRadiusSlider');
        const apRadiusInput = document.getElementById('autopilotRadiusInput');
        if (apRadiusSlider && apRadiusInput) {
            apRadiusSlider.addEventListener('mousedown', () => HistoryManager.pushState());
            apRadiusSlider.addEventListener('touchstart', () => HistoryManager.pushState(), { passive: true });
            apRadiusInput.addEventListener('focus', () => HistoryManager.pushState());

            apRadiusSlider.addEventListener('input', () => {
                const val = parseFloat(apRadiusSlider.value) || 1.0;
                ArtState.autopilotTurnRadiusNM = Math.max(0.3, Math.min(3.0, Math.round(val * 10) / 10));
                apRadiusInput.value = ArtState.autopilotTurnRadiusNM.toFixed(1);
                buildFullFlightPlan();
                renderRouteOnMap();
                updateStatsHUD();
                renderWaypointTable();
            });

            apRadiusInput.addEventListener('change', () => {
                const val = parseFloat(apRadiusInput.value) || 1.0;
                ArtState.autopilotTurnRadiusNM = Math.max(0.3, Math.min(3.0, Math.round(val * 10) / 10));
                apRadiusSlider.value = ArtState.autopilotTurnRadiusNM;
                apRadiusInput.value = ArtState.autopilotTurnRadiusNM.toFixed(1);
                buildFullFlightPlan();
                renderRouteOnMap();
                updateStatsHUD();
                renderWaypointTable();
            });
        }

        // Autopilot Sharp Corner Threshold Select
        document.getElementById('autopilotMinAngleSelect')?.addEventListener('change', (e) => {
            HistoryManager.pushState();
            ArtState.autopilotMinAngleDeg = parseInt(e.target.value, 10) || 60;
            buildFullFlightPlan();
            renderRouteOnMap();
            updateStatsHUD();
            renderWaypointTable();
        });


        // Drawing Mode Buttons
        document.getElementById('drawModeBtn')?.addEventListener('click', () => {
            toggleDrawMode(!ArtState.drawMode);
        });
        document.getElementById('clickModeBtn')?.addEventListener('click', () => {
            toggleClickMode(!ArtState.clickMode);
        });
        document.getElementById('clearDrawingBtn')?.addEventListener('click', () => {
            HistoryManager.pushState();
            ArtState.basePoints = [];
            ArtState.projectedPoints = [];
            ArtState.rawProjectedPoints = [];
            ArtState.sourceType = 'freehand';
            ArtState.strokeCount = 0;
            updateStrokeCountBadge();
            buildFullFlightPlan();
            renderRouteOnMap();
            updateStatsHUD();
            renderWaypointTable();
        });

        // Smart Connect Multi-Strokes Toggle Switch
        const smartConnectCheck = document.getElementById('smartConnectStrokesCheck');
        if (smartConnectCheck) {
            smartConnectCheck.checked = (ArtState.smartConnect !== false);
            smartConnectCheck.addEventListener('change', () => {
                ArtState.smartConnect = !!smartConnectCheck.checked;
            });
        }

        // Tab Switching: turn off drawing/clicking modes when navigating away from Draw tab
        document.querySelectorAll('#artModeTabs button[data-bs-toggle="pill"]').forEach(tabBtn => {
            tabBtn.addEventListener('shown.bs.tab', (e) => {
                if (e.target && e.target.id !== 'draw-tab') {
                    toggleDrawMode(false);
                    toggleClickMode(false);
                }
            });
        });

        // Preset buttons
        document.querySelectorAll('.shape-preset-btn').forEach(btn => {
            btn.addEventListener('click', function () {
                const shape = this.getAttribute('data-shape');
                loadPreset(shape);
            });
        });

        // Text Art Form
        const textBtn = document.getElementById('textArtBtn');
        const textInput = document.getElementById('textArtInput');
        if (textBtn && textInput) {
            textBtn.addEventListener('click', () => {
                generateTextArt(textInput.value);
            });
            textInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    generateTextArt(textInput.value);
                }
            });
        }
        document.querySelectorAll('input[name="textStyleRadio"]').forEach(radio => {
            radio.addEventListener('change', () => {
                const text = textInput?.value;
                if (text && text.trim().length > 0) {
                    generateTextArt(text);
                }
            });
        });

        // Save Drawing triggers & Modal
        document.getElementById('headerSaveDrawingBtn')?.addEventListener('click', openSaveDrawingModal);
        document.getElementById('dropdownSaveDrawingAction')?.addEventListener('click', (e) => {
            e.preventDefault();
            openSaveDrawingModal();
        });
        document.getElementById('saveDrawingFromDrawTabBtn')?.addEventListener('click', openSaveDrawingModal);

        document.getElementById('confirmSaveDrawingBtn')?.addEventListener('click', () => {
            const input = document.getElementById('saveDrawingNameInput');
            const name = input?.value || '';
            const success = saveDrawingToStorage(name);
            if (success) {
                const modalEl = document.getElementById('saveDrawingModal');
                if (modalEl && typeof bootstrap !== 'undefined') {
                    const modal = bootstrap.Modal.getInstance(modalEl);
                    if (modal) modal.hide();
                }
            }
        });

        document.getElementById('saveDrawingNameInput')?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                document.getElementById('confirmSaveDrawingBtn')?.click();
            }
        });

        // File Dropzone & Input
        const dropzone = document.getElementById('artDropzone');
        const fileInput = document.getElementById('artFileInput');

        if (dropzone && fileInput) {
            dropzone.addEventListener('click', () => fileInput.click());
            dropzone.addEventListener('dragover', (e) => {
                e.preventDefault();
                dropzone.classList.add('dragover');
            });
            dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
            dropzone.addEventListener('drop', (e) => {
                e.preventDefault();
                dropzone.classList.remove('dragover');
                if (e.dataTransfer.files && e.dataTransfer.files[0]) {
                    handleUploadedFile(e.dataTransfer.files[0]);
                }
            });

            fileInput.addEventListener('change', () => {
                if (fileInput.files && fileInput.files[0]) {
                    handleUploadedFile(fileInput.files[0]);
                }
            });
        }

        // Import Mode Radio change listener (instantly reprocesses current uploaded file)
        document.querySelectorAll('input[name="importModeRadio"]').forEach(radio => {
            radio.addEventListener('change', () => {
                const modeDesc = document.getElementById('importModeDescription');
                const sliderTitle = document.getElementById('importSliderTitle');
                const mode = radio.value;

                if (modeDesc) {
                    if (mode === 'singlestroke') {
                        modeDesc.innerHTML = `<i class="bi bi-bezier2 text-primary me-1"></i><strong>Single Stroke Path:</strong> Extracts the 1px centerline skeleton of any line drawing regardless of line thickness and turns it into one continuous flight path.`;
                        if (sliderTitle) sliderTitle.innerText = "Line Sensitivity:";
                    } else if (mode === 'lineart') {
                        modeDesc.innerHTML = `<i class="bi bi-magic text-primary me-1"></i><strong>Line Art:</strong> Traces essential drawing lines &amp; facial features. Adjust detail slider below to add/remove lines.`;
                        if (sliderTitle) sliderTitle.innerText = "Line Detail:";
                    } else if (mode === 'outline') {
                        modeDesc.innerHTML = `<i class="bi bi-bounding-box text-primary me-1"></i><strong>Outline Only:</strong> Outer boundary silhouette only (ideal for solid logos & aircraft).`;
                        if (sliderTitle) sliderTitle.innerText = "Edge Threshold:";
                    } else {
                        modeDesc.innerHTML = `<i class="bi bi-bezier2 text-primary me-1"></i><strong>All Strokes:</strong> Traces every detected line, texture, and stroke in the image.`;
                        if (sliderTitle) sliderTitle.innerText = "Stroke Detail:";
                    }
                }

                if (ArtState.lastDecodedImage) {
                    traceRasterImage(ArtState.lastDecodedImage, false);
                } else if (ArtState.lastUploadedFile) {
                    handleUploadedFile(ArtState.lastUploadedFile, false);
                }
            });
        });

        // Import Threshold Slider listener (live detail tuning for photos, sketches & line art)
        const thresholdSlider = document.getElementById('importThresholdSlider');
        if (thresholdSlider) {
            const updateThreshold = () => {
                if (ArtState.lastDecodedImage) {
                    traceRasterImage(ArtState.lastDecodedImage, false);
                } else if (ArtState.lastUploadedFile) {
                    handleUploadedFile(ArtState.lastUploadedFile, false);
                }
            };
            thresholdSlider.addEventListener('input', updateThreshold);
        }

        // Export Buttons
        document.getElementById('downloadFplBtn')?.addEventListener('click', () => {
            const xml = generateGarminFplXml();
            triggerFileDownload(xml, 'SkyArt.fpl', 'application/xml');
        });

        document.getElementById('openForeflightBtn')?.addEventListener('click', () => {
            const url = generateForeFlightMobileUrl();
            if (!url) {
                alert("No route waypoints generated yet.");
                return;
            }
            window.location.href = url;
        });

        document.getElementById('showQrBtn')?.addEventListener('click', showQrCodeModal);

        document.getElementById('copyRouteBtn')?.addEventListener('click', () => {
            const routeStr = generateForeFlightRouteString();
            if (!routeStr) {
                alert("No route waypoints generated yet.");
                return;
            }
            navigator.clipboard.writeText(routeStr).then(() => {
                const btn = document.getElementById('copyRouteBtn');
                const orig = btn.innerHTML;
                btn.innerHTML = '<i class="bi bi-check-lg text-success"></i> Copied!';
                setTimeout(() => { btn.innerHTML = orig; }, 2000);
            });
        });

        document.getElementById('downloadGpxBtn')?.addEventListener('click', () => {
            const xml = generateGpxXml();
            triggerFileDownload(xml, 'SkyArt.gpx', 'application/gpx+xml');
        });

        document.getElementById('downloadKmlBtn')?.addEventListener('click', () => {
            const xml = generateKmlXml();
            triggerFileDownload(xml, 'SkyArt.kml', 'application/vnd.google-earth.kml+xml');
        });
    }

    async function loadHeic2AnyLibrary() {
        if (typeof heic2any !== 'undefined') return;
        return new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = 'https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js';
            script.onload = () => resolve();
            script.onerror = () => reject(new Error("Failed to load HEIF decoder library (heic2any)."));
            document.head.appendChild(script);
        });
    }

    async function processHeicFile(file, shouldFitBounds = true) {
        const titleEl = document.getElementById('artDropzoneTitle');
        const origTitle = titleEl ? titleEl.innerText : '';
        if (titleEl) titleEl.innerHTML = '<span class="spinner-border spinner-border-sm me-2 text-primary" role="status"></span>Decoding HEIF/HEIC image...';

        // Photos default to All Vector Strokes so subject facial/linework features are rendered
        const strokesRadio = document.getElementById('importModeAllStrokes');
        if (strokesRadio) strokesRadio.checked = true;

        try {
            await loadHeic2AnyLibrary();
            const conversion = await heic2any({
                blob: file,
                toType: 'image/jpeg',
                quality: 0.92
            });

            const blob = Array.isArray(conversion) ? conversion[0] : conversion;
            const reader = new FileReader();
            reader.onload = (e) => {
                const img = new Image();
                img.onload = () => {
                    ArtState.lastDecodedImage = img;
                    traceRasterImage(img, shouldFitBounds);
                };
                img.onerror = () => alert("Could not decode converted HEIF image.");
                img.src = e.target.result;
            };
            reader.readAsDataURL(blob);
        } catch (err) {
            console.warn("heic2any decoding failed, attempting native browser decode:", err);
            // Native fallback (e.g. Safari on macOS/iOS directly decodes HEIC in Image)
            const reader = new FileReader();
            reader.onload = (e) => {
                const img = new Image();
                img.onload = () => {
                    ArtState.lastDecodedImage = img;
                    traceRasterImage(img, shouldFitBounds);
                };
                img.onerror = () => {
                    alert("Could not decode HEIF/HEIC image: " + (err.message || "Unsupported format."));
                };
                img.src = e.target.result;
            };
            reader.readAsDataURL(file);
        } finally {
            if (titleEl) titleEl.innerText = origTitle;
        }
    }

    function handleUploadedFile(file, shouldFitBounds = true) {
        if (!file) return;
        ArtState.lastUploadedFile = file;
        const name = (file.name || '').toLowerCase();

        // 1. Vector SVG
        if (name.endsWith('.svg') || file.type === 'image/svg+xml') {
            ArtState.lastDecodedImage = null;
            const reader = new FileReader();
            reader.onload = (e) => parseSvg(e.target.result, shouldFitBounds);
            reader.readAsText(file);
            return;
        }

        // 2. HEIF / HEIC photo
        const isHeif = name.endsWith('.heic') || name.endsWith('.heif') || name.endsWith('.hif') ||
                       (file.type && (file.type.includes('heic') || file.type.includes('heif')));

        if (isHeif) {
            processHeicFile(file, shouldFitBounds);
            return;
        }

        // 3. Raster image (PNG, JPEG, etc.)
        const isRaster = name.endsWith('.png') || name.endsWith('.jpg') || name.endsWith('.jpeg') ||
                         name.endsWith('.jpe') || name.endsWith('.jfif') ||
                         (file.type && file.type.startsWith('image/'));

        if (isRaster) {
            const isOpaquePhoto = !name.endsWith('.png') && file.type !== 'image/png';
            if (isOpaquePhoto) {
                const currentMode = document.querySelector('input[name="importModeRadio"]:checked')?.value;
                if (!currentMode) {
                    const singleStrokeRadio = document.getElementById('importModeSingleStroke');
                    if (singleStrokeRadio) singleStrokeRadio.checked = true;
                }
            }

            const reader = new FileReader();
            reader.onload = (e) => {
                const img = new Image();
                img.onload = () => {
                    ArtState.lastDecodedImage = img;
                    traceRasterImage(img, shouldFitBounds);
                };
                img.onerror = () => {
                    alert("Failed to load image file. Please try another image.");
                };
                img.src = e.target.result;
            };
            reader.readAsDataURL(file);
            return;
        }

        alert("Please upload an SVG vector file (.svg), PNG (.png), JPEG (.jpg, .jpeg), or HEIF/HEIC (.heic, .heif).");
    }

    // --- DOM Ready ---
    document.addEventListener('DOMContentLoaded', function () {
        initMap();
        setupAirportControls();
        bindUiControls();
        updateCenterInputs();
        updateHomeAirportUI();
        syncDimensionInputs();
        renderSavedDrawingsDropdown();
        syncSavedDrawingsWithServer();
        syncHomeAirportWithServer();
        HistoryManager.updateButtons();
    });

    // Expose for testing & global inspection
    window.ArtState = ArtState;
    window.SkyState = ArtState;
    window.DEFAULT_HOME_AIRPORT = DEFAULT_HOME_AIRPORT;
    window.loadConfiguredHomeAirport = loadConfiguredHomeAirport;
    window.saveConfiguredHomeAirport = saveConfiguredHomeAirport;
    window.syncHomeAirportWithServer = syncHomeAirportWithServer;
    window.generateForeFlightRouteString = generateForeFlightRouteString;
    window.generateGarminFplXml = generateGarminFplXml;
    window.generateForeFlightMobileUrl = generateForeFlightMobileUrl;
    window.getSavedDrawings = getSavedDrawings;
    window.saveDrawingToStorage = saveDrawingToStorage;
    window.loadSavedDrawing = loadSavedDrawing;
    window.deleteSavedDrawing = deleteSavedDrawing;
    window.HistoryManager = HistoryManager;
    window.syncDimensionInputs = syncDimensionInputs;
    window.traceRasterImage = traceRasterImage;
    window.loadPreset = loadPreset;
    window.deleteWaypoint = deleteWaypoint;
    window.insertWaypoint = insertWaypoint;
    window.applyTransformations = applyTransformations;
    window.handleUploadedFile = handleUploadedFile;
    window.setMapBaseLayerForTheme = setMapBaseLayerForTheme;

})();
