// docs/pwa/active-sessions.js
//
// P1-T1 / DA141-INF_P / TASK-DAIS-PHASE1-T1-PWS-ACTIVE-SESSIONS
// Active Sessions Panel — vanilla JS, framework-free.
//
// Responsibilities:
//   1. Read docs/status/agent_heartbeats.json + docs/status/agent_registry.json.
//   2. Render one row per agent with claim / branch / worktree / heartbeat freshness.
//   3. Color-code heartbeat age:
//        green  <  15 minutes (FRESH)
//        yellow 15-60 minutes (STALE)
//        red    >  60 minutes (DEAD)
//   4. Detect duplicate claims (same non-empty current_task_id held by >=2 agents)
//      and surface a warning row + summary KPI.
//   5. Search / filter by agent name, task id, or branch.
//   6. Mobile responsive — CSS handles the table -> stacked-card collapse @ 640px.
//   7. Auto-refresh at REFRESH_MS interval, no external network calls.
//
// Tested by tests/test_p1_t1_pws_active_sessions.sh (16 + 32 agent fixtures).

'use strict';

// ────────────────────────────────────────────────────────────────────────────
// Tunable constants. Surfaced at top so reviewers / tests can find them.
// ────────────────────────────────────────────────────────────────────────────
/** Refresh interval in ms. */
const REFRESH_MS = 30000;

/** Heartbeat age thresholds (seconds). */
const HEARTBEAT_FRESH_SEC = 15 * 60;   // <15 min  = fresh
const HEARTBEAT_STALE_SEC = 60 * 60;   // 15-60 min = stale, >60 min = dead

/** Color class names — matched by tests + style.css. */
const HEARTBEAT_CLASS_FRESH = 'hb-fresh';
const HEARTBEAT_CLASS_STALE = 'hb-stale';
const HEARTBEAT_CLASS_DEAD  = 'hb-dead';
const HEARTBEAT_CLASS_UNKNOWN = 'hb-unknown';

/** Data sources (relative to docs/pwa/). */
const HEARTBEATS_URL = '../status/agent_heartbeats.json';
const REGISTRY_URL   = '../status/agent_registry.json';

// ────────────────────────────────────────────────────────────────────────────
// Pure functions (testable without a DOM)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Compute the heartbeat freshness class given the heartbeat ISO string and a
 * reference "now" timestamp (Date or ms epoch).
 *
 * @param {string} isoHeartbeat - ISO-8601 string, e.g. "2026-05-09T07:35:14Z".
 * @param {Date|number|undefined} now - reference time, default = current time.
 * @returns {{ageSec: number|null, klass: string, label: string}}
 */
function classifyHeartbeatAge(isoHeartbeat, now) {
  if (!isoHeartbeat || typeof isoHeartbeat !== 'string') {
    return { ageSec: null, klass: HEARTBEAT_CLASS_UNKNOWN, label: '?' };
  }
  const ts = Date.parse(isoHeartbeat);
  if (!Number.isFinite(ts)) {
    return { ageSec: null, klass: HEARTBEAT_CLASS_UNKNOWN, label: '?' };
  }
  const nowMs = now instanceof Date ? now.getTime() : (typeof now === 'number' ? now : Date.now());
  const ageSec = Math.max(0, Math.floor((nowMs - ts) / 1000));
  let klass;
  if (ageSec < HEARTBEAT_FRESH_SEC) {
    klass = HEARTBEAT_CLASS_FRESH;
  } else if (ageSec < HEARTBEAT_STALE_SEC) {
    klass = HEARTBEAT_CLASS_STALE;
  } else {
    klass = HEARTBEAT_CLASS_DEAD;
  }
  return { ageSec, klass, label: humanizeAge(ageSec) };
}

/** Render an age in seconds as a short human label, e.g. "3m" / "1h12m" / "2d". */
function humanizeAge(ageSec) {
  if (ageSec === null || ageSec === undefined) return '?';
  if (ageSec < 60) return `${ageSec}s`;
  if (ageSec < 3600) {
    const m = Math.floor(ageSec / 60);
    const s = ageSec % 60;
    return s > 0 ? `${m}m${s}s` : `${m}m`;
  }
  if (ageSec < 86400) {
    const h = Math.floor(ageSec / 3600);
    const m = Math.floor((ageSec % 3600) / 60);
    return m > 0 ? `${h}h${m}m` : `${h}h`;
  }
  const d = Math.floor(ageSec / 86400);
  const h = Math.floor((ageSec % 86400) / 3600);
  return h > 0 ? `${d}d${h}h` : `${d}d`;
}

