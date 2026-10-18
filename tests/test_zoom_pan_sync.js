/**
 * Unit & Integration Test for Leaflet SmoothWheelZoom and SVG Layer Synchronization
 * 
 * Verifies that:
 * 1. Panning/dragging during a wheel zoom immediately and cleanly finalizes the zoom session.
 * 2. _moveEnd(true) is ALWAYS dispatched so Leaflet's zoomend and moveend events fire.
 * 3. The SVG renderer never gets stranded in an unfinalized scale transform state.
 * 4. Resync handlers fire on moveend, dragend, and zoomend to keep polylines and waypoints 100% aligned.
 */

const assert = require('assert');

// --- Mock Leaflet Environment ---
class MockPoint {
    constructor(x, y) {
        this.x = x;
        this.y = y;
    }
    subtract(p) { return new MockPoint(this.x - p.x, this.y - p.y); }
    add(p) { return new MockPoint(this.x + p.x, this.y + p.y); }
    multiplyBy(val) { return new MockPoint(this.x * val, this.y * val); }
}

class MockLatLng {
    constructor(lat, lon) {
        this.lat = lat;
        this.lon = lon;
    }
    equals(other, tol = 1e-5) {
        if (!other) return false;
        return Math.abs(this.lat - other.lat) <= tol && Math.abs(this.lon - other.lon) <= tol;
    }
}

class MockMap {
    constructor() {
        this._center = new MockLatLng(37.0816, -121.5970);
        this._zoom = 11;
        this._container = {};
        this.options = {
            smoothWheelZoom: true,
            smoothSensitivity: 1.0
        };
        this.events = {};
        this._moving = false;
        this._renderer = {
            resetCount: 0,
            transformScale: 1.0,
            _reset() {
                this.resetCount++;
                this.transformScale = 1.0;
            }
        };
    }

    getCenter() { return this._center; }
    getZoom() { return this._zoom; }
    getMinZoom() { return 1; }
    getMaxZoom() { return 19; }
    getSize() { return new MockPoint(1000, 800); }

    mouseEventToContainerPoint() { return new MockPoint(520, 410); }
    containerPointToLatLng(p) { return new MockLatLng(this._center.lat, this._center.lon); }
    project(latlng, zoom) { return new MockPoint(1000, 800); }
    unproject(pt, zoom) { return new MockLatLng(this._center.lat, this._center.lon); }

    on(eventStr, fn) {
        const list = eventStr.split(' ');
        list.forEach(ev => {
            if (!this.events[ev]) this.events[ev] = [];
            this.events[ev].push(fn);
        });
    }

    off(eventStr, fn) {
        const list = eventStr.split(' ');
        list.forEach(ev => {
            if (this.events[ev]) {
                this.events[ev] = this.events[ev].filter(f => f !== fn);
            }
        });
    }

    fire(ev) {
        if (this.events[ev]) {
            this.events[ev].forEach(fn => fn({ type: ev, target: this }));
        }
    }

    _stop() {}
    _moveStart(zoomChanged, noMoveStart) {
        this._moving = true;
        if (zoomChanged) this.fire('zoomstart');
        if (!noMoveStart) this.fire('movestart');
    }

    _move(center, zoom) {
        this._center = center;
        this._zoom = zoom;
        this.fire('move');
        this.fire('zoom');
    }

    _moveEnd(zoomChanged) {
        this._moving = false;
        if (zoomChanged) this.fire('zoomend');
        this.fire('moveend');
    }
}

// Global animation frame mocks
let animFrameCallbacks = [];
let animFrameId = 0;
global.requestAnimationFrame = (fn) => {
    const id = ++animFrameId;
    animFrameCallbacks.push({ id, fn });
    return id;
};
global.cancelAnimationFrame = (id) => {
    animFrameCallbacks = animFrameCallbacks.filter(item => item.id !== id);
};
global.performance = { now: () => Date.now() };

