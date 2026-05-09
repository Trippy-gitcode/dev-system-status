// docs/pwa/app-filter.js
//
// P1-T3 / DA150-INF_P / TASK-DAIS-PHASE1-T3-PWS-APP-FILTER
// Shared "app prefix" filter module for the Dais Supervisor PWA pages
// (active-sessions.html / parent-child-chain.html / index.html).
//
// Responsibilities:
//   1. Surface a single configured list of apps (DA / LA / MA, extensible).
//      Adding a new app = adding one entry to APPS below.  No UI change required.
//   2. Read / write the active app via:
//        - URL query parameter (`?app=DA`)         (primary; shareable / deep-link)
//        - localStorage fallback                   (persists across reloads when URL lacks a value)
//      The "all apps" sentinel is `'*'` and is the default when neither store has a value.
//   3. Provide a pure `applyFilter(rows, app)` that filters task / agent / row
//      records by app prefix.  Cross-app rows (rows whose `target_repos`,
//      `apps`, or `note` references multiple apps) are kept under EVERY filter
//      view so PO never loses sight of cross-cutting work.
//   4. Render minimal DOM filter chips (vanilla, framework-free) with active
//      highlight.  Click handlers update both URL state and localStorage,
//      then invoke the registered re-render callback.
//   5. Mobile-friendly: chips wrap onto two rows below 640px (CSS responsibility).
//
// Pure functions are exported via CommonJS for tests/test_p1_t3_pws_app_filter.sh.
// Browser globals (window / document / history / localStorage) are used only
// inside DOM helpers, which guard for `typeof === 'undefined'`.

'use strict';

// ────────────────────────────────────────────────────────────────────────────
// CONFIG: single source of truth for the supported app prefix list.
// New apps need only be appended here.  Order = display order in chips.
// ────────────────────────────────────────────────────────────────────────────
const APPS = ['DA', 'LA', 'MA'];

/** "All apps" sentinel.  `getActiveApp()` defaults to this when no preference is set. */
const ALL_APPS = '*';

/** URL query parameter name. */
const URL_PARAM = 'app';

/** localStorage key. */
const LS_KEY = 'dais_pws_active_app';

/** Display labels per app prefix.  Falls back to the prefix itself. */
const APP_LABELS = {
  '*': 'すべて',
  DA: 'DA',
  LA: 'LA',
  MA: 'MA',
};

// ────────────────────────────────────────────────────────────────────────────
// Pure helpers — testable without a DOM.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Return true if `value` is a recognised app prefix or the all-apps sentinel.
 * @param {string} value
 * @returns {boolean}
 */
function isKnownApp(value) {
  if (value === ALL_APPS) return true;
  if (typeof value !== 'string') return false;
  return APPS.indexOf(value) >= 0;
}

/**
 * Extract an app prefix from a row record.  Tries (in order):
 *   1. row.app (explicit)
 *   2. first 2 chars of row.taskId / row.id / row.missionId / row.t_id
 *   3. agent name pattern (e.g. "DA-foo-bar" → "DA")
 *   4. "branch" string (e.g. "claude/DA141-INF_P/foo" → "DA")
 *
 * Empty / unknown returns ''.
 *
 * @param {object} row
 * @returns {string}
 */
function extractAppPrefix(row) {
  if (!row || typeof row !== 'object') return '';
  if (typeof row.app === 'string' && isKnownApp(row.app) && row.app !== ALL_APPS) {
    return row.app;
  }
  const candidates = [
    row.taskId, row.task_id, row.id, row.missionId, row.mission_id, row.t_id,
    row.agent, row.name, row.branch, row.worktree, row.worktree_path,
  ];
  for (const c of candidates) {
    if (typeof c !== 'string' || !c) continue;
    // Look for any known prefix as a token boundary (start of string, slash,
    // dash, underscore).  This avoids matching "DA" inside an unrelated word.
    for (const p of APPS) {
      const re = new RegExp(`(?:^|[/_\\-])${p}(?=[0-9_\\-]|$)`);
      if (re.test(c)) return p;
    }
  }
  return '';
}

/**
 * Collect every app prefix referenced anywhere in a row.  Useful for cross-app
 * rows (e.g. tasks whose `target_repos` field contains "[dais, lais]").
 *
 * Recognises:
 *   - row.target_repos / row.targets / row.apps  (array or comma string)
 *   - row.note / row.title / row.description containing "DA / LA" tokens
 *
 * @param {object} row
 * @returns {string[]} sorted, deduplicated app prefixes (excluding ALL_APPS sentinel)
 */
