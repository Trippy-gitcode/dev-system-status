// docs/pwa/parent-child-chain.js
//
// P1-T2 / DA147-INF_P / TASK-DAIS-PHASE1-T2-PWS-PARENT-CHILD-CHAIN
// Parent-Child Chain visualization — vanilla JS, framework-free.
//
// Responsibilities:
//   1. Parse instructions/in_flight_topics.md (TASK detail blocks) and
//      instructions/session_progress.md (Mission Queue rows) to recover
//      {id, missionId, parentId, dependsOn, status, note} per task.
//   2. Build a forest from parent_id edges and decorate each node with its
//      depends_on list so the renderer can show dependency chains separately
//      from parent-child structure.
//   3. Detect dependency cycles via DFS and surface a visible warning.
//   4. Determine BLOCKED-cause: for each BLOCKED task, list the unsatisfied
//      depends_on tasks (= dependency status not in {DONE, LOCAL_DONE}).
//   5. Render a tree view (nested HTML lists) with status color classes
//      reused from the shared style.css scheme:
//        .status-queued / .status-in-progress / .status-local-done /
//        .status-done / .status-blocked / .status-completed / .status-unknown
//   6. Filter sub-tree by mission ID / task ID substring; mobile-friendly via
//      indented card stack on <=640px (CSS).
//   7. Auto-refresh on a tunable interval (default 30s).
//
// This module reads only static SSoT files; it does NOT mutate them.
// CommonJS export tail keeps the pure functions test-harness friendly so
// tests/test_p1_t2_pws_parent_child_chain.sh can drive node assertions.

'use strict';

// ────────────────────────────────────────────────────────────────────────────
// Tunables. Surface-level so reviewers + tests can find them quickly.
// ────────────────────────────────────────────────────────────────────────────

/** Refresh interval (ms). */
const REFRESH_MS = 30000;

/** Status -> CSS class mapping. */
const STATUS_CLASS = {
  'queued': 'status-queued',
  'QUEUED': 'status-queued',
  'in_progress': 'status-in-progress',
  'IN_PROGRESS': 'status-in-progress',
  'local_done': 'status-local-done',
  'LOCAL_DONE': 'status-local-done',
  'done': 'status-done',
  'DONE': 'status-done',
  'completed': 'status-completed',
  'COMPLETED': 'status-completed',
  'blocked': 'status-blocked',
  'BLOCKED': 'status-blocked',
};

/** "Done-ish" statuses — depends_on satisfied if dependency is in this set. */
const DONE_STATUSES = new Set(['done', 'DONE', 'local_done', 'LOCAL_DONE', 'completed', 'COMPLETED']);

/** Data sources (relative to docs/pwa/). */
const TASK_DETAIL_URL = '../../instructions/in_flight_topics.md';
const MISSION_QUEUE_URL = '../../instructions/session_progress.md';

/** A task ID looks like TASK-* — used to filter empty-string parent_id values. */
const TASK_ID_PATTERN = /^TASK-[A-Z0-9_-]+$/;

// ────────────────────────────────────────────────────────────────────────────
// Pure functions — testable without a DOM.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Pick a CSS class given a raw status string.
 * @param {string} status
 * @returns {string}
 */
function pickStatusColor(status) {
  if (!status) return 'status-unknown';
  return STATUS_CLASS[status] || STATUS_CLASS[status.toUpperCase()] || STATUS_CLASS[status.toLowerCase()] || 'status-unknown';
}

/**
 * Parse a list literal "[A, B, C]" or "[ ]" into an array of trimmed tokens.
 * Accepts comma-separated tokens with optional whitespace; ignores wrapping
 * brackets if present. Empty / null returns an empty array.
 *
 * @param {string} raw
 * @returns {string[]}
 */
function parseListField(raw) {
  if (!raw) return [];
  let s = String(raw).trim();
  if (s === '[]' || s === '[ ]' || s === 'null' || s === 'none' || s === 'None') return [];
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  if (!s.trim()) return [];
  return s.split(',').map((t) => t.trim()).filter((t) => t.length > 0);
}

/**
 * Parse a parent_id field. Accepts a single TASK-... id, "null", or "none".
 *
 * @param {string} raw
 * @returns {string|null}
 */