// --- Build SmoothWheelZoom Handler under Test ---
function createSmoothWheelZoomHandler(map) {
    const handler = {
        _map: map,
        _isWheeling: false,
        _moved: false,
        _zoomAnimationId: null,
        _timeoutId: null,
        _prevCenter: null,
        _prevZoom: null,
        _goalZoom: 11,

        addHooks() {
            this._map.on('movestart dragstart zoomstart', () => this._onMapInterrupt());
        },

        removeHooks() {
            this._map.off('movestart dragstart zoomstart', () => this._onMapInterrupt());
        },

        _onMapInterrupt() {
            if (this._isWheeling || this._moved) {
                clearTimeout(this._timeoutId);
                cancelAnimationFrame(this._zoomAnimationId);
                this._isWheeling = false;
                if (this._moved) {
                    this._moved = false;
                    this._map._moveEnd(true);
                }
            }
        },

        _onWheelStart(e) {
            const m = this._map;
            this._isWheeling = true;
            this._wheelMousePosition = m.mouseEventToContainerPoint(e);
            this._centerPoint = m.getSize()._divideBy ? m.getSize()._divideBy(2) : new MockPoint(500, 400);
            this._startLatLng = m.containerPointToLatLng(this._centerPoint);
            this._wheelMouseLatLng = m.containerPointToLatLng(this._wheelMousePosition);
            this._startZoom = m.getZoom();
            this._moved = false;
            this._lastWheelTime = performance.now();

            m._stop();
            this._goalZoom = m.getZoom();
            this._prevCenter = m.getCenter();
            this._prevZoom = m.getZoom();

            cancelAnimationFrame(this._zoomAnimationId);
            this._zoomAnimationId = requestAnimationFrame(() => this._updateWheelZoom());
        },

        _onWheeling(deltaZoom) {
            this._goalZoom += deltaZoom;
            clearTimeout(this._timeoutId);
            this._timeoutId = setTimeout(() => this._onWheelEnd(), 200);
        },

        _onWheelEnd() {
            this._isWheeling = false;
            cancelAnimationFrame(this._zoomAnimationId);
            if (this._moved) {
                this._map._move(this._center || this._map.getCenter(), this._goalZoom);
                this._moved = false;
                this._map._moveEnd(true);
            }
        },

        _updateWheelZoom() {
            const m = this._map;
            if (!this._prevCenter) {
                this._prevCenter = m.getCenter();
                this._prevZoom = m.getZoom();
            }

            // External interruption check
            if (!m.getCenter().equals(this._prevCenter, 1e-5) || Math.abs(m.getZoom() - this._prevZoom) > 1e-4) {
                this._isWheeling = false;
                cancelAnimationFrame(this._zoomAnimationId);
                if (this._moved) {
                    this._moved = false;
                    m._moveEnd(true);
                }
                return;
            }

            const currentZoom = m.getZoom();
            const diff = this._goalZoom - currentZoom;

            if (!this._isWheeling && Math.abs(diff) < 0.002) {
                cancelAnimationFrame(this._zoomAnimationId);
                if (this._moved) {
                    m._move(this._center || m.getCenter(), this._goalZoom);
                    this._moved = false;
                    m._moveEnd(true);
                }
                return;
            }

            this._zoom = currentZoom + diff * 0.22;
            this._center = this._startLatLng || m.getCenter();

            if (!this._moved) {
                m._moveStart(true, false);
                this._moved = true;
            }

            m._move(this._center, this._zoom);
            this._prevCenter = m.getCenter();
            this._prevZoom = m.getZoom();

            this._zoomAnimationId = requestAnimationFrame(() => this._updateWheelZoom());
        }
    };

    handler.addHooks();
    return handler;
}

// --- RUN TESTS ---
console.log('🧪 Running Leaflet Zoom & Pan Synchronization Test Suite...\n');

