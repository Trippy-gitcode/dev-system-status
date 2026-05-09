// docs/pwa/pr-integration.js
//
// P1-T4 / DA153-INF_P / TASK-DAIS-PHASE1-T4-PWS-PR-INTEGRATION
// GitHub PR integration view — vanilla JS, framework-free.
//
// Data flow:
//   scripts/devs_pr_list_export.sh fetches gh pr list -> docs/status/pr_list.json.
//   This module reads that file (no fetch -> GitHub) and renders cards grouped
//   by status: Open / Draft / CI fail / Merged. Each card links to the PR URL,
//   shows the resolved TASK-* + App task ID (from PR title / body / head_ref),
//   the CI status badge, and a stale-warning class once >STALE_DAYS days have
//   passed since the last PR update.
//
// Tested by tests/test_p1_t4_pws_pr_integration.sh (synthetic PR fixture).
//
// Pure additive: no edits to existing PWS pages besides adding a nav link.

'use strict';

// ────────────────────────────────────────────────────────────────────────────
// Tunables — surfaced at top so reviewers / tests can discover them quickly.
// ────────────────────────────────────────────────────────────────────────────

/** Refresh interval (ms). */
const REFRESH_MS = 60000;

/** Stale-PR threshold in days. Cards updated longer ago get the warning class. */
const STALE_DAYS = 7;

/** Status -> CSS class mapping for PR cards. */
const STATE_CLASS = {
  OPEN: 'pr-state-open',
  DRAFT: 'pr-state-draft',
  CI_FAIL: 'pr-state-ci-fail',
  MERGED: 'pr-state-merged',
  CLOSED: 'pr-state-closed',
};

/** CI state badge mapping. */
const CI_BADGE_CLASS = {
  SUCCESS: 'ci-badge-success',
  PENDING: 'ci-badge-pending',
  FAILURE: 'ci-badge-failure',
  null: 'ci-badge-unknown',
};

/** Data source path (relative to docs/pwa/). */
const PR_LIST_URL = '../status/pr_list.json';

/**
 * Regex pulled out so it's easy to spot-check / tune.
 * task_id_pattern matches Mais/Lais/Dais task IDs:
 *   (DA|LA|MA)\d{3}-(SPC|IMP|OPS|REV|FIX|DOC|INF)_[PC]
 * mission_pattern matches the long-form mission ID anchor:
 *   TASK-[A-Z0-9_-]+
 */
const TASK_ID_PATTERN = /(DA|LA|MA)\d{3}-(SPC|IMP|OPS|REV|FIX|DOC|INF)_[PC]/;
const MISSION_PATTERN = /TASK-[A-Z][A-Z0-9_-]+/;

// ────────────────────────────────────────────────────────────────────────────
// Pure functions — testable without a DOM.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Extract the App task ID (e.g. "DA146-INF_P") from arbitrary text. Search
 * order: explicit string -> head_ref -> title -> body. Empty if no match.
 *
 * @param {object|string} prOrText - either a PR object or a raw string.
 * @returns {string}
 */
function extractTaskId(prOrText) {
  let candidates;
  if (typeof prOrText === 'string') {
    candidates = [prOrText];
  } else if (prOrText && typeof prOrText === 'object') {
    candidates = [
      prOrText.task_id || '',
      prOrText.head_ref || '',
      prOrText.title || '',
      prOrText.body || '',
    ];
  } else {
    candidates = [];
  }
  for (const c of candidates) {
    if (!c) continue;
    const m = String(c).match(TASK_ID_PATTERN);
    if (m) return m[0];
  }
  return '';
}

/**
 * Extract the long-form mission ID (TASK-*) from arbitrary text. Search order:
 * explicit -> title -> body -> head_ref. Empty if no match.
 *
 * @param {object|string} prOrText
 * @returns {string}
 */
function extractMissionId(prOrText) {
  let candidates;
  if (typeof prOrText === 'string') {
    candidates = [prOrText];
  } else if (prOrText && typeof prOrText === 'object') {
    candidates = [
      prOrText.mission_id || '',
      prOrText.title || '',
      prOrText.body || '',
      prOrText.head_ref || '',
    ];
  } else {
    candidates = [];
  }
  for (const c of candidates) {
    if (!c) continue;
    const m = String(c).match(MISSION_PATTERN);
    if (m) return m[0];
  }
  return '';
}

/**
 * Classify a PR into one of: OPEN / DRAFT / CI_FAIL / MERGED / CLOSED.
 *
 * Order matters: a draft PR with a failing CI is still treated as DRAFT (so
 * humans review the draft state first). CI_FAIL is only surfaced for non-draft
 * open PRs.
 *
 * @param {object} pr - one entry from pr_list.json
 * @returns {"OPEN"|"DRAFT"|"CI_FAIL"|"MERGED"|"CLOSED"}
 */
