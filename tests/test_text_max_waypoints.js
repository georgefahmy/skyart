const assert = require('assert');
const fs = require('fs');
const path = require('path');

const skyArtJsPath = path.join(__dirname, '..', 'static', 'js', 'sky_art.js');
const skyArtJsCode = fs.readFileSync(skyArtJsPath, 'utf8');

const eventListeners = {};
const domElements = {};
function getOrCreateElement(id) {
    if (!domElements[id]) {
        domElements[id] = {
            id,
            value: '',
            innerText: '',
            innerHTML: '',
            checked: false,
            classList: { add(){}, remove(){}, toggle(){}, contains(){ return false; } },
            addEventListener(ev, fn){
                if (!eventListeners[id]) eventListeners[id] = {};
                eventListeners[id][ev] = fn;
            },
            querySelectorAll(){ return []; },
            closest(){ return null; }
        };
    }
    return domElements[id];
}

let domLoadedCallback = null;
const mockDocument = {
    getElementById(id) { return getOrCreateElement(id); },
    querySelectorAll() { return []; },
    querySelector(sel) { 
        if (sel === 'input[name="importModeRadio"]:checked') return { value: 'outline' };
        if (sel === 'input[name="textStyleRadio"]:checked') return { value: 'stick' };
        return null;
    },
    addEventListener(ev, fn) {
        if (ev === 'DOMContentLoaded') domLoadedCallback = fn;
    },
    cookie: ''
};

const mockL = {
    polyline: () => ({ addTo(){ return this; }, setLatLngs(){}, bindTooltip(){ return this; }, on(){ return this; } }),
    marker: (ll, opts) => ({ latlng: ll, opts, addTo(){ return this; }, on(){ return this; }, bindTooltip(){ return this; }, setTooltipContent(){ return this; }, closeTooltip(){ return this; } }),
    divIcon: (opts) => opts,
    latLngBounds: () => ({ isValid: () => true, pad: () => ({}) }),
    imageOverlay: () => ({ addTo(){ return this; } }),
    map: () => ({
        setView(){ return this; }, fitBounds(){}, removeLayer(){}, hasLayer(){ return false; }, on(){ return this; },
        getCenter(){ return { lat: 37.0816, lng: -121.5970 }; },
        latLngToLayerPoint(ll) { return { x: (ll.lng || ll.lon) * 100, y: (ll.lat) * 100 }; },
        layerPointToLatLng(p) { return { lat: p.y / 100, lon: p.x / 100 }; }
    }),
    Map: { addInitHook(){} },
    tileLayer: () => ({ addTo(){ return this; } }),
    control: { layers: () => ({ addTo(){ return this; } }), scale: () => ({ addTo(){ return this; } }) }
};

const mockWindow = {
    document: mockDocument,
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    L: mockL,
    DEFAULT_HOME_AIRPORT: null,
    ArtState: null,
    addEventListener(){}
};

const vm = require('vm');
const context = vm.createContext({
    window: mockWindow,
    document: mockDocument,
    localStorage: mockWindow.localStorage,
    L: mockL,
    console, Math, Date, parseInt, parseFloat, isNaN, Array, Object, Set, String, setTimeout, clearTimeout,
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
});

vm.runInContext(skyArtJsCode, context);
const ArtState = context.window.ArtState;
if (domLoadedCallback) domLoadedCallback();

console.log("🧪 Testing Text Art Stability with Max Waypoints adjustments...\n");

// --- Test 1: Generate Text Art Sets sourceType='text' and Clears lastDecodedImage ---
console.log("👉 Test 1: Generate Text Art with Aviation Script...");
// Pre-populate lastDecodedImage as if user had an image loaded earlier
ArtState.lastDecodedImage = { width: 400, height: 400 };

mockDocument.getElementById('textFontSelect').value = 'script';
mockDocument.getElementById('textStyleStick').checked = true;

context.window.generateTextArt('RV7');

assert.strictEqual(ArtState.sourceType, 'text', "ArtState.sourceType must be 'text'");
assert.strictEqual(ArtState.lastDecodedImage, null, "ArtState.lastDecodedImage must be null so old raster is not re-traced");
assert.strictEqual(ArtState.baseContours.length, 1, "ArtState.baseContours must be a single continuous stroke with baseline connectors");
const initialCount = ArtState.projectedPoints.length;
console.log(`✅ Test 1 Passed: Generated text art with ${initialCount} waypoints as a single continuous flight path.`);

// --- Test 2: Adjusting Max Waypoints Preset preserves text and does not re-trace old image ---
console.log("\n👉 Test 2: Adjusting Max Waypoints across presets (50, 75, 99, 0/Off)...");
const presets = ['50', '75', '99', '0'];
for (const pr of presets) {
    eventListeners['maxWaypointsPresetSelect']['change']({ target: { value: pr } });
    assert.strictEqual(ArtState.sourceType, 'text', `sourceType must remain 'text' after selecting preset ${pr}`);
    assert.strictEqual(ArtState.projectedPoints.length, initialCount, `projectedPoints count must remain ${initialCount} after preset ${pr}`);
}
console.log("✅ Test 2 Passed: Text art geometry remains 100% stable across all Max Waypoint presets.");

// --- Test 3: Toggling enforceMaxWaypoints checkbox does not distort text ---
console.log("\n👉 Test 3: Toggling enforceMaxWaypoints switch...");
eventListeners['enforceMaxWaypointsCheck']['change']({ target: { checked: false } });
assert.strictEqual(ArtState.enforceMaxWaypoints, false);
assert.strictEqual(ArtState.projectedPoints.length, initialCount);

eventListeners['enforceMaxWaypointsCheck']['change']({ target: { checked: true } });
assert.strictEqual(ArtState.enforceMaxWaypoints, true);
assert.strictEqual(ArtState.projectedPoints.length, initialCount);
console.log("✅ Test 3 Passed: Toggling enforceMaxWaypoints preserves text structure without corruption.");

// --- Test 4: Testing Aviation Stick Font ---
console.log("\n👉 Test 4: Testing Aviation Stick text stability...");
mockDocument.getElementById('textFontSelect').value = 'stick';
context.window.generateTextArt('SKY');
const stickCount = ArtState.projectedPoints.length;
assert(stickCount >= 15, "Stick 'SKY' must have valid waypoints");

eventListeners['maxWaypointsPresetSelect']['change']({ target: { value: '0' } });
assert.strictEqual(ArtState.projectedPoints.length, stickCount, "Stick 'SKY' must retain all waypoints when limit is Off");

eventListeners['maxWaypointsPresetSelect']['change']({ target: { value: '99' } });
assert.strictEqual(ArtState.projectedPoints.length, stickCount, "Stick 'SKY' must retain all waypoints with 99 limit");
console.log("✅ Test 4 Passed: Aviation Stick font text remains 100% stable across waypoint limits.");

console.log("\n🎉 All Text Art Max Waypoint stability tests PASSED successfully!");
