/**
 * Unit Test for SkyArt Frontend Authentication UI & Password Rule Validator
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const skyArtJsPath = path.join(__dirname, '..', 'static', 'js', 'sky_art.js');
const skyArtJsCode = fs.readFileSync(skyArtJsPath, 'utf8');

function createEnvironment() {
    const domElements = {};
    function getOrCreateElement(id) {
        if (!domElements[id]) {
            domElements[id] = {
                id,
                value: '',
                innerText: '',
                innerHTML: '',
                checked: false,
                required: false,
                open: false,
                returnValue: '',
                attributes: {},
                style: { display: '' },
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
                setAttribute(k, v) {
                    this.attributes[k] = String(v);
                },
                getAttribute(k) {
                    return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null;
                },
                removeAttribute(k) {
                    delete this.attributes[k];
                },
                showModal() {
                    this.open = true;
                },
                close() {
                    this.open = false;
                    this.dispatchEvent('close');
                },
                addEventListener(ev, fn) {
                    this['on_' + ev] = fn;
                },
                dispatchEvent(ev, data = {}) {
                    const evName = typeof ev === 'string' ? ev : (ev.type || 'click');
                    if (typeof this['on_' + evName] === 'function') {
                        return this['on_' + evName]({ preventDefault() {}, stopPropagation() {}, target: this, ...data });
                    }
                },
                querySelector() { return null; },
                querySelectorAll() { return []; },
                closest() { return null; },
                focus() {},
                blur() {}
            };
        }
        return domElements[id];
    }

    const mockDocument = {
        body: getOrCreateElement('body'),
        getElementById(id) {
            return getOrCreateElement(id);
        },
        querySelector(sel) {
            if (sel.startsWith('#')) return getOrCreateElement(sel.slice(1));
            return getOrCreateElement('mock_' + sel);
        },
        querySelectorAll() { return []; },
        addEventListener(ev, fn) {
            this['on_' + ev] = fn;
        },
        cookie: ''
    };

    const mockWindow = {
        document: mockDocument,
        localStorage: {
            store: {},
            getItem(k) { return this.store[k] || null; },
            setItem(k, v) { this.store[k] = String(v); },
            removeItem(k) { delete this.store[k]; }
        },
        L: {
            polyline: () => ({ addTo: () => ({}), bindTooltip: () => ({}), on: () => ({}), setLatLngs: () => ({}) }),
            marker: () => ({ addTo: () => ({}), bindTooltip: () => ({}), on: () => ({}), setLatLng: () => ({}) }),
            divIcon: (opts) => opts,
            map: () => ({
                setView: () => ({}),
                fitBounds: () => ({}),
                hasLayer: () => false,
                removeLayer: () => ({}),
                on: () => ({})
            })
        },
        console,
        fetch: async () => ({ ok: true, json: async () => ({ authenticated: false }) }),
        addEventListener: () => {}
    };

    const context = vm.createContext({
        window: mockWindow,
        document: mockDocument,
        localStorage: mockWindow.localStorage,
        L: mockWindow.L,
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
        fetch: (...args) => mockWindow.fetch(...args)
    });
    vm.runInContext(skyArtJsCode, context);
    return { mockWindow, mockDocument, getOrCreateElement };
}

console.log("🧪 Running SkyArt Frontend Authentication UI Tests...");

const { mockWindow, mockDocument, getOrCreateElement } = createEnvironment();

// Test 1: checkPasswordRules client-side validator
console.log("\n👉 Test 1: Password rules validator...");
const checkRules = mockWindow.checkPasswordRules;
assert.strictEqual(typeof checkRules, 'function', "checkPasswordRules must be exposed");

const invalidShort = checkRules("Aa1!");
assert.strictEqual(invalidShort.len, false, "Must fail length under 8");

const invalidNoUpper = checkRules("nouppercase123!");
assert.strictEqual(invalidNoUpper.upper, false, "Must fail missing uppercase");

const invalidNoLower = checkRules("NOLOWERCASE123!");
assert.strictEqual(invalidNoLower.lower, false, "Must fail missing lowercase");

const invalidNoNum = checkRules("NoNumbersHere!");
assert.strictEqual(invalidNoNum.num, false, "Must fail missing numbers");

const invalidNoSpecial = checkRules("NoSpecialChar123");
assert.strictEqual(invalidNoSpecial.special, false, "Must fail missing special symbol");

const validPass = checkRules("StrongPilot99#");
assert.strictEqual(validPass.len && validPass.upper && validPass.lower && validPass.num && validPass.special, true, "Valid strong password must pass all rules");
console.log("✅ Test 1 Passed: Client-side password rule verification validates all 5 criteria accurately.");

// Test 2: Unauthenticated state displays auth gate overlay
console.log("\n👉 Test 2: Unauthenticated state displays full-screen auth gate overlay...");
mockWindow.onAuthRequired();
const overlay = getOrCreateElement('authGateOverlay');
assert.strictEqual(overlay.style.display, 'flex', "Auth gate overlay must be displayed ('flex') when unauthenticated");
const accountMenu = getOrCreateElement('userAccountDropdownContainer');
assert.strictEqual(accountMenu.style.display, 'none', "User account dropdown must be hidden when unauthenticated");
assert.strictEqual(accountMenu.classList.contains('d-none'), true, "User account dropdown must have d-none class");
const openAuthBtn = getOrCreateElement('openAuthModalBtn');
assert.strictEqual(openAuthBtn.style.display, 'flex', "Sign in button must be visible when unauthenticated");
assert.strictEqual(openAuthBtn.classList.contains('d-none'), false, "Sign in button must not have d-none class");
console.log("✅ Test 2 Passed: Unauthenticated state activates overlay gate and hides user account dropdown.");

// Test 3: Authenticated state unlocks studio and populates navbar account details
console.log("\n👉 Test 3: Authenticated state unlocks studio and populates navbar...");
const testUser = {
    id: "user_test_uuid_123",
    email: "topgun@example.com",
    createdAt: "2026-01-15T00:00:00Z"
};
mockWindow.onAuthSuccess(testUser);

assert.strictEqual(overlay.style.display, 'none', "Auth gate overlay must be hidden after successful authentication");
assert.strictEqual(accountMenu.style.display, 'block', "User account dropdown must be visible after authentication");
assert.strictEqual(accountMenu.classList.contains('d-none'), false, "User account dropdown must not have d-none class");
assert.strictEqual(openAuthBtn.style.display, 'none', "Sign In button must be hidden when authenticated");
assert.strictEqual(openAuthBtn.classList.contains('d-none'), true, "Sign In button must have d-none class when authenticated");

const emailBadge = getOrCreateElement('userAccountEmailBadge');
assert.strictEqual(emailBadge.innerText, "topgun", "Email badge must show username prefix");

const menuEmail = getOrCreateElement('userAccountMenuEmail');
assert.strictEqual(menuEmail.innerText, "topgun@example.com", "Menu must show full email address");

assert.strictEqual(mockWindow.ArtState.currentUser.id, "user_test_uuid_123", "ArtState.currentUser must be populated");
console.log("✅ Test 3 Passed: onAuthSuccess unlocks studio and populates navbar account details.");

// Test 4: Logging out returns to unauthenticated state
console.log("\n👉 Test 4: Logging out re-locks the studio...");
mockWindow.onAuthRequired();
assert.strictEqual(overlay.style.display, 'flex', "Overlay must reappear upon logout");
assert.strictEqual(mockWindow.ArtState.currentUser, null, "ArtState.currentUser must be cleared on logout");
console.log("✅ Test 4 Passed: Logging out re-activates auth gate and clears user state.");

// Test 5: Pilot Profile details populate navbar and profile modal
console.log("\n👉 Test 5: Pilot profile populates navbar badges and profile modal inputs...");
const pilotUser = {
    id: "user_pilot_456",
    email: "rv7pilot@example.com",
    pilotName: "Geoff Fahmy",
    tailNumber: "N890GF",
    homeAirport: "KSQL",
    aircraftType: "Van's RV-7",
    createdAt: "2026-02-01T12:00:00Z"
};
mockWindow.onAuthSuccess(pilotUser, false);

const pilotEmailBadge = getOrCreateElement('userAccountEmailBadge');
assert.strictEqual(pilotEmailBadge.innerText, "Geoff Fahmy", "Navbar badge should prioritize pilotName over email prefix");

const pilotMenuName = getOrCreateElement('userAccountMenuName');
assert.strictEqual(pilotMenuName.innerText, "Geoff Fahmy", "Dropdown name must display pilotName");

const aircraftBadge = getOrCreateElement('userAccountAircraftBadge');
const aircraftText = getOrCreateElement('userAccountAircraftText');
assert.strictEqual(aircraftBadge.classList.contains('d-none'), false, "Aircraft badge must be visible");
assert.strictEqual(aircraftText.innerText, "N890GF • Van's RV-7", "Aircraft text must combine tail and type");

const homeAptBadge = getOrCreateElement('userAccountHomeAirportBadge');
const homeAptText = getOrCreateElement('userAccountHomeAirportText');
assert.strictEqual(homeAptBadge.classList.contains('d-none'), false, "Home airport badge must be visible");
assert.strictEqual(homeAptText.innerText, "KSQL", "Home airport text must match profile");

// Verify modal population
mockWindow.populateProfileModal(pilotUser);
assert.strictEqual(getOrCreateElement('profilePilotNameInput').value, "Geoff Fahmy", "Modal pilot name input must be populated");
assert.strictEqual(getOrCreateElement('profileTailNumberInput').value, "N890GF", "Modal tail number input must be populated");
assert.strictEqual(getOrCreateElement('profileHomeAirportInput').value, "KSQL", "Modal home airport input must be populated");
assert.strictEqual(getOrCreateElement('profileAircraftTypeInput').value, "Van's RV-7", "Modal aircraft type input must be populated");

// Verify modal button states: first-time onboarding shows 'Skip for Now'
mockWindow.showPilotProfileModal(pilotUser, true);
assert.strictEqual(getOrCreateElement('profileDismissBtn').innerText, "Skip for Now", "First-time onboarding modal dismiss button must be 'Skip for Now'");
assert.strictEqual(getOrCreateElement('profileModalBadge').innerText, "Optional Details", "First-time onboarding badge must be 'Optional Details'");

// Verify modal button states: opened from navbar profile menu shows 'Cancel'
mockWindow.showPilotProfileModal(pilotUser, false);
assert.strictEqual(getOrCreateElement('profileDismissBtn').innerText, "Cancel", "Modal opened from navbar profile menu must have 'Cancel' button");
assert.strictEqual(getOrCreateElement('profileModalBadge').innerText, "Edit Details", "Navbar opened badge must be 'Edit Details'");

console.log("✅ Test 5 Passed: Pilot profile successfully populates navbar and modal form.");

// Test 6: Password Reset & Change UI Modal interactions
console.log("\n👉 Test 6: Password Reset & Change UI setup and modal toggles...");
mockWindow.setupPasswordResetUI();

const changePwBtn = getOrCreateElement('openChangePasswordModalBtn');
const forgotPwLink = getOrCreateElement('forgotPasswordLink');
const currPwGroup = getOrCreateElement('pwdCurrentPasswordGroup');
const emailGroup = getOrCreateElement('pwdEmailGroup');
const modalTitle = getOrCreateElement('passwordResetModalLabel');

// Clicking "Change Password" (logged in)
changePwBtn.dispatchEvent('click');
assert.strictEqual(modalTitle.innerText, "Change Password", "Title must be Change Password when opened from menu");
assert.strictEqual(currPwGroup.classList.contains('d-none'), false, "Current password input must be visible when logged in");
assert.strictEqual(emailGroup.classList.contains('d-none'), true, "Email input must be hidden when logged in");

// Clicking "Forgot Password" (logged out recovery)
forgotPwLink.dispatchEvent('click');
assert.strictEqual(modalTitle.innerText, "Reset Password", "Title must be Reset Password when clicked forgot password");
assert.strictEqual(currPwGroup.classList.contains('d-none'), true, "Current password input must be hidden for forgot password");
assert.strictEqual(emailGroup.classList.contains('d-none'), false, "Email input must be visible for forgot password");

// Password mismatch check
const newPwInput = getOrCreateElement('pwdNewPasswordInput');
const confirmPwInput = getOrCreateElement('pwdConfirmPasswordInput');
const mismatchAlert = getOrCreateElement('pwdMismatchAlert');

newPwInput.value = "ComplexPass123!";
newPwInput.dispatchEvent('input');
confirmPwInput.value = "DifferentPass456!";
confirmPwInput.dispatchEvent('input');
assert.strictEqual(mismatchAlert.classList.contains('d-none'), false, "Mismatch alert must show when passwords differ");

confirmPwInput.value = "ComplexPass123!";
confirmPwInput.dispatchEvent('input');
assert.strictEqual(mismatchAlert.classList.contains('d-none'), true, "Mismatch alert must hide when passwords match");

console.log("✅ Test 6 Passed: Password Reset and Change UI toggles between Logged-In and Forgot modes with live validation.");

// Test 7: Terms of Service registration checkbox & native dialog interactions
(async function runTermsTest() {
    console.log("\n👉 Test 7: Terms of Service registration checkbox & native dialog interactions...");
    // Drain any microtasks scheduled by earlier synchronous tests (e.g. onAuthSuccess .finally())
    await new Promise((resolve) => setTimeout(resolve, 20));

    mockWindow.setupAuthUI();
    mockWindow.setupTermsDialog();

    const tabSignInBtn = getOrCreateElement('tabSignInBtn');
    const tabRegisterBtn = getOrCreateElement('tabRegisterBtn');
    const authTermsGroup = getOrCreateElement('authTermsGroup');
    const authTermsCheck = getOrCreateElement('authTermsCheck');
    const authTermsError = getOrCreateElement('authTermsError');
    const authEmailInput = getOrCreateElement('authEmailInput');
    const authPasswordInput = getOrCreateElement('authPasswordInput');
    const authForm = getOrCreateElement('authForm');
    const termsDialog = getOrCreateElement('termsOfServiceDialog');
    const closeTermsDialogBtn = getOrCreateElement('closeTermsDialogBtn');

    // Initialize error/group classes matching DOM defaults
    authTermsGroup.classList.add('d-none');
    authTermsError.classList.add('d-none');

    // Switch to Create Account tab -> terms checkbox shown & required
    tabRegisterBtn.dispatchEvent('click');
    assert.strictEqual(authTermsGroup.classList.contains('d-none'), false, "Terms checkbox group must be visible in register mode");
    assert.strictEqual(authTermsCheck.required, true, "Terms checkbox must be required in register mode");

    // Switch back to Sign In tab -> terms checkbox hidden & not required
    tabSignInBtn.dispatchEvent('click');
    assert.strictEqual(authTermsGroup.classList.contains('d-none'), true, "Terms checkbox group must be hidden in login mode");
    assert.strictEqual(authTermsCheck.required, false, "Terms checkbox must not be required in login mode");

    // Switch back to Create Account and attempt submit without checking Terms
    tabRegisterBtn.dispatchEvent('click');
    authEmailInput.value = 'newpilot@example.com';
    authPasswordInput.value = 'StrongPass123!';
    authTermsCheck.checked = false;

    const authFetchUrls = [];
    const prevFetch = mockWindow.fetch;
    mockWindow.fetch = async (url) => {
        authFetchUrls.push(String(url));
        return { ok: true, json: async () => ({ authenticated: false }) };
    };

    await authForm.dispatchEvent('submit');
    mockWindow.fetch = prevFetch;

    assert.strictEqual(authFetchUrls.length, 0, "Registration form must not call fetch when Terms checkbox is unchecked");
    assert.strictEqual(authTermsError.classList.contains('d-none'), false, "Terms error message must be visible on unchecked submit");
    assert.strictEqual(authTermsCheck.getAttribute('aria-invalid'), 'true', "Terms checkbox must have aria-invalid='true' when validation fails");

    // Check Terms -> clears error and aria-invalid
    authTermsCheck.checked = true;
    authTermsCheck.dispatchEvent('change');
    assert.strictEqual(authTermsError.classList.contains('d-none'), true, "Terms error message must hide once Terms checkbox is checked");
    assert.strictEqual(authTermsCheck.getAttribute('aria-invalid'), null, "aria-invalid must be cleared once checked");

    // Open & close native Terms dialog
    mockWindow.openTermsDialog();
    assert.strictEqual(termsDialog.open, true, "openTermsDialog must open native termsOfServiceDialog");
    closeTermsDialogBtn.dispatchEvent('click');
    assert.strictEqual(termsDialog.open, false, "Clicking closeTermsDialogBtn must close termsOfServiceDialog");

    console.log("✅ Test 7 Passed: Terms of Service registration validation & native dialog controls work cleanly.");

    // Test 8: Privacy Policy native dialog controls & mutual exclusion with Terms dialog
    console.log("\n👉 Test 8: Privacy Policy native dialog controls & mutual exclusion...");
    mockWindow.setupPrivacyDialog();
    const privacyDialog = getOrCreateElement('privacyPolicyDialog');
    const closePrivacyDialogBtn = getOrCreateElement('closePrivacyDialogBtn');

    // Open Terms first, then switch to Privacy -> must close Terms before opening Privacy
    mockWindow.openTermsDialog();
    assert.strictEqual(termsDialog.open, true, "Terms dialog should open before switching");
    mockWindow.openPrivacyDialog();
    assert.strictEqual(termsDialog.open, false, "openPrivacyDialog must close an open Terms dialog to avoid stacked modals");
    assert.strictEqual(privacyDialog.open, true, "openPrivacyDialog must open native privacyPolicyDialog");

    privacyDialog.returnValue = 'stale';
    closePrivacyDialogBtn.dispatchEvent('click');
    assert.strictEqual(privacyDialog.open, false, "Clicking closePrivacyDialogBtn must close privacyPolicyDialog");
    assert.strictEqual(privacyDialog.returnValue, '', "Closing privacyPolicyDialog must reset stale returnValue");

    console.log("✅ Test 8 Passed: Privacy Policy native dialog closes Terms when switching and resets returnValue cleanly.");
    console.log("\n🎉 All Frontend Authentication & Profile UI tests PASSED successfully!\n");
})().catch((err) => {
    console.error("❌ Test 7 Failed:", err);
    process.exit(1);
});