function classifyState(pr) {
  if (!pr || typeof pr !== 'object') return 'OPEN';
  const state = String(pr.state || '').toUpperCase();
  if (state === 'MERGED') return 'MERGED';
  if (state === 'CLOSED') return 'CLOSED';
  if (pr.is_draft) return 'DRAFT';
  const ci = (pr.ci_state || null);
  if (ci === 'FAILURE') return 'CI_FAIL';
  return 'OPEN';
}

/**
 * Compute stale_days for a PR. Prefer the JSON-provided field; fall back to
 * recomputing from updated_at relative to a `now` reference (Date or epoch ms).
 *
 * @param {object} pr
 * @param {Date|number|undefined} now
 * @returns {number|null}
 */
function staleDays(pr, now) {
  if (!pr) return null;
  if (Number.isFinite(pr.stale_days)) return pr.stale_days;
  const iso = pr.updated_at || pr.merged_at || pr.created_at || '';
  if (!iso) return null;
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return null;
  const nowMs = now instanceof Date ? now.getTime() : (typeof now === 'number' ? now : Date.now());
  return Math.max(0, Math.floor((nowMs - ts) / 86400000));
}

/**
 * Sort PRs so the most urgent show first:
 *   1. CI failures (oldest stale first)
 *   2. Open PRs (oldest stale first)
 *   3. Drafts
 *   4. Merged (newest first)
 *   5. Closed
 */
function pickPriority(prs) {
  const order = { CI_FAIL: 0, OPEN: 1, DRAFT: 2, MERGED: 3, CLOSED: 4 };
  const annotated = (prs || []).map((pr) => ({
    pr,
    state: classifyState(pr),
    stale: staleDays(pr) || 0,
  }));
  annotated.sort((a, b) => {
    const oa = order[a.state] ?? 9;
    const ob = order[b.state] ?? 9;
    if (oa !== ob) return oa - ob;
    if (a.state === 'MERGED') {
      // Newest merge first.
      return (Date.parse(b.pr.merged_at || '') || 0) - (Date.parse(a.pr.merged_at || '') || 0);
    }
    return b.stale - a.stale;
  });
  return annotated.map((a) => a.pr);
}

/**
 * Apply substring filter across number / title / task_id / mission_id / head_ref.
 */
function filterPRs(prs, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return (prs || []).slice();
  return (prs || []).filter((pr) => {
    const haystack = [
      String(pr.number || ''),
      pr.title || '',
      pr.task_id || extractTaskId(pr),
      pr.mission_id || extractMissionId(pr),
      pr.head_ref || '',
    ].join('\n').toLowerCase();
    return haystack.includes(q);
  });
}

/**
 * Apply state-chip filter (All / Open / Draft / CI fail / Merged).
 *
 * @param {object[]} prs
 * @param {string} chip - one of "ALL" | "OPEN" | "DRAFT" | "CI_FAIL" | "MERGED"
 */
function filterByChip(prs, chip) {
  const c = String(chip || 'ALL').toUpperCase();
  if (c === 'ALL') return (prs || []).slice();
  return (prs || []).filter((pr) => classifyState(pr) === c);
}

/**
 * Compute summary KPIs for the header strip.
 */
function computeSummary(prs) {
  const summary = { total: 0, open: 0, draft: 0, ci_fail: 0, merged: 0, stale: 0 };
  for (const pr of (prs || [])) {
    summary.total += 1;
    const s = classifyState(pr);
    if (s === 'OPEN') summary.open += 1;
    else if (s === 'DRAFT') summary.draft += 1;
    else if (s === 'CI_FAIL') summary.ci_fail += 1;
    else if (s === 'MERGED') summary.merged += 1;
    const days = staleDays(pr);
    if (days !== null && days >= STALE_DAYS && s !== 'MERGED') summary.stale += 1;
  }
  return summary;
}

/**
 * Format a single PR object into a plain-DOM-flavoured object that the renderer
 * (or the test harness) can stringify deterministically.
 */