/**
 * Normalize the heartbeats JSON object into an array of session rows.
 *
 * heartbeats may be:
 *   - a flat object keyed by agent name (legacy schema, e.g. agent_heartbeats.json)
 *   - an object with `.agents` array (registry-shaped)
 *
 * @param {object|null|undefined} heartbeats
 * @returns {Array<{agent:string, branch:string, worktree:string, taskId:string, heartbeat:string, pid:number|null}>}
 */
function normalizeHeartbeats(heartbeats) {
  const rows = [];
  if (!heartbeats || typeof heartbeats !== 'object') return rows;

  if (Array.isArray(heartbeats.agents)) {
    for (const a of heartbeats.agents) {
      if (!a || typeof a !== 'object') continue;
      rows.push({
        agent: String(a.agent || a.name || '').trim() || '(unknown)',
        branch: String(a.branch || '').trim(),
        worktree: String(a.worktree_path || a.worktree || '').trim(),
        taskId: String(a.current_task_id || '').trim(),
        heartbeat: String(a.last_heartbeat || '').trim(),
        pid: Number.isFinite(a.agent_pid) ? a.agent_pid : null,
      });
    }
    return rows;
  }

  for (const [name, a] of Object.entries(heartbeats)) {
    if (!a || typeof a !== 'object') continue;
    rows.push({
      agent: String(name).trim() || '(unknown)',
      branch: String(a.branch || '').trim(),
      worktree: String(a.worktree_path || a.worktree || '').trim(),
      taskId: String(a.current_task_id || '').trim(),
      heartbeat: String(a.last_heartbeat || '').trim(),
      pid: Number.isFinite(a.agent_pid) ? a.agent_pid : null,
    });
  }
  return rows;
}

/**
 * Detect duplicate claims: same non-empty current_task_id held by >=2 sessions.
 * Returns a Map keyed by task_id whose value is an array of agent names sharing
 * that claim. Empty / missing task_ids are ignored.
 *
 * @param {Array<{agent:string, taskId:string}>} rows
 * @returns {Map<string, string[]>}
 */
function detectDuplicateClaims(rows) {
  const byTask = new Map();
  for (const r of rows) {
    const tid = (r.taskId || '').trim();
    if (!tid) continue;
    if (!byTask.has(tid)) byTask.set(tid, []);
    byTask.get(tid).push(r.agent);
  }
  const dup = new Map();
  for (const [tid, agents] of byTask.entries()) {
    if (agents.length >= 2) dup.set(tid, agents);
  }
  return dup;
}

/**
 * Build summary counts. Returns { total, fresh, stale, dead, dup }.
 */
function computeSummary(rows, dupMap, now) {
  const summary = { total: rows.length, fresh: 0, stale: 0, dead: 0, dup: 0 };
  for (const r of rows) {
    const c = classifyHeartbeatAge(r.heartbeat, now);
    if (c.klass === HEARTBEAT_CLASS_FRESH) summary.fresh += 1;
    else if (c.klass === HEARTBEAT_CLASS_STALE) summary.stale += 1;
    else if (c.klass === HEARTBEAT_CLASS_DEAD) summary.dead += 1;
  }
  if (dupMap && typeof dupMap.size === 'number') summary.dup = dupMap.size;
  return summary;
}

/**
 * Apply text filter to rows. Empty filter returns rows unchanged.
 */
function filterRows(rows, query) {
  const q = (query || '').trim().toLowerCase();
  if (!q) return rows.slice();
  return rows.filter((r) => {
    const haystack = `${r.agent}\n${r.taskId}\n${r.branch}\n${r.worktree}`.toLowerCase();
    return haystack.includes(q);
  });
}

// ────────────────────────────────────────────────────────────────────────────
// DOM rendering (browser-only). Skipped automatically in node test harness
// because there is no `document` global.
// ────────────────────────────────────────────────────────────────────────────