function parseParentField(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s || s === 'null' || s === 'None' || s === 'none' || s === '[]') return null;
  // Strip trailing punctuation common in detail rows.
  return s.replace(/[,;]+$/, '').trim() || null;
}

/**
 * Parse instructions/in_flight_topics.md text into an array of task records.
 * Each task block starts with a line of form:
 *   `### TASK-...: <title>`
 * and contains `- **<field>**: <value>` lines.
 *
 * Only fields {t_id, status, parent_id, depends_on, owner} are extracted.
 *
 * @param {string} text
 * @returns {Array<{id:string, title:string, missionId:string, parentId:string|null, dependsOn:string[], status:string, owner:string}>}
 */
function parseTaskDetail(text) {
  if (!text || typeof text !== 'string') return [];
  const lines = text.split(/\r?\n/);
  const tasks = [];
  let cur = null;

  const flush = () => {
    if (!cur) return;
    if (cur.id) tasks.push(cur);
    cur = null;
  };

  for (const line of lines) {
    const head = line.match(/^###\s+(TASK-[A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (head) {
      flush();
      cur = {
        id: head[1].trim(),
        title: (head[2] || '').trim(),
        missionId: '',
        parentId: null,
        dependsOn: [],
        status: '',
        owner: '',
      };
      continue;
    }
    if (!cur) continue;

    const field = line.match(/^-\s*\*\*([a-zA-Z0-9_]+)\*\*\s*:\s*(.*)$/);
    if (!field) continue;

    const key = field[1];
    const val = field[2].trim();
    switch (key) {
      case 't_id':
        cur.missionId = val;
        break;
      case 'status':
        cur.status = val;
        break;
      case 'parent_id':
        cur.parentId = parseParentField(val);
        // Only accept TASK-... pattern; treat strings that don't match as null.
        if (cur.parentId && !TASK_ID_PATTERN.test(cur.parentId)) {
          cur.parentId = null;
        }
        break;
      case 'depends_on':
        cur.dependsOn = parseListField(val).filter((t) => TASK_ID_PATTERN.test(t));
        break;
      case 'owner':
        cur.owner = val;
        break;
      default:
        break;
    }
  }
  flush();
  return tasks;
}

/**
 * Build a forest of {task, children[]} from a flat task array, using parent_id.
 * Tasks whose parent_id points to an unknown id are treated as roots.
 *
 * Children are sorted by id for deterministic rendering.
 *
 * @param {Array<{id:string, parentId:string|null}>} tasks
 * @returns {Array<{task:object, children:Array}>}
 */
function buildTree(tasks) {
  if (!Array.isArray(tasks)) return [];
  const byId = new Map();
  for (const t of tasks) {
    byId.set(t.id, { task: t, children: [] });
  }
  const roots = [];
  for (const t of tasks) {
    const node = byId.get(t.id);
    const pid = t.parentId;
    if (pid && byId.has(pid) && pid !== t.id) {
      byId.get(pid).children.push(node);
    } else {
      roots.push(node);
    }
  }
  const sortChildren = (n) => {
    n.children.sort((a, b) => (a.task.id < b.task.id ? -1 : a.task.id > b.task.id ? 1 : 0));
    n.children.forEach(sortChildren);
  };
  roots.sort((a, b) => (a.task.id < b.task.id ? -1 : a.task.id > b.task.id ? 1 : 0));
  roots.forEach(sortChildren);
  return roots;
}

/**
 * Detect cycles (parent + depends_on edges combined) using iterative DFS.
 * Returns an array of cycle paths. Each path is an array of task IDs whose
 * first and last id are equal (i.e. the closing edge).
 *
 * Cycles in parent_id alone OR depends_on alone OR a mix are all reported.
 *
 * @param {Array<{id:string, parentId:string|null, dependsOn:string[]}>} tasks
 * @returns {Array<string[]>}
 */