function formatPR(pr) {
  const state = classifyState(pr);
  const stateClass = STATE_CLASS[state] || 'pr-state-open';
  const stale = staleDays(pr);
  const isStale = stale !== null && stale >= STALE_DAYS && state !== 'MERGED';
  const taskId = pr.task_id || extractTaskId(pr);
  const missionId = pr.mission_id || extractMissionId(pr);
  const ciKey = pr.ci_state == null ? 'null' : String(pr.ci_state).toUpperCase();
  const ciClass = CI_BADGE_CLASS[ciKey] || CI_BADGE_CLASS.null;
  return {
    number: pr.number,
    title: pr.title || '',
    url: pr.url || '',
    state,
    stateClass,
    isStale,
    staleDays: stale,
    taskId,
    missionId,
    headRef: pr.head_ref || '',
    ciState: pr.ci_state || null,
    ciClass,
    isDraft: !!pr.is_draft,
    createdAt: pr.created_at || '',
    updatedAt: pr.updated_at || '',
    mergedAt: pr.merged_at || null,
  };
}

/**
 * Render PRs to a string of HTML. Pure (no DOM dependency); used by the renderer
 * + tests. The PWA uses createElement-driven rendering for the live page.
 *
 * @param {object[]} prs
 * @returns {string}
 */
function renderPRList(prs) {
  if (!prs || !prs.length) {
    return '<div class="pr-empty">PR は見つかりませんでした。</div>';
  }
  const cards = prs.map((pr) => {
    const f = formatPR(pr);
    const classes = ['pr-card', f.stateClass];
    if (f.isStale) classes.push('pr-stale-warning');
    const ciLabel = f.ciState || '—';
    const draftBadge = f.isDraft ? '<span class="pr-draft-badge">DRAFT</span>' : '';
    const taskBadge = f.taskId
      ? `<span class="pr-task-id">${escapeHtml(f.taskId)}</span>`
      : '<span class="pr-task-id pr-task-id-missing">no-task</span>';
    const missionBadge = f.missionId
      ? `<a class="pr-mission-id" href="../../instructions/in_flight_topics.md#${escapeHtml(f.missionId.toLowerCase())}">${escapeHtml(f.missionId)}</a>`
      : '';
    const staleNote = f.isStale
      ? `<span class="pr-stale-note">stale ${f.staleDays}d</span>`
      : '';
    const url = f.url || '#';
    return [
      `<article class="${classes.join(' ')}" data-pr-state="${f.state}" data-pr-number="${escapeHtml(String(f.number || ''))}">`,
        `<header class="pr-card-header">`,
          `<a class="pr-link" href="${escapeHtml(url)}" target="_blank" rel="noopener">#${escapeHtml(String(f.number || ''))}</a>`,
          `<span class="pr-state-label">${escapeHtml(f.state)}</span>`,
          draftBadge,
          `<span class="ci-badge ${f.ciClass}">CI: ${escapeHtml(ciLabel)}</span>`,
          staleNote,
        `</header>`,
        `<div class="pr-title">${escapeHtml(f.title)}</div>`,
        `<div class="pr-meta">`,
          taskBadge,
          missionBadge,
          `<span class="pr-head-ref">${escapeHtml(f.headRef)}</span>`,
        `</div>`,
      `</article>`,
    ].join('');
  });
  return cards.join('\n');
}

/**
 * Tiny HTML escape — matches the active-sessions.js style (textContent is
 * preferred for live DOM; this helper is for the string-rendering path used
 * by tests + the offline preview).
 */
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ────────────────────────────────────────────────────────────────────────────
// DOM rendering (browser-only). Skipped automatically in node test harness.
// ────────────────────────────────────────────────────────────────────────────

async function fetchPRJson(path) {
  const url = path || PR_LIST_URL;
  if (typeof fetch !== 'function') return null;
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) {
    return null;
  }
}

function renderToDom(state, root) {
  const doc = root || (typeof document !== 'undefined' ? document : null);
  if (!doc) return;
  const list = doc.getElementById('pr-list');
  const status = doc.getElementById('pr-status');
  const dupBar = doc.getElementById('pr-stale-warn');
  if (!list) return;

  list.textContent = '';

  const prs = state.filteredPRs;
  if (!prs.length) {
    const empty = doc.createElement('div');
    empty.className = 'pr-empty';
    empty.textContent = state.errorMessage || 'PR は見つかりませんでした。';
    list.appendChild(empty);
  } else {
    // Use innerHTML once because renderPRList already escapes user-supplied
    // strings. Tests cover the escape via #6 + #7.
    list.innerHTML = renderPRList(prs);
  }

  if (status) {
    if (state.errorMessage) {
      status.textContent = state.errorMessage;
      status.className = 'status-line error';
    } else {
      const s = state.summary;
      status.textContent = `${s.total} PR · open ${s.open} · draft ${s.draft} · ci-fail ${s.ci_fail} · merged ${s.merged}` +
        (s.stale > 0 ? ` · stale ${s.stale}` : '');
      status.className = 'status-line ok';
    }
  }
  if (dupBar) {
    if (state.summary.stale > 0) {
      dupBar.textContent = `stale 警告: ${state.summary.stale} 件 (>${STALE_DAYS}日 未更新)`;
      dupBar.hidden = false;
    } else {
      dupBar.hidden = true;
    }
  }

  const kpiTotal = doc.getElementById('pr-kpi-total');
  const kpiOpen = doc.getElementById('pr-kpi-open');
  const kpiDraft = doc.getElementById('pr-kpi-draft');
  const kpiFail = doc.getElementById('pr-kpi-ci-fail');
  const kpiMerged = doc.getElementById('pr-kpi-merged');
  const kpiStale = doc.getElementById('pr-kpi-stale');
  const s = state.summary;
  if (kpiTotal) kpiTotal.textContent = String(s.total);
  if (kpiOpen) kpiOpen.textContent = String(s.open);
  if (kpiDraft) kpiDraft.textContent = String(s.draft);
  if (kpiFail) kpiFail.textContent = String(s.ci_fail);
  if (kpiMerged) kpiMerged.textContent = String(s.merged);
  if (kpiStale) kpiStale.textContent = String(s.stale);
}