function renderActiveSessionsPanel(state, root) {
  const doc = root || (typeof document !== 'undefined' ? document : null);
  if (!doc) return;
  const tbody = doc.getElementById('active-sessions-tbody');
  const dupBar = doc.getElementById('active-sessions-dup-warning');
  const status = doc.getElementById('active-sessions-status');
  if (!tbody) return;

  // Reset
  tbody.textContent = '';

  const rows = state.filteredRows;
  if (!rows.length) {
    const tr = doc.createElement('tr');
    const td = doc.createElement('td');
    td.colSpan = 6;
    td.className = 'active-sessions-empty';
    td.textContent = state.errorMessage || 'active session なし。';
    tr.appendChild(td);
    tbody.appendChild(tr);
  } else {
    for (const r of rows) {
      const c = classifyHeartbeatAge(r.heartbeat, state.now);
      const tr = doc.createElement('tr');
      tr.className = `active-session-row ${c.klass}`;
      tr.setAttribute('data-agent-row', r.agent);
      if (state.duplicateClaims.has(r.taskId) && r.taskId) {
        tr.classList.add('row-dup');
      }

      const tdAgent = doc.createElement('td');
      tdAgent.className = 'cell-agent';
      tdAgent.setAttribute('data-label', 'agent');
      const dot = doc.createElement('span');
      dot.className = `dot ${c.klass.replace('hb-', 'dot-')}`;
      dot.setAttribute('aria-hidden', 'true');
      tdAgent.appendChild(dot);
      tdAgent.appendChild(doc.createTextNode(' '));
      tdAgent.appendChild(doc.createTextNode(r.agent));
      tr.appendChild(tdAgent);

      const tdTask = doc.createElement('td');
      tdTask.className = 'cell-task';
      tdTask.setAttribute('data-label', 'claim');
      tdTask.textContent = r.taskId || '(idle)';
      tr.appendChild(tdTask);

      const tdBranch = doc.createElement('td');
      tdBranch.className = 'cell-branch';
      tdBranch.setAttribute('data-label', 'branch');
      tdBranch.textContent = r.branch || '(no branch)';
      tr.appendChild(tdBranch);

      const tdWorktree = doc.createElement('td');
      tdWorktree.className = 'cell-worktree';
      tdWorktree.setAttribute('data-label', 'worktree');
      tdWorktree.textContent = r.worktree || '(no worktree)';
      tr.appendChild(tdWorktree);

      const tdHb = doc.createElement('td');
      tdHb.className = 'cell-hb';
      tdHb.setAttribute('data-label', 'heartbeat');
      tdHb.textContent = r.heartbeat || '?';
      tr.appendChild(tdHb);

      const tdAge = doc.createElement('td');
      tdAge.className = 'cell-age';
      tdAge.setAttribute('data-label', 'age');
      tdAge.textContent = c.label;
      tr.appendChild(tdAge);

      tbody.appendChild(tr);
    }
  }

  if (dupBar) {
    if (state.duplicateClaims.size > 0) {
      const lines = [];
      for (const [tid, agents] of state.duplicateClaims.entries()) {
        lines.push(`${tid}: ${agents.join(', ')}`);
      }
      dupBar.textContent = `重複 claim 検出: ${state.duplicateClaims.size} task — ${lines.join(' / ')}`;
      dupBar.hidden = false;
    } else {
      dupBar.textContent = '';
      dupBar.hidden = true;
    }
  }

  if (status) {
    if (state.errorMessage) {
      status.textContent = state.errorMessage;
      status.className = 'status-line error';
    } else {
      status.textContent = `${state.summary.total} sessions · fresh ${state.summary.fresh} · stale ${state.summary.stale} · dead ${state.summary.dead}` +
        (state.summary.dup > 0 ? ` · dup ${state.summary.dup}` : '');
      status.className = 'status-line ok';
    }
  }

  const kpiTotal = doc.getElementById('active-sessions-kpi-total');
  const kpiFresh = doc.getElementById('active-sessions-kpi-fresh');
  const kpiStale = doc.getElementById('active-sessions-kpi-stale');
  const kpiDead  = doc.getElementById('active-sessions-kpi-dead');
  const kpiDup   = doc.getElementById('active-sessions-kpi-dup');
  if (kpiTotal) kpiTotal.textContent = String(state.summary.total);
  if (kpiFresh) kpiFresh.textContent = String(state.summary.fresh);
  if (kpiStale) kpiStale.textContent = String(state.summary.stale);
  if (kpiDead)  kpiDead.textContent  = String(state.summary.dead);
  if (kpiDup)   kpiDup.textContent   = String(state.summary.dup);
}

// ────────────────────────────────────────────────────────────────────────────
// Loader / lifecycle (browser-only)
// ────────────────────────────────────────────────────────────────────────────

async function fetchJson(url) {
  if (typeof fetch !== 'function') return null;
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) {
    return null;
  }
}

/**
 * Apply the P1-T3 app prefix filter on top of the existing text filter.
 * Pure helper — kept here so test harness can import it via require().
 */
function applyAppPrefixFilter(rows) {
  if (typeof window === 'undefined' || !window.PwsAppFilter) return rows;
  try {
    const app = window.PwsAppFilter.getActiveApp();
    return window.PwsAppFilter.applyFilter(rows, app);
  } catch (_) {
    return rows;
  }
}