function detectCycles(tasks) {
  if (!Array.isArray(tasks)) return [];
  const adj = new Map();
  for (const t of tasks) adj.set(t.id, new Set());
  for (const t of tasks) {
    if (t.parentId && adj.has(t.parentId)) adj.get(t.id).add(t.parentId);
    for (const d of (t.dependsOn || [])) {
      if (adj.has(d)) adj.get(t.id).add(d);
    }
  }

  // DFS: track WHITE/GRAY/BLACK colors via state map; record back-edge cycles.
  const STATE = { WHITE: 0, GRAY: 1, BLACK: 2 };
  const state = new Map();
  for (const id of adj.keys()) state.set(id, STATE.WHITE);

  const cycles = [];
  const seenCycleKeys = new Set();

  for (const start of adj.keys()) {
    if (state.get(start) !== STATE.WHITE) continue;
    // Iterative DFS using explicit stack of {node, neighborsIter, path}
    const stack = [];
    const pathStack = [];
    stack.push({ id: start, iter: adj.get(start).values() });
    pathStack.push(start);
    state.set(start, STATE.GRAY);
    while (stack.length) {
      const top = stack[stack.length - 1];
      const next = top.iter.next();
      if (next.done) {
        state.set(top.id, STATE.BLACK);
        stack.pop();
        pathStack.pop();
        continue;
      }
      const nbr = next.value;
      const nbrState = state.get(nbr);
      if (nbrState === STATE.WHITE) {
        state.set(nbr, STATE.GRAY);
        stack.push({ id: nbr, iter: adj.get(nbr).values() });
        pathStack.push(nbr);
      } else if (nbrState === STATE.GRAY) {
        // Back-edge -> cycle.
        const idx = pathStack.indexOf(nbr);
        if (idx >= 0) {
          const cyc = pathStack.slice(idx).concat([nbr]);
          // Canonical key = rotation of the cycle's interior.
          const interior = cyc.slice(0, -1);
          const minIdx = interior.indexOf([...interior].sort()[0]);
          const rotated = interior.slice(minIdx).concat(interior.slice(0, minIdx));
          const key = rotated.join('->');
          if (!seenCycleKeys.has(key)) {
            seenCycleKeys.add(key);
            cycles.push(cyc.slice());
          }
        }
      }
      // BLACK -> already explored, skip.
    }
  }
  return cycles;
}

/**
 * For each task, compute a `blockReason` array: depends_on entries whose
 * dependency status is NOT in DONE_STATUSES (or whose dependency is missing).
 *
 * Tasks not in BLOCKED/blocked status still get a reason list when their
 * dependencies are unsatisfied — but the renderer will only highlight when
 * status === BLOCKED.
 *
 * @param {Array<{id:string, status:string, dependsOn:string[]}>} tasks
 * @returns {Map<string, string[]>}
 */
function computeBlockReasons(tasks) {
  const byId = new Map();
  for (const t of tasks) byId.set(t.id, t);
  const reasons = new Map();
  for (const t of tasks) {
    const unmet = [];
    for (const d of (t.dependsOn || [])) {
      const dep = byId.get(d);
      if (!dep) {
        unmet.push(d + ' (missing)');
      } else if (!DONE_STATUSES.has(dep.status)) {
        unmet.push(`${d} (status=${dep.status || '?'})`);
      }
    }
    if (unmet.length) reasons.set(t.id, unmet);
  }
  return reasons;
}

/**
 * Filter a forest to only the tasks (and their ancestors+descendants) matching
 * a query substring on id / missionId / title / status. Empty query keeps all.
 *
 * @param {Array<{task:object, children:Array}>} forest
 * @param {string} query
 * @returns {Array<{task:object, children:Array}>}
 */
function filterForest(forest, query) {
  const q = (query || '').trim().toLowerCase();
  if (!q) return forest;

  const matches = (node) => {
    const t = node.task;
    return `${t.id}\n${t.missionId}\n${t.title}\n${t.status}\n${t.owner}`.toLowerCase().includes(q);
  };

  const prune = (node) => {
    const filteredKids = node.children.map(prune).filter(Boolean);
    if (matches(node) || filteredKids.length) {
      return { task: node.task, children: filteredKids };
    }
    return null;
  };

  return forest.map(prune).filter(Boolean);
}

/**
 * Render a forest as nested HTML <ul><li> tree. Each <li> carries a
 * data-task-id attribute and the picked status class.
 *
 * @param {Array<{task:object, children:Array}>} forest
 * @param {Map<string, string[]>} blockReasons
 * @param {{cycleIds:Set<string>}} opts
 * @returns {string} HTML string
 */