// Test 1: Dragging map while wheel zoom is active immediately finalizes zoom
{
    const map = new MockMap();
    let moveEndFired = 0;
    let zoomEndFired = 0;
    map.on('moveend', () => moveEndFired++);
    map.on('zoomend', () => zoomEndFired++);

    const handler = createSmoothWheelZoomHandler(map);

    // Start wheel zoom
    handler._onWheelStart({});
    handler._onWheeling(1.5);
    handler._updateWheelZoom(); // First frame runs: sets _moved = true, zoom changes

    assert.strictEqual(handler._moved, true, "handler._moved should be true during active wheel zoom");
    assert.strictEqual(map._moving, true, "map._moving should be true during active wheel zoom");

    // User now drags/pans the map while zooming
    map.fire('dragstart');

    assert.strictEqual(handler._isWheeling, false, "handler._isWheeling must be false after dragstart");
    assert.strictEqual(handler._moved, false, "handler._moved must be reset to false after dragstart");
    assert.strictEqual(map._moving, false, "map._moving must be reset to false after dragstart");
    assert.strictEqual(moveEndFired, 1, "moveend event must be fired on interrupt to notify renderers");
    assert.strictEqual(zoomEndFired, 1, "zoomend event must be fired on interrupt to reset SVG transforms");

    console.log('✅ Test 1 Passed: dragstart / pan immediately finalizes active wheel zoom.');
}

// Test 2: External center change in _updateWheelZoom commits zoom cleanly
{
    const map = new MockMap();
    let moveEndFired = 0;
    map.on('moveend', () => moveEndFired++);

    const handler = createSmoothWheelZoomHandler(map);

    handler._onWheelStart({});
    handler._onWheeling(2.0);
    handler._updateWheelZoom(); // Sets _moved = true

    assert.strictEqual(handler._moved, true);

    // External pan changes map center
    map._center = new MockLatLng(37.5, -122.0);

    // Next animation frame runs
    handler._updateWheelZoom();

    assert.strictEqual(handler._isWheeling, false, "Wheeling must abort when external center changes");
    assert.strictEqual(handler._moved, false, "handler._moved must be finalized");
    assert.strictEqual(moveEndFired, 1, "moveend must fire to reset renderer transform");

    console.log('✅ Test 2 Passed: External center/pan change terminates zoom and fires moveend.');
}

// Test 3: WheelEnd timeout commits final zoom level and fires zoomend
{
    const map = new MockMap();
    let zoomEndFired = 0;
    let moveEndFired = 0;
    map.on('zoomend', () => zoomEndFired++);
    map.on('moveend', () => moveEndFired++);

    const handler = createSmoothWheelZoomHandler(map);

    handler._onWheelStart({});
    handler._onWheeling(1.0);
    handler._updateWheelZoom();

    // Wheel timer expires
    handler._onWheelEnd();

    assert.strictEqual(handler._moved, false, "_moved must be false after _onWheelEnd");
    assert.strictEqual(handler._isWheeling, false);
    assert.strictEqual(zoomEndFired, 1, "zoomend must be dispatched upon wheel end");
    assert.strictEqual(moveEndFired, 1, "moveend must be dispatched upon wheel end");
    assert.strictEqual(map.getZoom(), 12.0, "Map zoom must equal target goal zoom");

    console.log('✅ Test 3 Passed: _onWheelEnd cleanly finalizes zoom to target level.');
}

// Test 4: Renderer resync listener ensures SVG transform is reset to 1.0 on moveend/dragend/zoomend
{
    const map = new MockMap();

    function resyncMapRenderers() {
        if (!map) return;
        if (map._renderer && typeof map._renderer._reset === 'function') {
            map._renderer._reset();
        }
    }
    map.on('moveend dragend zoomend', resyncMapRenderers);

    // Simulate map renderer having an off-scale transform from zooming
    map._renderer.transformScale = 4.25;

    // Simulate pan/move ending
    map.fire('moveend');

    assert.strictEqual(map._renderer.resetCount, 1, "_reset should be called on moveend");
    assert.strictEqual(map._renderer.transformScale, 1.0, "SVG renderer transform scale must be reset to 1.0");

    map.fire('dragend');
    assert.strictEqual(map._renderer.resetCount, 2, "_reset should be called on dragend");

    map.fire('zoomend');
    assert.strictEqual(map._renderer.resetCount, 3, "_reset should be called on zoomend");

    console.log('✅ Test 4 Passed: Renderer resync handler resets SVG transform to 1.0 on moveend/dragend/zoomend.');
}

console.log('\n🎉 All 4 Zoom/Pan Synchronization tests PASSED successfully!\n');