function collectAppPrefixes(row) {
  const found = new Set();
  if (!row || typeof row !== 'object') return [];

  const primary = extractAppPrefix(row);
  if (primary) found.add(primary);

  const fields = [];
  if (Array.isArray(row.target_repos)) fields.push(row.target_repos.join(','));
  if (Array.isArray(row.targets)) fields.push(row.targets.join(','));
  if (Array.isArray(row.apps)) fields.push(row.apps.join(','));
  if (typeof row.target_repos === 'string') fields.push(row.target_repos);
  if (typeof row.targets === 'string') fields.push(row.targets);
  if (typeof row.apps === 'string') fields.push(row.apps);
  if (typeof row.note === 'string') fields.push(row.note);
  if (typeof row.title === 'string') fields.push(row.title);
  if (typeof row.description === 'string') fields.push(row.description);

  for (const blob of fields) {
    if (!blob) continue;
    for (const p of APPS) {
      const re = new RegExp(`(?:^|[/_\\-,\\s])${p}(?=[0-9_\\-,\\s]|$)`);
      if (re.test(blob)) found.add(p);
      // Also catch lowercase canonical names like "dais"/"lais"/"mais".
      const canonRe = new RegExp(`\\b${p[0].toLowerCase()}ais\\b`, 'i');
      if (canonRe.test(blob)) found.add(p);
    }
  }
  return Array.from(found).sort();
}

/**
 * Apply the configured filter to an array of rows.
 *
 *   app === ALL_APPS (`'*'`)   → all rows pass through
 *   app === 'DA' / 'LA' / 'MA' → row passes when:
 *       - extractAppPrefix(row) === app, OR
 *       - collectAppPrefixes(row) contains BOTH `app` and at least one other
 *         app (= cross-app row; preserved across all filter views).
 *
 * Rows with no detectable app prefix are kept under ALL_APPS only.
 *
 * @param {Array<object>} rows
 * @param {string} app  — recognised app prefix or ALL_APPS
 * @returns {Array<object>}
 */
function applyFilter(rows, app) {
  if (!Array.isArray(rows)) return [];
  const target = isKnownApp(app) ? app : ALL_APPS;
  if (target === ALL_APPS) return rows.slice();

  return rows.filter((row) => {
    const primary = extractAppPrefix(row);
    if (primary === target) return true;
    const all = collectAppPrefixes(row);
    if (all.length >= 2 && all.indexOf(target) >= 0) return true;
    return false;
  });
}

/**
 * Decide the canonical "active app" using:
 *   1. URL search string (`?app=DA`)
 *   2. localStorage fallback
 *   3. ALL_APPS default
 *
 * Both inputs are sanitised: unknown values fall back to ALL_APPS.
 *
 * @param {object} [opts]
 * @param {string} [opts.search]  - explicit search string for tests (default: window.location.search)
 * @param {object} [opts.storage] - explicit Storage-like object for tests (default: window.localStorage)
 * @returns {string}
 */
function getActiveApp(opts) {
  const o = opts || {};
  let urlSearch = o.search;
  if (urlSearch === undefined && typeof window !== 'undefined' && window.location) {
    urlSearch = window.location.search;
  }
  if (typeof urlSearch === 'string' && urlSearch.length > 0) {
    const m = urlSearch.match(/[?&]app=([^&]*)/);
    if (m && m[1]) {
      const decoded = decodeURIComponent(m[1]).toUpperCase();
      if (isKnownApp(decoded)) return decoded;
      if (decoded === 'ALL' || decoded === '*') return ALL_APPS;
    }
  }

  let storage = o.storage;
  if (storage === undefined && typeof window !== 'undefined') {
    try { storage = window.localStorage; } catch (_) { storage = null; }
  }
  if (storage && typeof storage.getItem === 'function') {
    try {
      const v = storage.getItem(LS_KEY);
      if (v && isKnownApp(v)) return v;
    } catch (_) { /* swallow */ }
  }
  return ALL_APPS;
}

/**
 * Persist the active app:
 *   - mirror to URL `?app=...` via history.replaceState (no reload)
 *   - mirror to localStorage[LS_KEY]
 *
 * Pure-test entry points (no window) accept opts.url / opts.storage.
 *
 * @param {string} app
 * @param {object} [opts]
 * @param {URL}    [opts.url]      explicit URL object for tests
 * @param {object} [opts.storage]  explicit Storage-like for tests
 * @returns {string} the canonicalised app value actually persisted
 */