async function loadAndRender(state) {
  const heartbeats = await fetchJson(HEARTBEATS_URL);
  const registry = await fetchJson(REGISTRY_URL);
  let rows = normalizeHeartbeats(heartbeats || registry);
  if ((!rows || !rows.length) && registry) {
    rows = normalizeHeartbeats(registry);
  }

  if (!rows || !rows.length) {
    state.allRows = [];
    state.filteredRows = [];
    state.duplicateClaims = new Map();
    state.summary = { total: 0, fresh: 0, stale: 0, dead: 0, dup: 0 };
    state.errorMessage = 'agent_heartbeats.json / agent_registry.json から session を読み込めませんでした。';
  } else {
    state.allRows = rows;
    state.duplicateClaims = detectDuplicateClaims(rows);
    state.now = new Date();
    state.summary = computeSummary(rows, state.duplicateClaims, state.now);
    // P1-T3: app prefix filter -> text filter (chained, both pure).
    const appFiltered = applyAppPrefixFilter(rows);
    state.filteredRows = filterRows(appFiltered, state.filterQuery);
    state.errorMessage = '';
  }

  renderActiveSessionsPanel(state);
}

function bindUi(state) {
  const doc = typeof document !== 'undefined' ? document : null;
  if (!doc) return;
  const filterInput = doc.getElementById('active-sessions-filter');
  const refreshBtn = doc.getElementById('active-sessions-refresh');
  if (filterInput) {
    filterInput.addEventListener('input', () => {
      state.filterQuery = filterInput.value || '';
      const appFiltered = applyAppPrefixFilter(state.allRows);
      state.filteredRows = filterRows(appFiltered, state.filterQuery);
      state.summary = computeSummary(state.allRows, state.duplicateClaims, state.now);
      renderActiveSessionsPanel(state);
    });
  }
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      loadAndRender(state).catch(() => {});
    });
  }

  // P1-T3: app filter chip strip.
  if (typeof window !== 'undefined' && window.PwsAppFilter) {
    try {
      window.PwsAppFilter.ensureFilterChipBar({
        containerId: 'active-sessions-app-filter',
        mainSelector: '.active-sessions-main',
        onChange: (app) => {
          window.PwsAppFilter.setActiveApp(app);
          // Re-render chips so the active highlight follows the click.
          window.PwsAppFilter.renderFilterChips(
            'active-sessions-app-filter',
            window.PwsAppFilter.getActiveApp(),
            (a) => {
              window.PwsAppFilter.setActiveApp(a);
              const filtered = applyAppPrefixFilter(state.allRows);
              state.filteredRows = filterRows(filtered, state.filterQuery);
              renderActiveSessionsPanel(state);
              window.PwsAppFilter.renderFilterChips(
                'active-sessions-app-filter',
                window.PwsAppFilter.getActiveApp(),
                () => {}
              );
            }
          );
          const filtered = applyAppPrefixFilter(state.allRows);
          state.filteredRows = filterRows(filtered, state.filterQuery);
          renderActiveSessionsPanel(state);
        },
      });
    } catch (_) { /* swallow; chips are progressive enhancement */ }
  }
}

function startActiveSessions() {
  if (typeof document === 'undefined') return;
  const state = {
    allRows: [],
    filteredRows: [],
    duplicateClaims: new Map(),
    summary: { total: 0, fresh: 0, stale: 0, dead: 0, dup: 0 },
    now: new Date(),
    filterQuery: '',
    errorMessage: '',
  };
  bindUi(state);
  loadAndRender(state).catch(() => {});
  if (typeof window !== 'undefined' && typeof window.setInterval === 'function') {
    window.setInterval(() => {
      loadAndRender(state).catch(() => {});
    }, REFRESH_MS);
  }
}

// Auto-start in browser context only.
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startActiveSessions);
  } else {
    startActiveSessions();
  }
}

// CommonJS export — used by tests/test_p1_t1_pws_active_sessions.sh node harness.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    REFRESH_MS,
    HEARTBEAT_FRESH_SEC,
    HEARTBEAT_STALE_SEC,
    HEARTBEAT_CLASS_FRESH,
    HEARTBEAT_CLASS_STALE,
    HEARTBEAT_CLASS_DEAD,
    HEARTBEAT_CLASS_UNKNOWN,
    classifyHeartbeatAge,
    humanizeAge,
    normalizeHeartbeats,
    detectDuplicateClaims,
    computeSummary,
    filterRows,
  };
}
