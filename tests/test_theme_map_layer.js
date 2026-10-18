/**
 * Unit Test for Map Base Layer Switching on Theme (Light/Dark Mode) Toggle
 *
 * Verifies that:
 * 1. Dark mode initializes the map with Aero Midnight (Dark) (ArtState.layers.cartoDark).
 * 2. Light mode initializes the map with OpenStreetMap (ArtState.layers.osm).
 * 3. Switching from light to dark removes OSM and activates Aero Midnight (Dark).
 * 4. Switching from dark to light removes Aero Midnight (Dark) and activates OpenStreetMap.
 * 5. Event listener for 'themeChanged' successfully triggers setMapBaseLayerForTheme.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const skyArtJsPath = path.join(__dirname, '..', 'static', 'js', 'sky_art.js');
const skyArtJsCode = fs.readFileSync(skyArtJsPath, 'utf8');

function createEnvironment(initialTheme = 'light') {
    const domElements = {};
    function getOrCreateElement(id) {
        if (!domElements[id]) {
            domElements[id] = {
                id,
                value: '',
                innerText: '',
                innerHTML: '',
                classList: {
                    classes: new Set(id === 'body' && initialTheme === 'dark' ? ['dark-mode'] : []),
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
                addEventListener(ev, fn) {
                    this['on_' + ev] = fn;
                },
                querySelectorAll() { return []; },
                closest() { return null; }
            };
        }
        return domElements[id];
    }

    const mockBody = getOrCreateElement('body');
    const domListeners = {};

    const mockDocument = {
        body: mockBody,
        getElementById(id) {
            if (id === 'body') return mockBody;
            return getOrCreateElement(id);
        },
        querySelectorAll() { return []; },
        addEventListener(ev, fn) {
            if (!domListeners[ev]) domListeners[ev] = [];
            domListeners[ev].push(fn);
        },
        cookie: ''
    };

    const mockLocalStorage = {
        store: { theme: initialTheme },
        getItem(k) { return this.store[k] || null; },
        setItem(k, v) { this.store[k] = String(v); },
        removeItem(k) { delete this.store[k]; }
    };

    const layersOnMap = new Set();
    const mockMap = {
        layersOnMap,
        setView() {},
        fitBounds() {},
        addLayer(l) { layersOnMap.add(l); },
        removeLayer(l) { layersOnMap.delete(l); },
        hasLayer(l) { return layersOnMap.has(l); },
        on() {},
        getCenter() { return { lat: 37.0816, lng: -121.5970 }; },
        latLngToLayerPoint(ll) { return { x: 100, y: 100 }; },
        layerPointToLatLng(p) { return { lat: 37.0, lon: -121.0 }; }
    };

    function createMockTileLayer(name) {
        return {
            name,
            broughtToBack: false,
            addTo(m) {
                m.addLayer(this);
                return this;
            },
            bringToBack() {
                this.broughtToBack = true;
            }
        };
    }

    const mockL = {
        polyline: () => ({
            bindTooltip() { return this; },
            on() { return this; },
            addTo(m) { m.addLayer(this); return this; },
            setLatLngs() {}
        }),
        marker: (latlng, opts) => ({
            latlng,
            opts,
            events: {},
            bindTooltip() { return this; },
            on(ev, fn) { this.events[ev] = fn; return this; },
            addTo(m) { m.addLayer(this); return this; },
            setLatLng(newLL) { this.latlng = newLL; },
            getLatLng() { return this.latlng; }
        }),
        divIcon: (opts) => opts,
        latLngBounds: () => ({}),
        map: (containerId, opts) => {
            if (opts && Array.isArray(opts.layers)) {
                opts.layers.forEach(l => mockMap.addLayer(l));
            }
            return mockMap;
        },
        Map: { addInitHook() {} },
        DomEvent: { stopPropagation() {}, preventDefault() {} },
        tileLayer: (url) => {
            if (url.includes('openstreetmap')) return createMockTileLayer('osm');
            if (url.includes('dark_all')) return createMockTileLayer('cartoDark');
            if (url.includes('voyager')) return createMockTileLayer('cartoVoyager');
            return createMockTileLayer('satellite');
        },
        control: {
            layers: () => ({ addTo() {} }),
            scale: () => ({ addTo() {} })
        }
    };

    const eventListeners = {};
    const mockWindow = {
        document: mockDocument,
        localStorage: mockLocalStorage,
        L: mockL,
        addEventListener(ev, fn) {
            if (!eventListeners[ev]) eventListeners[ev] = [];
            eventListeners[ev].push(fn);
        },
        dispatchEvent(event) {
            const handlers = eventListeners[event.type] || [];
            handlers.forEach(fn => fn(event));
        }
    };

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
        fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve([]) })
    });

    vm.runInContext(skyArtJsCode, context);

    if (domListeners['DOMContentLoaded']) {
        domListeners['DOMContentLoaded'].forEach(fn => fn());
    }

    return {
        mockWindow,
        mockDocument,
        mockLocalStorage,
        mockMap,
        layersOnMap,
        ArtState: mockWindow.ArtState,
        setMapBaseLayerForTheme: mockWindow.setMapBaseLayerForTheme
    };
}

console.log("🧪 Running Theme & Map Base Layer Synchronization Tests...\n");

// --- Test 1: Light Mode Initial Base Layer ---
console.log("👉 Test 1: Light mode initializes map with OpenStreetMap (OSM)...");
const envLight = createEnvironment('light');
const ArtStateLight = envLight.ArtState;
assert(ArtStateLight.map.hasLayer(ArtStateLight.layers.osm), "OpenStreetMap must be the active base layer in light mode");
assert(!ArtStateLight.map.hasLayer(ArtStateLight.layers.cartoDark), "Aero Midnight (Dark) must NOT be active in light mode");
console.log("✅ Test 1 Passed: Initial light mode base layer is OpenStreetMap.");

// --- Test 2: Dark Mode Initial Base Layer ---
console.log("\n👉 Test 2: Dark mode initializes map with Aero Midnight (Dark)...");
const envDark = createEnvironment('dark');
const ArtStateDark = envDark.ArtState;
assert(ArtStateDark.map.hasLayer(ArtStateDark.layers.cartoDark), "Aero Midnight (Dark) must be active base layer in dark mode");
assert(!ArtStateDark.map.hasLayer(ArtStateDark.layers.osm), "OpenStreetMap must NOT be active in dark mode");
console.log("✅ Test 2 Passed: Initial dark mode base layer is Aero Midnight (Dark).");

// --- Test 3: Switching from Light Mode to Dark Mode ---
console.log("\n👉 Test 3: Switching to Dark Mode swaps base layer to Aero Midnight (Dark)...");
envLight.setMapBaseLayerForTheme(true);
assert(envLight.ArtState.map.hasLayer(envLight.ArtState.layers.cartoDark), "Aero Midnight (Dark) must now be active");
assert(!envLight.ArtState.map.hasLayer(envLight.ArtState.layers.osm), "OpenStreetMap must be removed from map");
assert.strictEqual(envLight.ArtState.layers.cartoDark.broughtToBack, true, "Active tile layer must be brought to back");
console.log("✅ Test 3 Passed: Successfully swapped to Aero Midnight (Dark) and removed OSM.");

// --- Test 4: Switching back to Light Mode ---
console.log("\n👉 Test 4: Switching back to Light Mode swaps base layer to OpenStreetMap...");
envLight.setMapBaseLayerForTheme(false);
assert(envLight.ArtState.map.hasLayer(envLight.ArtState.layers.osm), "OpenStreetMap must now be active");
assert(!envLight.ArtState.map.hasLayer(envLight.ArtState.layers.cartoDark), "Aero Midnight (Dark) must be removed from map");
assert.strictEqual(envLight.ArtState.layers.osm.broughtToBack, true, "Active tile layer must be brought to back");
console.log("✅ Test 4 Passed: Successfully swapped back to OpenStreetMap and removed Aero Midnight (Dark).");

// --- Test 5: Event-Driven Switching via 'themeChanged' Custom Event ---
console.log("\n👉 Test 5: 'themeChanged' window event triggers layer swap...");
envLight.mockWindow.dispatchEvent({ type: 'themeChanged', detail: { isDark: true } });
assert(envLight.ArtState.map.hasLayer(envLight.ArtState.layers.cartoDark), "Event must trigger switch to Aero Midnight (Dark)");
assert(!envLight.ArtState.map.hasLayer(envLight.ArtState.layers.osm), "Event must remove OpenStreetMap");
console.log("✅ Test 5 Passed: 'themeChanged' event correctly triggers base layer switch.");

console.log("\n🎉 All 5 Theme & Map Base Layer tests PASSED successfully!\n");