function setActiveApp(app, opts) {
  const o = opts || {};
  const target = isKnownApp(app) ? app : ALL_APPS;

  // URL state.
  if (typeof window !== 'undefined' && window.history && window.location) {
    try {
      const u = new URL(window.location.href);
      if (target === ALL_APPS) u.searchParams.delete(URL_PARAM);
      else u.searchParams.set(URL_PARAM, target);
      window.history.replaceState({}, '', u.toString());
    } catch (_) { /* swallow */ }
  } else if (o.url && o.url.searchParams) {
    if (target === ALL_APPS) o.url.searchParams.delete(URL_PARAM);
    else o.url.searchParams.set(URL_PARAM, target);
  }

  // localStorage state.
  let storage = o.storage;
  if (storage === undefined && typeof window !== 'undefined') {
    try { storage = window.localStorage; } catch (_) { storage = null; }
  }
  if (storage && typeof storage.setItem === 'function') {
    try {
      if (target === ALL_APPS) storage.removeItem(LS_KEY);
      else storage.setItem(LS_KEY, target);
    } catch (_) { /* swallow */ }
  }

  return target;
}

// ────────────────────────────────────────────────────────────────────────────
// DOM rendering — browser-only.  Skipped automatically when `document` is absent
// (e.g. inside the node test harness).
// ────────────────────────────────────────────────────────────────────────────

/**
 * Render the filter chip strip into `container`.
 *
 * @param {HTMLElement|string} container - element OR id of the host node
 * @param {string} currentApp            - currently active app
 * @param {function(string):void} onChange - chip click callback (receives the chosen app)
 * @param {object} [opts]
 * @param {string[]} [opts.apps]         - override APPS for tests
 * @returns {HTMLElement|null}
 */
function renderFilterChips(container, currentApp, onChange, opts) {
  if (typeof document === 'undefined') return null;
  const host = (typeof container === 'string')
    ? document.getElementById(container)
    : container;
  if (!host) return null;
  const apps = (opts && Array.isArray(opts.apps)) ? opts.apps : APPS;
  const active = isKnownApp(currentApp) ? currentApp : ALL_APPS;

  // Reset.
  host.textContent = '';
  host.classList.add('app-filter');
  host.setAttribute('role', 'tablist');
  host.setAttribute('aria-label', 'app filter');

  const makeChip = (value, label) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'app-filter-chip';
    btn.setAttribute('role', 'tab');
    btn.setAttribute('data-app', value);
    btn.setAttribute('aria-selected', value === active ? 'true' : 'false');
    if (value === active) btn.classList.add('active');
    btn.textContent = label;
    btn.addEventListener('click', () => {
      if (typeof onChange === 'function') onChange(value);
    });
    return btn;
  };

  host.appendChild(makeChip(ALL_APPS, APP_LABELS[ALL_APPS] || 'すべて'));
  for (const a of apps) {
    host.appendChild(makeChip(a, APP_LABELS[a] || a));
  }
  return host;
}

/**
 * Convenience: locate (or create-if-missing) a chip container at the very top
 * of <main> on a PWS page, then render chips into it and wire the change
 * handler.  Used by active-sessions.js / parent-child-chain.js / index.html.
 *
 * @param {object} cfg
 * @param {string} cfg.containerId - desired id for the chip host
 * @param {string} [cfg.mainSelector] - selector for the parent (default: 'main')
 * @param {function(string):void} cfg.onChange
 * @returns {{host:HTMLElement|null, current:string}}
 */
function ensureFilterChipBar(cfg) {
  if (typeof document === 'undefined') return { host: null, current: ALL_APPS };
  const containerId = cfg.containerId || 'pws-app-filter';
  const mainSelector = cfg.mainSelector || 'main';

  let host = document.getElementById(containerId);
  if (!host) {
    const main = document.querySelector(mainSelector);
    if (!main) return { host: null, current: getActiveApp() };
    host = document.createElement('div');
    host.id = containerId;
    host.className = 'app-filter';
    main.insertBefore(host, main.firstChild);
  }

  const current = getActiveApp();
  renderFilterChips(host, current, cfg.onChange);
  return { host, current };
}

// ────────────────────────────────────────────────────────────────────────────
// Browser auto-init: expose a global namespace so the per-page JS files can
// pick the helpers up without an ES module bundler.
// ────────────────────────────────────────────────────────────────────────────
if (typeof window !== 'undefined') {
  window.PwsAppFilter = {
    APPS,
    ALL_APPS,
    APP_LABELS,
    URL_PARAM,
    LS_KEY,
    isKnownApp,
    extractAppPrefix,
    collectAppPrefixes,
    applyFilter,
    getActiveApp,
    setActiveApp,
    renderFilterChips,
    ensureFilterChipBar,
  };
}

// CommonJS export — used by tests/test_p1_t3_pws_app_filter.sh node harness.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    APPS,
    ALL_APPS,
    APP_LABELS,
    URL_PARAM,
    LS_KEY,
    isKnownApp,
    extractAppPrefix,
    collectAppPrefixes,
    applyFilter,
    getActiveApp,
    setActiveApp,
    renderFilterChips,
    ensureFilterChipBar,
  };
}