function renderTree(forest, blockReasons, opts) {
  const cycleIds = (opts && opts.cycleIds) ? opts.cycleIds : new Set();

  const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));

  const renderNode = (node) => {
    const t = node.task;
    const klass = pickStatusColor(t.status);
    const inCycle = cycleIds.has(t.id);
    const liClasses = ['pcc-node', klass];
    if (inCycle) liClasses.push('pcc-in-cycle');
    if (t.status === 'BLOCKED' || t.status === 'blocked') liClasses.push('pcc-blocked');

    const reasons = blockReasons.get(t.id) || [];
    const showReasons = reasons.length > 0 && (t.status === 'BLOCKED' || t.status === 'blocked');

    let html = `<li class="${liClasses.join(' ')}" data-task-id="${escapeHtml(t.id)}" data-status="${escapeHtml(t.status)}">`;
    html += '<div class="pcc-row">';
    html += `<span class="pcc-status-badge ${klass}">${escapeHtml(t.status || '?')}</span>`;
    html += ` <span class="pcc-id">${escapeHtml(t.id)}</span>`;
    if (t.missionId) html += ` <span class="pcc-mission">${escapeHtml(t.missionId)}</span>`;
    if (t.title) html += ` <span class="pcc-title">${escapeHtml(t.title)}</span>`;
    if (inCycle) html += ' <span class="pcc-cycle-marker" aria-label="cycle warning">⚠ cycle</span>';
    html += '</div>';

    if (t.dependsOn && t.dependsOn.length) {
      html += '<div class="pcc-deps">depends_on: ';
      html += t.dependsOn.map((d) => `<span class="pcc-dep">${escapeHtml(d)}</span>`).join(', ');
      html += '</div>';
    }
    if (showReasons) {
      html += '<div class="pcc-block-reason">BLOCKED by: ';
      html += reasons.map((r) => `<span class="pcc-unmet">${escapeHtml(r)}</span>`).join(', ');
      html += '</div>';
    }
    if (node.children && node.children.length) {
      html += '<ul class="pcc-children">';
      for (const c of node.children) html += renderNode(c);
      html += '</ul>';
    }
    html += '</li>';
    return html;
  };

  if (!forest || !forest.length) {
    return '<ul class="pcc-tree"><li class="pcc-empty">該当 task なし。</li></ul>';
  }

  let out = '<ul class="pcc-tree">';
  for (const root of forest) out += renderNode(root);
  out += '</ul>';
  return out;
}

/**
 * Build a Set of all task IDs participating in any cycle.
 *
 * @param {Array<string[]>} cycles
 * @returns {Set<string>}
 */
function cyclesToIdSet(cycles) {
  const s = new Set();
  for (const c of (cycles || [])) for (const id of c) s.add(id);
  return s;
}

/**
 * Build a one-line warning summary for cycles.
 * @param {Array<string[]>} cycles
 * @returns {string}
 */
function buildCycleWarningText(cycles) {
  if (!cycles || !cycles.length) return '';
  const lines = cycles.map((c) => c.join(' -> '));
  return `循環依存検出 (${cycles.length} 件): ${lines.join(' / ')}`;
}

/**
 * High-level summary numbers for the panel.
 */
function summarize(tasks, cycles, blockReasons) {
  const summary = { total: 0, queued: 0, inProgress: 0, localDone: 0, done: 0, blocked: 0, cycles: 0, blockedWithCause: 0 };
  if (!Array.isArray(tasks)) return summary;
  summary.total = tasks.length;
  summary.cycles = (cycles || []).length;
  for (const t of tasks) {
    const k = pickStatusColor(t.status);
    if (k === 'status-queued') summary.queued += 1;
    else if (k === 'status-in-progress') summary.inProgress += 1;
    else if (k === 'status-local-done') summary.localDone += 1;
    else if (k === 'status-done' || k === 'status-completed') summary.done += 1;
    else if (k === 'status-blocked') {
      summary.blocked += 1;
      if ((blockReasons || new Map()).has(t.id)) summary.blockedWithCause += 1;
    }
  }
  return summary;
}

// ────────────────────────────────────────────────────────────────────────────
// Browser-only: DOM render + lifecycle.
// ────────────────────────────────────────────────────────────────────────────