async function loadAndRender(state) {
  const data = await fetchPRJson(PR_LIST_URL);
  const allPRs = data && Array.isArray(data.prs) ? data.prs : [];
  state.allPRs = allPRs;
  if (!data) {
    state.errorMessage = 'docs/status/pr_list.json から PR を読み込めませんでした。 scripts/devs_pr_list_export.sh を実行してください。';
  } else {
    state.errorMessage = '';
  }
  state.summary = computeSummary(allPRs);
  const chipFiltered = filterByChip(allPRs, state.chipFilter);
  const textFiltered = filterPRs(chipFiltered, state.filterQuery);
  state.filteredPRs = pickPriority(textFiltered);
  renderToDom(state);
}

function bindUi(state) {
  const doc = typeof document !== 'undefined' ? document : null;
  if (!doc) return;
  const filterInput = doc.getElementById('pr-filter');
  const refreshBtn = doc.getElementById('pr-refresh');
  if (filterInput) {
    filterInput.addEventListener('input', () => {
      state.filterQuery = filterInput.value || '';
      const chipFiltered = filterByChip(state.allPRs, state.chipFilter);
      const textFiltered = filterPRs(chipFiltered, state.filterQuery);
      state.filteredPRs = pickPriority(textFiltered);
      renderToDom(state);
    });
  }
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      loadAndRender(state).catch(() => {});
    });
  }
  // Chip strip — buttons render in the HTML page; we attach delegated handler.
  const chipBar = doc.getElementById('pr-chip-bar');
  if (chipBar) {
    chipBar.addEventListener('click', (ev) => {
      const t = ev.target;
      if (!t || !t.matches || !t.matches('button[data-pr-chip]')) return;
      const next = String(t.getAttribute('data-pr-chip') || 'ALL').toUpperCase();
      state.chipFilter = next;
      const buttons = chipBar.querySelectorAll('button[data-pr-chip]');
      for (const b of buttons) {
        if (b === t) b.classList.add('active');
        else b.classList.remove('active');
      }
      const chipFiltered = filterByChip(state.allPRs, state.chipFilter);
      const textFiltered = filterPRs(chipFiltered, state.filterQuery);
      state.filteredPRs = pickPriority(textFiltered);
      renderToDom(state);
    });
  }
}

function startPRIntegration() {
  if (typeof document === 'undefined') return;
  const state = {
    allPRs: [],
    filteredPRs: [],
    summary: { total: 0, open: 0, draft: 0, ci_fail: 0, merged: 0, stale: 0 },
    chipFilter: 'ALL',
    filterQuery: '',
    errorMessage: '',
  };
  bindUi(state);
  loadAndRender(state).catch(() => {});
  if (typeof window !== 'undefined' && typeof window.setInterval === 'function') {
    window.setInterval(() => loadAndRender(state).catch(() => {}), REFRESH_MS);
  }
}

// Auto-start in browser context only.
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startPRIntegration);
  } else {
    startPRIntegration();
  }
}

// CommonJS export — used by tests/test_p1_t4_pws_pr_integration.sh node harness.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    REFRESH_MS,
    STALE_DAYS,
    STATE_CLASS,
    CI_BADGE_CLASS,
    TASK_ID_PATTERN,
    MISSION_PATTERN,
    extractTaskId,
    extractMissionId,
    classifyState,
    staleDays,
    pickPriority,
    filterPRs,
    filterByChip,
    computeSummary,
    formatPR,
    renderPRList,
    fetchPRJson,
    escapeHtml,
  };
}
