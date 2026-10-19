/**
 * Unit Test for Waypoint Manipulation & Closed-Loop Vertex Synchronization
 * 
 * Verifies that:
 * 1. Closed loop shapes render unique corner markers (no duplicate overlapping markers at start/end).
 * 2. Dragging the start/end corner (WP1) moves both start and closing legs together without detaching.
 * 3. Deleting a waypoint updates baseContours so translating the shape via center anchor never revives deleted edges.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

// Read sky_art.js source code
const skyArtJsPath = path.join(__dirname, '..', 'static', 'js', 'sky_art.js');
const skyArtJsCode = fs.readFileSync(skyArtJsPath, 'utf8');

// Mock browser environment
const domElements = {};
function getOrCreateElement(id) {
    if (!domElements[id]) {
        domElements[id] = {
            id,
            value: '',
            innerText: '',
            innerHTML: '',
            classList: {
                classes: new Set(),
                add(c) { this.classes.add(c); },
                remove(c) { this.classes.delete(c); },
                contains(c) { return this.classes.has(c); },
                toggle(c, force) {
                    if (force === undefined) {
                        if (this.classes.has(c)) { this.classes.delete(c); return false; }
                        else { this.classes.add(c); return true; }
                    } else if (force) {
                        this.classes.add(c); return true;
                    } else {
                        this.classes.delete(c); return false;
                    }
                }
            },
            addEventListener(ev, fn) {},
            querySelectorAll() { return []; },
            closest() { return null; }
        };
    }
    return domElements[id];
}

const mockDocument = {
    getElementById(id) { return getOrCreateElement(id); },
    querySelectorAll() { return []; },
    addEventListener(ev, fn) {},
    cookie: ''
};

const mockLocalStorage = {
    store: {},
    getItem(k) { return this.store[k] || null; },
    setItem(k, v) { this.store[k] = String(v); },
    removeItem(k) { delete this.store[k]; }
};

const mockL = {
    polyline: (latlngs, opts) => ({
        latlngs,
        opts,
        bindTooltip() { return this; },
        on() { return this; },
        addTo() { return this; },
        setLatLngs(newPts) { this.latlngs = newPts; }
    }),
    marker: (latlng, opts) => ({
        latlng,
        opts,
        events: {},
        tooltipContent: null,
        bindTooltip(content) { this.tooltipContent = content; return this; },
        setTooltipContent(content) { this.tooltipContent = content; return this; },
        closeTooltip() { return this; },
        on(ev, fn) { this.events[ev] = fn; return this; },
        addTo() { return this; },
        setLatLng(newLL) { this.latlng = newLL; },
        getLatLng() { return this.latlng; }
    }),
    divIcon: (opts) => opts,
    latLngBounds: (sw, ne) => ({
        sw, ne,
        isValid() { return true; }
    }),
    imageOverlay: (url, bounds, opts) => {
        const mockEl = {
            style: {
                transform: '',
                transformOrigin: '',
                pointerEvents: '',
                display: '',
                opacity: '',
                filter: ''
            }
        };
        return {
            url,
            bounds,
            opts,
            opacity: opts?.opacity !== undefined ? opts.opacity : 1.0,
            setOpacity(v) { this.opacity = v; mockEl.style.opacity = v; },
            setBounds(b) { this.bounds = b; },
            getElement() { return mockEl; },
            addTo(map) { this._map = map; return this; },
            on(ev, fn) {}
        };
    },
    map: () => ({
        setView() {},
        fitBounds() {},
        removeLayer(l) { l._removed = true; },
        hasLayer() { return false; },
        on() {},
        getCenter() { return { lat: 37.0816, lng: -121.5970 }; },
        latLngToLayerPoint(ll) { return { x: (ll.lng || ll.lon) * 100, y: (ll.lat) * 100 }; },
        layerPointToLatLng(p) { return { lat: p.y / 100, lon: p.x / 100 }; }
    }),
    Map: { addInitHook() {} },
    DomEvent: { stopPropagation() {}, preventDefault() {} },
    tileLayer: () => ({ addTo() {} }),
    control: { layers: () => ({ addTo() {} }), scale: () => ({ addTo() {} }) }
};

// Execute sky_art.js inside simulated window
const mockWindow = {
    document: mockDocument,
    localStorage: mockLocalStorage,
    L: mockL,
    DEFAULT_HOME_AIRPORT: null,
    ArtState: null,
    addEventListener(ev, fn) {}
};

const vm = require('vm');
const context = vm.createContext({
    window: mockWindow,
    document: mockDocument,
    localStorage: mockLocalStorage,
    L: mockL,
    console: console,
    Math: Math,
    Date: Date,
    parseInt: parseInt,
    parseFloat: parseFloat,
    isNaN: isNaN,
    Array: Array,
    Object: Object,
    Set: Set,
    String: String,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
});

vm.runInContext(skyArtJsCode, context);

const ArtState = context.window.ArtState;
assert(ArtState, "ArtState must be exported onto window");
ArtState.map = mockL.map();

console.log("🧪 Running Waypoint Manipulation & Closed-Loop Synchronization Tests...\n");

// --- Test 1: Preset Diamond Loading & Unique Marker Count ---
console.log("👉 Test 1: Preset 'diamond' loads with exactly 4 unique corner markers...");
// Trigger loading diamond
mockWindow.loadPreset('diamond');

assert.strictEqual(ArtState.projectedPoints.length, 5, "Diamond path must have 5 points (West, South, East, North, West closing)");
// Map markers should have exactly 4 corner markers (omitting redundant duplicate closing point)
const wpMarkers = ArtState.mapMarkers.filter(m => m.opts && m.opts.draggable);
assert.strictEqual(wpMarkers.length, 4, `Expected 4 corner markers on the map, got ${wpMarkers.length}`);
console.log("✅ Test 1 Passed: Diamond renders exactly 4 unique corner markers without duplicate overlapping closing marker.");

// --- Test 2: Dragging Corner 1 Keeps Start & Closing Vertex in Sync ---
console.log("\n👉 Test 2: Dragging Corner 1 updates both start and closing leg synchronously...");
const marker1 = wpMarkers[0];
assert(marker1 && marker1.events && marker1.events.drag, "Marker 1 must have drag handler");

// Simulate dragging marker 1 to new position
const dragPos = { lat: 37.1500, lng: -121.7500 };
marker1.events.drag({ target: { getLatLng: () => dragPos } });

// Verify that both projectedPoints[0] and projectedPoints[4] are updated to dragPos
assert.strictEqual(ArtState.projectedPoints[0].lat, dragPos.lat, "projectedPoints[0].lat must match drag pos");
assert.strictEqual(ArtState.projectedPoints[0].lon, dragPos.lng, "projectedPoints[0].lon must match drag pos");
assert.strictEqual(ArtState.projectedPoints[4].lat, dragPos.lat, "Closing point projectedPoints[4].lat must stay in sync with corner 1");
assert.strictEqual(ArtState.projectedPoints[4].lon, dragPos.lng, "Closing point projectedPoints[4].lon must stay in sync with corner 1");

// Simulate dragend
marker1.events.dragend({ target: { getLatLng: () => dragPos } });
assert(ArtState.baseContours && ArtState.baseContours.length > 0, "baseContours must be populated");
assert.strictEqual(ArtState.baseContours[0].length, 5, "baseContours must be synchronized with 5 points");
console.log("✅ Test 2 Passed: Dragging Corner 1 updates both start and end vertices with zero separation.");

// --- Test 3: Deleting Waypoint and Moving Anchor Does Not Revive Deleted Edge ---
console.log("\n👉 Test 3: Deleting a waypoint creates an open 3-edged line, and anchor movement retains the 3 edges...");
// Delete closing point (index 4)
mockWindow.deleteWaypoint(4);

assert.strictEqual(ArtState.projectedPoints.length, 4, "After deleting closing point, projectedPoints must have 4 points");
const wpMarkersAfterDelete = ArtState.mapMarkers.filter(m => m.opts && m.opts.draggable);
assert.strictEqual(wpMarkersAfterDelete.length, 4, "After opening loop, all 4 points have distinct markers");

// Check that baseContours has 4 points
assert.strictEqual(ArtState.baseContours[0].length, 4, "baseContours must now contain 4 points");

// Move center anchor to simulate user dragging anchor pin
ArtState.center.lat = 37.2000;
ArtState.center.lon = -121.6000;
mockWindow.applyTransformations();

// Verify that projectedPoints STILL has 4 points (3 edges), and has NOT revived the deleted 5th closing point
assert.strictEqual(ArtState.projectedPoints.length, 4, `Expected 4 points after anchor move, got ${ArtState.projectedPoints.length}`);
console.log("✅ Test 3 Passed: Anchor translation cleanly maintains user-edited 3-edged line without reverting deleted edges.");

// --- Test 4: Waypoint Marker Tooltip Contains In Leg and Out Leg Distances & Bearings ---
console.log("\n👉 Test 4: Waypoint marker tooltip contains In Leg and Out Leg distances & bearings...");
mockWindow.loadPreset('diamond');
const markersAfterLoad = ArtState.mapMarkers.filter(m => m.opts && m.opts.draggable);
assert(markersAfterLoad.length >= 4, "Must have at least 4 waypoint markers");

// Check WP2 (index 1) tooltip
const wp2Marker = markersAfterLoad[1];
assert(wp2Marker.tooltipContent, "WP2 marker must have tooltip content");
assert(wp2Marker.tooltipContent.includes('In Leg'), "WP2 tooltip must include incoming leg info");
assert(wp2Marker.tooltipContent.includes('Out Leg'), "WP2 tooltip must include outgoing leg info");
assert(wp2Marker.tooltipContent.includes('NM'), "WP2 tooltip must display distance in NM");
assert(wp2Marker.tooltipContent.includes('°'), "WP2 tooltip must display track bearing in degrees");
console.log("✅ Test 4 Passed: Waypoint tooltips display incoming/outgoing leg length in NM and track bearing.");

// --- Test 5: Inserting Waypoint Updates Tooltips and Shifts Loop Overrides ---
console.log("\n👉 Test 5: Inserting a waypoint updates tooltips and shifts corner loop overrides...");
ArtState.cornerLoopOverrides[2] = true; // Set override on WP3 (index 2)
assert.strictEqual(ArtState.cornerLoopOverrides[2], true, "Override initially on index 2");

// Insert waypoint between WP1 and WP2 (after index 0)
mockWindow.insertWaypoint(0);
assert.strictEqual(ArtState.projectedPoints.length, 6, "Inserting waypoint must increase projectedPoints count to 6");
assert.strictEqual(ArtState.cornerLoopOverrides[3], true, "Override on index 2 must shift to index 3 after insertion at index 1");
assert.strictEqual(ArtState.cornerLoopOverrides[2], undefined, "Old index 2 override must not linger");

// Verify that the new markers on map have updated tooltips
const markersAfterInsert = ArtState.mapMarkers.filter(m => m.opts && m.opts.draggable);
assert.strictEqual(markersAfterInsert.length, 5, "Expected 5 unique corner markers on closed loop of 6 points");
const wpNewMarker = markersAfterInsert[1];
assert(wpNewMarker.tooltipContent.includes('WP2'), "New marker must be titled WP2");
assert(wpNewMarker.tooltipContent.includes('In Leg (WP1)'), "New marker must have incoming leg from WP1");
console.log("✅ Test 5 Passed: Waypoint insertion updates all tooltips and properly shifts cornerLoopOverrides.");

// --- Test 6: Dragging a Waypoint Updates Tooltips on dragend ---
console.log("\n👉 Test 6: Dragging a waypoint recomputes turn metrics and updates tooltips on dragend...");
const targetMarker = markersAfterInsert[2]; // WP3
const newDragPos = { lat: 37.0000, lng: -121.5000 };
targetMarker.events.dragend({ target: { getLatLng: () => newDragPos } });

const refreshedMarkers = ArtState.mapMarkers.filter(m => m.opts && m.opts.draggable);
const refreshedWP3 = refreshedMarkers[2];
assert(refreshedWP3.tooltipContent.includes('37.0000°'), "WP3 tooltip coordinates must reflect dragged position");
assert(refreshedWP3.tooltipContent.includes('In Leg') && refreshedWP3.tooltipContent.includes('Out Leg'), "WP3 tooltip must have recomputed leg metrics");
console.log("✅ Test 6 Passed: dragend re-renders route and recalculates marker tooltips with fresh coordinates and leg lengths.");

// --- Test 7: Heart Preset Orientation (Lobes at Top / North, Tip at Bottom / South) ---
console.log("\n👉 Test 7: Preset 'heart' default orientation has lobes at top (North) and tip at bottom (South)...");
mockWindow.loadPreset('heart');
const heartPts = ArtState.projectedPoints;
assert(heartPts.length > 50, "Heart preset should have a dense set of points");
const heartLats = heartPts.map(p => p.lat);
const heartLons = heartPts.map(p => p.lon);
const minHeartLat = Math.min(...heartLats);
const maxHeartLat = Math.max(...heartLats);
const tipPoint = heartPts.find(p => p.lat === minHeartLat);

// The tip of the heart should be at minLat (lowest point / south) and centered around lon center
const centerHeartLon = (Math.min(...heartLons) + Math.max(...heartLons)) / 2;
assert(Math.abs(tipPoint.lon - centerHeartLon) < 0.05, "Heart tip should be centrally aligned at bottom");
assert(tipPoint.lat < centerHeartLon || tipPoint.lat === minHeartLat, "Heart bottom must be the minimum latitude");
// Verify lobes are near maxLat
const topPoints = heartPts.filter(p => p.lat > minHeartLat + 0.8 * (maxHeartLat - minHeartLat));
assert(topPoints.length >= 10, "Lobes must constitute the top region");
// --- Test 8: Tracing Lightbox Layer (Trace by Hand) ---
console.log("\n👉 Test 8: Tracing Lightbox Overlay (creation, opacity, bound sync, removal)...");
const sampleDataUrl = "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTAwIiBoZWlnaHQ9IjEwMCI+PC9zdmc+";
mockWindow.loadTracingOverlay(sampleDataUrl, 200, 100, false);

assert(ArtState.traceOverlay, "ArtState.traceOverlay must be defined after loadTracingOverlay");
assert(ArtState.traceOverlay.layer, "ArtState.traceOverlay.layer must be initialized");
assert.strictEqual(ArtState.traceOverlay.aspectRatio, 0.5, "Aspect ratio must be imgHeight / imgWidth = 100/200 = 0.5");
assert.strictEqual(ArtState.traceOverlay.opacity, 0.5, "Default overlay opacity must be 0.5 (50%)");
assert.strictEqual(ArtState.traceOverlay.visible, true, "Overlay must be visible by default");

// Test opacity change
mockWindow.setOverlayOpacity(0.8);
assert.strictEqual(ArtState.traceOverlay.opacity, 0.8, "setOverlayOpacity must update ArtState.traceOverlay.opacity to 0.8");
assert.strictEqual(ArtState.traceOverlay.layer.opacity, 0.8, "Layer opacity must update to 0.8");

// Test visibility toggle
mockWindow.setOverlayVisible(false);
assert.strictEqual(ArtState.traceOverlay.visible, false, "setOverlayVisible(false) must update visibility");
const overlayEl = ArtState.traceOverlay.layer.getElement();
assert.strictEqual(overlayEl.style.display, 'none', "Overlay element must be hidden when visible is false");
mockWindow.setOverlayVisible(true);
assert.strictEqual(overlayEl.style.display, '', "Overlay element display must be cleared when visible is true");

// Test bound sync when ArtState.sizeNM is modified via applyTransformations
const oldBounds = ArtState.traceOverlay.layer.bounds;
ArtState.sizeNM = 25;
mockWindow.applyTransformations();
const newBounds = ArtState.traceOverlay.layer.bounds;
assert(newBounds !== oldBounds, "applyTransformations must update overlay bounds when sizeNM changes");

// Test overlay removal
mockWindow.removeTraceOverlay();
assert.strictEqual(ArtState.traceOverlay, null, "removeTraceOverlay must nullify ArtState.traceOverlay");
console.log("✅ Test 8 Passed: Tracing Lightbox Layer initializes, adjusts opacity, toggles visibility, updates on transformations, and removes cleanly.");

console.log("\n🎉 All Waypoint Manipulation & Closed-Loop tests PASSED successfully!\n");