function renderPanel(state, root) {
  const doc = root || (typeof document !== 'undefined' ? document : null);
  if (!doc) return;
  const treeRoot = doc.getElementById('pcc-tree-root');
  const cycleBar = doc.getElementById('pcc-cycle-warning');
  const status = doc.getElementById('pcc-status');
  if (!treeRoot) return;

  const cycleIds = cyclesToIdSet(state.cycles);
  treeRoot.innerHTML = renderTree(state.filteredForest, state.blockReasons, { cycleIds });

  if (cycleBar) {
    const txt = buildCycleWarningText(state.cycles);
    if (txt) {
      cycleBar.textContent = txt;
      cycleBar.hidden = false;
    } else {
      cycleBar.textContent = '';
      cycleBar.hidden = true;
    }
  }

  if (status) {
    if (state.errorMessage) {
      status.textContent = state.errorMessage;
      status.className = 'status-line error';
    } else {
      const s = state.summary;
      status.textContent = `${s.total} tasks · queued ${s.queued} · in_progress ${s.inProgress} · local_done ${s.localDone} · done ${s.done} · blocked ${s.blocked}` +
        (s.cycles > 0 ? ` · ⚠ ${s.cycles} cycles` : '');
      status.className = 'status-line ok';
    }
  }

  const kpi = (id, n) => {
    const el = doc.getElementById(id);
    if (el) el.textContent = String(n);
  };
  kpi('pcc-kpi-total', state.summary.total);
  kpi('pcc-kpi-queued', state.summary.queued);
  kpi('pcc-kpi-in-progress', state.summary.inProgress);
  kpi('pcc-kpi-blocked', state.summary.blocked);
  kpi('pcc-kpi-cycles', state.summary.cycles);
}

async function fetchText(url) {
  if (typeof fetch !== 'function') return null;
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return null;
    return await res.text();
  } catch (_) {
    return null;
  }
}

async function loadAndRender(state) {
  const text = await fetchText(TASK_DETAIL_URL);
  if (!text) {
    state.tasks = [];
    state.forest = [];
    state.filteredForest = [];
    state.cycles = [];
    state.blockReasons = new Map();
    state.summary = { total: 0, queued: 0, inProgress: 0, localDone: 0, done: 0, blocked: 0, cycles: 0, blockedWithCause: 0 };
    state.errorMessage = 'instructions/in_flight_topics.md を読み込めませんでした。';
    renderPanel(state);
    return;
  }
  state.tasks = parseTaskDetail(text);
  state.forest = buildTree(state.tasks);
  state.cycles = detectCycles(state.tasks);
  state.blockReasons = computeBlockReasons(state.tasks);
  state.summary = summarize(state.tasks, state.cycles, state.blockReasons);
  state.filteredForest = filterForest(state.forest, state.filterQuery);
  state.errorMessage = '';
  renderPanel(state);
}

function bindUi(state) {
  const doc = typeof document !== 'undefined' ? document : null;
  if (!doc) return;
  const filterInput = doc.getElementById('pcc-filter');
  const refreshBtn = doc.getElementById('pcc-refresh');
  if (filterInput) {
    filterInput.addEventListener('input', () => {
      state.filterQuery = filterInput.value || '';
      state.filteredForest = filterForest(state.forest, state.filterQuery);
      renderPanel(state);
    });
  }
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      loadAndRender(state).catch(() => {});
    });
  }
}

function start() {
  if (typeof document === 'undefined') return;
  const state = {
    tasks: [],
    forest: [],
    filteredForest: [],
    cycles: [],
    blockReasons: new Map(),
    summary: { total: 0, queued: 0, inProgress: 0, localDone: 0, done: 0, blocked: 0, cycles: 0, blockedWithCause: 0 },
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

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
}

// CommonJS export — tests/test_p1_t2_pws_parent_child_chain.sh node harness.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    REFRESH_MS,
    STATUS_CLASS,
    DONE_STATUSES,
    pickStatusColor,
    parseListField,
    parseParentField,
    parseTaskDetail,
    buildTree,
    detectCycles,
    computeBlockReasons,
    filterForest,
    renderTree,
    cyclesToIdSet,
    buildCycleWarningText,
    summarize,
  };
}
