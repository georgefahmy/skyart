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
        bindTooltip() { return this; },
        on(ev, fn) { this.events[ev] = fn; return this; },
        addTo() { return this; },
        setLatLng(newLL) { this.latlng = newLL; },
        getLatLng() { return this.latlng; }
    }),
    divIcon: (opts) => opts,
    latLngBounds: () => ({}),
    map: () => ({
        setView() {},
        fitBounds() {},
        removeLayer() {},
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

console.log("\n🎉 All Waypoint Manipulation & Closed-Loop tests PASSED successfully!\n");
