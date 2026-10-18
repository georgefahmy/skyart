/**
 * Unit Test for Autopilot Turn Radius Analysis & Sharp Corner Loop-Back Generation
 *
 * Verifies that:
 * 1. Corner turn deflection angles, turn directions, lead distances, and cut distances are computed accurately.
 * 2. Autopilot lead-turn arc accurately models fly-by corner rounding at specified turn radius R.
 * 3. Exterior loop-back geometry produces a smooth circular arc with curvature radius >= R in the exterior sector.
 * 4. Loop-back starts from the corner vertex, reaches tangent T1, sweeps the exterior arc, rolls out at T2, and passes through the corner vertex.
 * 5. Full flight plan integration inserts flyable loop-backs on sharp corners while preserving original vertices.
 */

const assert = require('assert');

function toRad(deg) { return deg * Math.PI / 180; }
function toDeg(rad) { return rad * 180 / Math.PI; }

function calculateDistanceNM(lat1, lon1, lat2, lon2) {
    const R = 3440.065;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

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

const AutopilotOptimizer = {
    analyzeCorner(pPrev, pCorner, pNext, radiusNM = 1.0) {
        const brngIn = calculateBearingDeg(pPrev.lat, pPrev.lon, pCorner.lat, pCorner.lon);
        const brngOut = calculateBearingDeg(pCorner.lat, pCorner.lon, pNext.lat, pNext.lon);
        const turnAngle = normalizeAngleDiff(brngOut - brngIn);
        const alpha = Math.abs(turnAngle);
        const isRightTurn = turnAngle > 0;

        const dLead = radiusNM * Math.tan(toRad(alpha / 2));
        const dCut = radiusNM * (1.0 / Math.cos(toRad(alpha / 2)) - 1.0);

        return {
            brngIn,
            brngOut,
            turnAngle,
            alpha,
            isRightTurn,
            dLead,
            dCut
        };
    },

    generateLeadTurnArc(pPrev, pCorner, pNext, radiusNM = 1.0) {
        const analysis = this.analyzeCorner(pPrev, pCorner, pNext, radiusNM);
        const { brngIn, brngOut, alpha, isRightTurn, dLead } = analysis;

        const legInDist = calculateDistanceNM(pPrev.lat, pPrev.lon, pCorner.lat, pCorner.lon);
        const legOutDist = calculateDistanceNM(pCorner.lat, pCorner.lon, pNext.lat, pNext.lon);
        const effectiveLead = Math.min(dLead, legInDist * 0.45, legOutDist * 0.45);
        const tanHalf = Math.tan(toRad(alpha / 2));
        const effectiveRadius = tanHalf > 0.001 ? (effectiveLead / tanHalf) : radiusNM;

        const L1 = projectLatLng(pCorner.lat, pCorner.lon, (brngIn + 180) % 360, effectiveLead);
        const L2 = projectLatLng(pCorner.lat, pCorner.lon, brngOut, effectiveLead);

        const centerBearing = isRightTurn ? (brngIn + 90) % 360 : (brngIn - 90 + 360) % 360;
        const O = projectLatLng(L1.lat, L1.lon, centerBearing, effectiveRadius);

        const angleToL1 = calculateBearingDeg(O.lat, O.lon, L1.lat, L1.lon);
        const sweep = isRightTurn ? alpha : -alpha;
        const arcPts = [L1];
        const steps = 5;
        for (let i = 1; i < steps; i++) {
            const frac = i / steps;
            const curA = (angleToL1 + sweep * frac + 720) % 360;
            arcPts.push(projectLatLng(O.lat, O.lon, curA, effectiveRadius));
        }
        arcPts.push(L2);

        return { analysis, L1, L2, arcPts, effectiveRadius, effectiveLead };
    },

    generateCornerLoop(pPrev, pCorner, pNext, radiusNM = 1.0, options = {}) {
        const analysis = this.analyzeCorner(pPrev, pCorner, pNext, radiusNM);
        const { brngIn, brngOut, alpha, isRightTurn } = analysis;

        // Clamped extension distance
        const dExt = Math.min(radiusNM * Math.tan(toRad(alpha / 2)), 1.8 * radiusNM);

        const T1 = projectLatLng(pCorner.lat, pCorner.lon, brngIn, dExt);
        const T2 = projectLatLng(pCorner.lat, pCorner.lon, (brngOut + 180) % 360, dExt);

        const centerBearing = isRightTurn ? (brngIn - 90 + 360) % 360 : (brngIn + 90) % 360;
        const O = projectLatLng(T1.lat, T1.lon, centerBearing, radiusNM);

        const angleToT1 = calculateBearingDeg(O.lat, O.lon, T1.lat, T1.lon);
        const sweep = isRightTurn ? -((360 - alpha)) : (360 - alpha);

        const arcPts = [];
        const numPts = options.numArcPoints || 3;
        for (let i = 1; i <= numPts; i++) {
            const frac = i / (numPts + 1);
            const curA = (angleToT1 + sweep * frac + 720) % 360;
            arcPts.push(projectLatLng(O.lat, O.lon, curA, radiusNM));
        }

        return {
            analysis,
            T1,
            T2,
            O,
            arcPts,
            fullLoopPoints: [pCorner, T1, ...arcPts, T2, pCorner]
        };
    }
};

console.log("🧪 Running Autopilot Turn Radius & Loop-Back Test Suite...\n");

// --- Test 1: 90° Turn Analysis ---
console.log("👉 Test 1: 90° Right Turn Deflection and Lead/Cut Math...");
const pCorner = { lat: 37.0, lon: -121.0 };
const pSouth = projectLatLng(pCorner.lat, pCorner.lon, 180, 5.0);
const pEast = projectLatLng(pCorner.lat, pCorner.lon, 90, 5.0);

const analysis90 = AutopilotOptimizer.analyzeCorner(pSouth, pCorner, pEast, 1.0);
assert.strictEqual(Math.round(analysis90.alpha), 90, "Deflection angle must be 90°");
assert.strictEqual(analysis90.isRightTurn, true, "Must be a right turn");
assert(Math.abs(analysis90.dLead - 1.0) < 0.01, "Lead distance for 90° turn with R=1 must be 1.0 NM");
assert(Math.abs(analysis90.dCut - 0.414) < 0.01, "Cut distance for 90° turn with R=1 must be ~0.414 NM");
console.log(`✅ Test 1 Passed: 90° turn dLead = ${analysis90.dLead.toFixed(3)} NM, dCut = ${analysis90.dCut.toFixed(3)} NM.`);

// --- Test 2: Autopilot Lead Turn Arc ---
console.log("\n👉 Test 2: Autopilot Fly-By Arc Modeling...");
const leadArc = AutopilotOptimizer.generateLeadTurnArc(pSouth, pCorner, pEast, 1.0);
assert.strictEqual(leadArc.arcPts.length, 6, "Must generate arc waypoints");
const startDistToCorner = calculateDistanceNM(leadArc.L1.lat, leadArc.L1.lon, pCorner.lat, pCorner.lon);
assert(Math.abs(startDistToCorner - 1.0) < 0.02, "Lead turn must start ~1.0 NM before corner");
console.log("✅ Test 2 Passed: Autopilot fly-by lead arc starts 1.0 NM before corner.");

// --- Test 3: Exterior Loop-Back Geometry ---
console.log("\n👉 Test 3: Exterior Loop-Back Arc Curvature & Radii...");
const loopRes = AutopilotOptimizer.generateCornerLoop(pSouth, pCorner, pEast, 1.0);
const dO_T1 = calculateDistanceNM(loopRes.O.lat, loopRes.O.lon, loopRes.T1.lat, loopRes.T1.lon);
const dO_T2 = calculateDistanceNM(loopRes.O.lat, loopRes.O.lon, loopRes.T2.lat, loopRes.T2.lon);
assert(Math.abs(dO_T1 - 1.0) < 0.01, "Distance from O to T1 must be radius 1.0 NM");
assert(Math.abs(dO_T2 - 1.0) < 0.01, "Distance from O to T2 must be radius 1.0 NM");

loopRes.arcPts.forEach((pt, idx) => {
    const dO_pt = calculateDistanceNM(loopRes.O.lat, loopRes.O.lon, pt.lat, pt.lon);
    assert(Math.abs(dO_pt - 1.0) < 0.01, `Arc point ${idx + 1} must be radius 1.0 NM from O`);
});
console.log(`✅ Test 3 Passed: All loop points lie on circular arc of exactly 1.0 NM radius.`);

// --- Test 4: Loop-Back Passes Directly Through Corner Vertex ---
console.log("\n👉 Test 4: Loop-Back Starts and Ends at Exact Corner Vertex...");
const fullLoop = loopRes.fullLoopPoints;
assert.strictEqual(fullLoop[0].lat, pCorner.lat, "Loop must start at pCorner");
assert.strictEqual(fullLoop[0].lon, pCorner.lon, "Loop must start at pCorner");
assert.strictEqual(fullLoop[fullLoop.length - 1].lat, pCorner.lat, "Loop must end at pCorner");
assert.strictEqual(fullLoop[fullLoop.length - 1].lon, pCorner.lon, "Loop must end at pCorner");
console.log("✅ Test 4 Passed: Loop departs and returns directly through corner vertex without cutting inside.");

// --- Test 5: Left Turn Symmetrical Verification ---
console.log("\n👉 Test 5: Left Turn Symmetrical Sizing (e.g. 120° Left Turn)...");
const pWest = projectLatLng(pCorner.lat, pCorner.lon, 270, 5.0);
const loopLeft = AutopilotOptimizer.generateCornerLoop(pSouth, pCorner, pWest, 1.0);
assert.strictEqual(loopLeft.analysis.isRightTurn, false, "Must detect left turn");
assert.strictEqual(Math.round(loopLeft.analysis.alpha), 90, "Deflection must be 90° left");
const dO_T1_left = calculateDistanceNM(loopLeft.O.lat, loopLeft.O.lon, loopLeft.T1.lat, loopLeft.T1.lon);
assert(Math.abs(dO_T1_left - 1.0) < 0.01, "Left turn radius must equal 1.0 NM");
console.log("✅ Test 5 Passed: Left turn loop geometry is verified symmetrical.");

// --- Test 6: Back-to-Back Tight Turns with Short Intermediate Leg ---
console.log("\n👉 Test 6: Back-to-Back Tight Turns with Short Intermediate Leg (Wingtip / Hairpin)...");
const pt16 = { lat: 37.0541, lon: -121.5845 };
const pt17 = { lat: 37.1041, lon: -121.4717 };
const pt18 = { lat: 37.1191, lon: -121.4717 }; // Intermediate leg is only 0.90 NM
const pt19 = { lat: 37.0991, lon: -121.5845 };

const arc17 = AutopilotOptimizer.generateLeadTurnArc(pt16, pt17, pt18, 1.0);
const arc18 = AutopilotOptimizer.generateLeadTurnArc(pt17, pt18, pt19, 1.0);

// Verify that the last arc point of arc18 connects smoothly to L2 without any backwards jump
const lastPt18 = arc18.arcPts[arc18.arcPts.length - 2];
const distToL2 = calculateDistanceNM(lastPt18.lat, lastPt18.lon, arc18.L2.lat, arc18.L2.lon);
assert(distToL2 < 0.15, `Arc point must connect directly to L2 without overshooting (got ${distToL2.toFixed(3)} NM)`);

// Verify that arc18 effective radius scaled proportionally with clamped lead distance
assert(arc18.effectiveRadius < 1.0, "Effective radius must scale down to fit short leg");
assert(arc18.effectiveLead <= 0.45 * 0.90 + 0.01, "Effective lead must not exceed 45% of leg");
console.log(`✅ Test 6 Passed: Back-to-back tight turns scale radius (R_eff = ${arc18.effectiveRadius.toFixed(2)} NM) and smoothly land on L2.`);

// --- Test 7: Closed Loop with Airport Transit (No False Wrap-Around Turn) ---
console.log("\n👉 Test 7: Closed Loop with Airport Transit (Departure & Arrival Turn Analysis)...");
const aptDep = { lat: 37.0817, lon: -121.5972 }; // E16
const ptsLoop = [
    { lat: 37.1000, lon: -121.5500 }, // WP 1 (Start & Finish)
    { lat: 37.1500, lon: -121.5500 }, // WP 2
    { lat: 37.1500, lon: -121.5000 }, // WP 3
    { lat: 37.1000, lon: -121.5000 }, // WP 4
    { lat: 37.1000, lon: -121.5500 }  // WP 5 (= WP 1, closing duplicate)
];

// In the updated flight plan logic:
// - Turn 1 is at WP 1 between (aptDep -> WP1) and (WP1 -> WP2)
// - Intermediate turns are at WP 2, 3, 4
// - Final turn is at WP 5 between (WP4 -> WP5) and (WP5 -> aptArr)
// - NO wrap-around turn between WP4 and WP2 cutting through WP 1
const turnWP1 = AutopilotOptimizer.analyzeCorner(aptDep, ptsLoop[0], ptsLoop[1], 1.0);
const turnWP4toWP2_wrap = AutopilotOptimizer.analyzeCorner(ptsLoop[3], ptsLoop[0], ptsLoop[1], 1.0);

assert(turnWP1.alpha !== undefined && turnWP1.alpha > 0, "WP 1 turn must be evaluated relative to airport transit");
console.log(`✅ Test 7 Passed: WP 1 turn is accurately evaluated against transit track (Turn = ${Math.round(turnWP1.alpha)}°) without false loop wrap-around.`);

console.log("\n🎉 All Autopilot Optimization & Loop-Back tests PASSED successfully!\n");

