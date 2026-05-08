/* Dais Supervisor PWA — main app logic.
 * T117 / TASK-DAIS-PWA-IPHONE-AGENT-DASHBOARD
 * brief v1 §1.1-§1.5 = Active Agent Registry / 手動アサイン待ち / タップアサイン /
 * 自動 pickup ルール / 緊急通知 を 1:1 実装。
 *
 * 注意: PWA は SSoT (Mission Queue / po_inbox) に直接書込まない。
 * 「タップアサイン」 は po_inbox 形式の prefill payload を生成し、 PO が copy →
 * chat / GitHub Issue に貼付する経路で SSoT 化する (= scripts/devs_po_inbox_intake.sh
 * は ADV/Codex 側で claim/convert を実行)。
 */

(function () {
  'use strict';

  // ─── 設定 (T125 dual-mode path 検出) ───────────────────────────────
  // PWA は 3 つの mode で動作:
  //   (a) dev-system local (docs/pwa/index.html) → JSON は ../status/
  //   (b) published root    (https://.../dev-system-status/) → JSON は ./status/
  //   (c) published /pwa/   (https://.../dev-system-status/pwa/) → JSON は ../status/
  // pwaBase() = PWA shell の現在 directory、 statusBase() = JSON 取得 base
  // PO 直命 2026-05-08「PWA URL 1 本化、 ダブルメンテ回避」 反映 (T125)。
  function pwaBase() {
    var p = window.location.pathname || '/';
    p = p.replace(/index\.html$/, '');
    if (p.charAt(p.length - 1) !== '/') p += '/';
    return p;
  }

  function statusBase() {
    // pwaBase 末尾 /pwa/ なら ../status/、 それ以外 (root / local docs/pwa/) は隣接 status/
    var pb = pwaBase();
    if (/\/pwa\/$/.test(pb)) {
      return pb.replace(/pwa\/$/, 'status/');
    }
    // dev-system local は docs/pwa/ なので ../status/ を使う
    if (/\/docs\/pwa\/$/.test(pb)) {
      return pb.replace(/pwa\/$/, 'status/');
    }
    // published root: ./status/
    return pb + 'status/';
  }

  function tProgressUrl() {
    var pb = pwaBase();
    if (/\/pwa\/$/.test(pb)) {
      return pb.replace(/pwa\/$/, 't_progress.html');
    }
    if (/\/docs\/pwa\/$/.test(pb)) {
      return pb.replace(/pwa\/$/, 't_progress.html');
    }
    return pb + 't_progress.html';
  }

  // path resolver function (= path 検出 lazy 評価で test mockable)
  // hardcoded ../status/ は 全削除、 PATHS.* 経由 で 統一。
  var PATHS = {
    agentRegistry: function () { return statusBase() + 'agent_registry.json'; },
    tProgress: function () { return statusBase() + 't_progress.json'; },
    poOutbox: function () { return statusBase() + 'po_outbox.json'; },
    pickupRules: function () { return statusBase() + 'pickup_rules.json'; },
    // T115 / TASK-DEVSYS-SUPERVISOR-DASHBOARD-LEGACY-VIEW
    // App 単位 view 用。 publish 経路で配信されない場合 fetch 失敗 → 「未取得」 placeholder
    // (brief v1 §1.1 + T110 + T112 連動、 後続 mission で集計 endpoint 配備候補)。
    retrofitStatus: function () { return statusBase() + 'retrofit_status.json'; }
  };

  // legacy ENDPOINTS object: po_inbox path のみ参考用 (PWA は po_inbox を fetch しない)
  var ENDPOINTS = {
    poInboxList: '../../instructions/po_inbox/'
  };

  // 公開用 (= test 利用 + dual-mode 検出 unit test 容易化)
  // function declarations は hoist されるため、 後段で定義した
  // aggregateAppView / renderAppView / appUpperKey も この時点で参照可能。
  if (typeof window !== 'undefined') {
    window.__dais_pwa = window.__dais_pwa || {};
    window.__dais_pwa.pwaBase = pwaBase;
    window.__dais_pwa.statusBase = statusBase;
    window.__dais_pwa.tProgressUrl = tProgressUrl;
    window.__dais_pwa.PATHS = PATHS;
    window.__dais_pwa.aggregateAppView = aggregateAppView; // T115
    window.__dais_pwa.renderAppView = renderAppView;       // T115
    window.__dais_pwa.appUpperKey = appUpperKey;           // T115
    window.__dais_pwa.buildIssueUrl = buildIssueUrl;       // T128 (test 公開)
    window.__dais_pwa.openIssueDeeplink = openIssueDeeplink; // T128 (test 公開)
    // T128 拡張 / TASK-DAIS-PWA-ONE-SITE-ASSIGN row click 拡張
    // 進捗ボード row click → modal 起動 の 1-site UX を test 可能化。
    window.__dais_pwa.openTaskAssignModal = openTaskAssignModal;       // 進捗 row click handler
    window.__dais_pwa.renderProgressBoard = renderProgressBoard;       // 進捗 board render
    window.__dais_pwa.isTaskClickable = isTaskClickable;               // QUEUED / IN_PROGRESS / LOCAL_DONE 判定
    window.__dais_pwa.buildProgressTaskPayload = buildProgressTaskPayload; // payload 生成 (test 公開)
  }

  var STATE = {
    agents: [],
    tasks: [],
    outbox: [],
    pickupRules: null,
    retrofitStatus: null, // T115: { apps: { <app>: { retrofitted_count, total_count, ... } } }
    lastFetch: null,
    pushSubscribed: false,
    errors: {}
  };

  var RULE_DEFS = [
    { key: 'claude-impl', target_app: 'Dais', owner_tag: '[Claude:IMPL]' },
    { key: 'codex-spec', target_app: 'Dais', owner_tag: '[Codex:SPEC]' },
    { key: 'subagent-impl', target_app: 'Dais', owner_tag: '[subagent:IMPL]' }
  ];

  // ─── DOM helper ─────────────────────────────────────────────────────
  function $(sel) { return document.querySelector(sel); }
  function $all(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }
  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') { node.className = attrs[k]; }
        else if (k === 'text') { node.textContent = attrs[k]; }
        else if (k === 'html') { node.innerHTML = attrs[k]; }
        else if (k.indexOf('on') === 0) { node.addEventListener(k.slice(2), attrs[k]); }
        else if (k === 'data') {
          Object.keys(attrs[k]).forEach(function (dk) { node.dataset[dk] = attrs[k][dk]; });
        }
        else { node.setAttribute(k, attrs[k]); }
      });
    }
    if (children) {
      (Array.isArray(children) ? children : [children]).forEach(function (c) {
        if (c == null) return;
        node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
      });
    }
    return node;
  }

  function setStatus(msg, level) {
    var line = $('#status-line');
    if (!line) return;
    line.textContent = msg;
    line.className = 'status-line' + (level ? ' ' + level : '');
  }

  function sanitizeLine(value) {
    return String(value || '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function openPrefillModal(title, payload, filename) {
    var modalTitle = $('#assign-modal-title');
    if (modalTitle) modalTitle.textContent = title;
    $('#assign-modal-payload').textContent = payload;
    $('#assign-modal').hidden = false;
    $('#assign-modal').dataset.payload = payload;
    $('#assign-modal').dataset.filename = filename || '';
    // T128 / TASK-DAIS-PWA-ONE-SITE-ASSIGN
    // GitHub Issue deeplink button 用に title もデータ属性に保存。
    $('#assign-modal').dataset.title = title || '';
  }

  // ─── T128 / TASK-DAIS-PWA-ONE-SITE-ASSIGN ───────────────────────────
  // GitHub Issue 新規作成 deeplink URL (= 1-site assign path)。
  // PWA modal の payload を URL encode した issues/new query string で
  // 同 Safari タブに開く。 ふとし login 済の前提で submit → T121 intake
  // (label dais:po-task) が poll で Mission Queue に自動取込。
  // PO 直命 2026-05-09「アクセスしたサイトからアサインできないと意味なくない？」
  // brief v1 §1.3「タップで agent にアサインできる」 本来意図 (= 1 サイト完結)。
  function buildIssueUrl(title, payload, label) {
    // 既定 label = dais:po-task (= T121 GitHub Issue intake が poll する label)。
    // 既定 URL 例: https://github.com/Trippy-gitcode/dev-system/issues/new?labels=dais:po-task&title=...&body=...
    var lbl = label || 'dais:po-task';
    // repo URL は 1 行で literal 化 (= grep github.com.*issues/new で機械検証可能)。
    var base = 'https://github.com/Trippy-gitcode/dev-system/issues/new';
    return base + '?labels=' + encodeURIComponent(lbl) +
      '&title=' + encodeURIComponent(title || '') +
      '&body=' + encodeURIComponent(payload || '');
  }

  function openIssueDeeplink() {
    var modal = $('#assign-modal');
    if (!modal) return;
    var payload = modal.dataset.payload || '';
    var title = modal.dataset.title || 'PWA 1-site assign';
    var url = buildIssueUrl(title, payload, 'dais:po-task');
    // 同 Safari タブで開く (= window.open _blank)。 PWA standalone でも
    // iOS Safari は外部 URL を default browser で開くので同 site 性は
    // 「Safari の中で完結」 という PO 意図に合致。
    var w = null;
    try { w = window.open(url, '_blank'); } catch (e) { w = null; }
    if (!w) {
      // popup blocked fallback (= 同タブ navigate)
      try { window.location.href = url; } catch (e2) { /* noop */ }
    }
    setStatus('GitHub Issue 作成画面を起動しました。 ふとしが submit → T121 intake で取込。', 'ok');
  }

  // ─── タブ切替 ───────────────────────────────────────────────────────
  function setupTabs() {
    $all('.tab-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var tab = btn.dataset.tab;
        $all('.tab-btn').forEach(function (b) {
          b.classList.toggle('active', b === btn);
          b.setAttribute('aria-selected', b === btn ? 'true' : 'false');
        });
        $all('.tab-pane').forEach(function (p) {
          p.classList.toggle('active', p.id === 'tab-' + tab);
        });
      });
    });
  }

  // ─── fetch helper ───────────────────────────────────────────────────
  function fetchJson(url) {
    // service worker が無くても動くように、 cache: no-store で取得する。
    return fetch(url, { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('fetch failed: ' + url + ' status=' + r.status);
      return r.json();
    });
  }

  // ─── §1.1 Active Agent Registry 描画 ────────────────────────────────
  // agent 状態判定 (last_heartbeat の経過時間ベース)
  function agentStatus(a) {
    if (!a.last_heartbeat) return { label: 'unknown', cls: 'st-unknown', minAgo: null };
    var now = Date.now();
    var hb = Date.parse(a.last_heartbeat);
    if (isNaN(hb)) return { label: 'unknown', cls: 'st-unknown', minAgo: null };
    var minAgo = Math.floor((now - hb) / 60000);
    if (minAgo < 10) return { label: 'active', cls: 'st-active', minAgo: minAgo };
    if (minAgo < 60) return { label: 'idle', cls: 'st-idle', minAgo: minAgo };
    return { label: 'offline', cls: 'st-offline', minAgo: minAgo };
  }

  // 全 agent 状態 strip (常時表示、 PO 質問「active/offline/作業中」 対応)
  function renderAgentStrip() {
    var strip = $('#agent-strip');
    if (!strip) return;
    strip.innerHTML = '';
    if (STATE.errors.agentRegistry) {
      strip.appendChild(el('div', { class: 'agent-strip-error', text: 'agent_registry.json 取得失敗' }));
      return;
    }
    if (!STATE.agents.length) {
      strip.appendChild(el('div', { class: 'agent-strip-empty', text: 'agent 情報なし' }));
      return;
    }
    var sorted = STATE.agents.slice().sort(function (a, b) {
      return (b.last_heartbeat || '').localeCompare(a.last_heartbeat || '');
    });
    sorted.forEach(function (a) {
      var st = agentStatus(a);
      var minTxt = st.minAgo === null ? '—' : (st.minAgo + 'm前');
      var taskTxt = a.current_task_id ? a.current_task_id.replace(/^TASK-/, '') : '(idle)';
      var card = el('div', { class: 'agent-card ' + st.cls }, [
        el('div', { class: 'agent-card-head' }, [
          el('span', { class: 'agent-card-name', text: a.agent || '(unknown)' }),
          el('span', { class: 'agent-card-status', text: st.label })
        ]),
        el('div', { class: 'agent-card-task', text: taskTxt }),
        el('div', { class: 'agent-card-meta', text: (a.branch || '—') + ' · ' + minTxt })
      ]);
      strip.appendChild(card);
    });
  }

  function renderAgents() {
    renderAgentStrip();
    var list = $('#agent-list');
    if (!list) return;
    list.innerHTML = '';
    if (STATE.errors.agentRegistry) {
      list.appendChild(el('li', { class: 'empty', text: 'agent_registry.json を取得できません。' }));
      return;
    }
    if (!STATE.agents.length) {
      list.appendChild(el('li', { class: 'empty', text: 'agent 情報がありません。' }));
      return;
    }
    var sorted = STATE.agents.slice().sort(function (a, b) {
      return (b.last_heartbeat || '').localeCompare(a.last_heartbeat || '');
    });
    sorted.forEach(function (a) {
      var st = agentStatus(a);
      var head = el('div', { class: 'agent-row-head' }, [
        el('span', { class: 'agent-name', text: (a.agent || '(unknown)') + ' [' + st.label + ']' }),
        el('span', { class: 'agent-hb', text: a.last_heartbeat || '—' })
      ]);
      var task = el('div', { class: 'agent-task', text: a.current_task_id || '(idle)' });
      var br = el('div', { class: 'agent-branch', text: a.branch || '' });
      var capStr = '';
      if (a.capability && Array.isArray(a.capability.owner_tags)) {
        capStr = 'owner: ' + a.capability.owner_tags.join(' / ');
      }
      var cap = el('div', { class: 'agent-cap', text: capStr });
      list.appendChild(el('li', null, [head, task, br, cap]));
    });
  }

  // ─── §1.2 手動アサイン待ち task 描画 ─────────────────────────────────
  function renderTasks() {
    var list = $('#assign-task-list');
    if (!list) return;
    var filterVal = ($('#assign-filter').value || '').toLowerCase();
    list.innerHTML = '';
    if (STATE.errors.tProgress) {
      list.appendChild(el('li', { class: 'empty', text: 't_progress.json を取得できません。' }));
      return;
    }

    // QUEUED + non-blocked (= status が QUEUED で blocked flag 無し)
    var queued = (STATE.tasks || []).filter(function (t) {
      var st = (t.status || '').toUpperCase();
      if (st !== 'QUEUED') return false;
      if (t.blocked === true || (t.status_modifier || '').toLowerCase() === 'blocked') return false;
      if (filterVal) {
        var hay = ((t.t_id || '') + ' ' + (t.mission_id || '') + ' ' + (t.target_app || '') + ' ' + (t.goal || '')).toLowerCase();
        if (hay.indexOf(filterVal) < 0) return false;
      }
      return true;
    });

    if (!queued.length) {
      list.appendChild(el('li', { class: 'empty', text: '手動アサイン待ち task はありません。' }));
      return;
    }

    queued.forEach(function (t) {
      var head = el('div', { class: 'task-row-head' }, [
        el('span', { class: 'task-id', text: (t.t_id || '') + ' / ' + (t.mission_id || '') }),
        el('span', { class: 'task-target', text: t.target_app || '' })
      ]);
      var goalText = (t.goal || '').slice(0, 240);
      if ((t.goal || '').length > 240) goalText += '…';
      var goal = el('div', { class: 'task-goal', text: goalText });
      var meta = el('div', { class: 'task-meta', text:
        'owner: ' + (t.owner || '—') + ' · priority: ' + (t.priority || '—')
      });
      var btns = el('div', { class: 'assign-buttons' }, [
        makeAssignBtn(t, '[Claude:IMPL]', 'Claude'),
        makeAssignBtn(t, '[Codex:SPEC]', 'Codex'),
        makeAssignBtn(t, '[subagent:IMPL]', 'subagent')
      ]);
      list.appendChild(el('li', null, [head, goal, meta, btns]));
    });
  }

  function makeAssignBtn(t, ownerTag, label) {
    return el('button', {
      class: 'assign-btn',
      type: 'button',
      onclick: function () { openAssignModal(t, ownerTag); }
    }, label + ' へアサイン');
  }

  // ─── §1.3 タップアサイン (= po_inbox prefill) ───────────────────────
  function openAssignModal(task, ownerTag) {
    var now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    var date = now.slice(0, 10).replace(/-/g, '');
    var topic = (task.t_id || 'task').toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-assign';
    var seq = '01';
    var poInboxId = topic + '-' + date + '-' + seq;
    var payload = [
      '---',
      'po_inbox_id: ' + poInboxId,
      'created_at: ' + now,
      'po_intent: ' + sanitizeLine((task.t_id || '') + ' を ' + ownerTag + ' にアサイン'),
      'suggested_owner: ' + ownerTag,
      'priority: ' + (task.priority || 'medium'),
      'target_app: ' + (task.target_app || 'Dais'),
      'expected_completion_level: IMPL_TESTED',
      'status: open',
      'claimed_by: ',
      'mission_id: ' + (task.mission_id || ''),
      '---',
      '',
      '# ' + (task.t_id || '') + ' を ' + ownerTag + ' にアサイン',
      '',
      'PWA tap assign で生成。 PO が ADV/Codex に渡し、',
      '`scripts/devs_po_inbox_intake.sh --claim ' + poInboxId + ' --owner \'' + ownerTag + '\'`',
      'で claim → Mission Queue 登録 (= convert) → 完了後 archive。',
      '',
      '## task 概要',
      '',
      'goal: ' + (task.goal || '(none)'),
      ''
    ].join('\n');

    openPrefillModal('アサイン指示を生成', payload, poInboxId + '.md');
  }

  // ─── T128 拡張 / TASK-DAIS-PWA-ONE-SITE-ASSIGN 進捗 row click ───────────
  // PO 直命 2026-05-09「進捗ボードを見てクリックしてアサインする形がいい」 反映。
  // 進捗 タブ の task row click → 既存 openPrefillModal 起動 → 既存「GitHub Issue
  // で送信」 button → submit → T121 intake、 1-site 完結 シングルボード UX。
  // 既存「割り当て」 タブ独立 UI は維持 (= backward-compat、 削除しない)。
  function isTaskClickable(task) {
    // QUEUED / IN_PROGRESS / LOCAL_DONE のみ click 対象。
    // DONE / COMPLETED / ARCHIVED は既終了 task で re-assign 不要 (= click 対象外)。
    if (!task) return false;
    var st = String(task.status || '').toUpperCase();
    return st === 'QUEUED' || st === 'IN_PROGRESS' || st === 'LOCAL_DONE';
  }

  function buildProgressTaskPayload(task) {
    // 進捗 row click 用の po_inbox prefill payload。
    // 既存 owner があればそれを suggested_owner、 無ければ [Claude:IMPL] を default。
    var now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    var date = now.slice(0, 10).replace(/-/g, '');
    var topic = (task.t_id || 'task').toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-progress-assign';
    var seq = '01';
    var poInboxId = topic + '-' + date + '-' + seq;
    var suggested = sanitizeLine(task.owner || task.owner_ai || '[Claude:IMPL]');
    var st = String(task.status || '').toUpperCase();
    var payload = [
      '---',
      'po_inbox_id: ' + poInboxId,
      'created_at: ' + now,
      'po_intent: ' + sanitizeLine((task.t_id || '') + ' (status=' + st + ') を ' + suggested + ' に再アサイン / 進捗確認'),
      'suggested_owner: ' + suggested,
      'priority: ' + (task.priority || 'medium'),
      'target_app: ' + (task.target_app || 'Dais'),
      'expected_completion_level: IMPL_TESTED',
      'status: open',
      'claimed_by: ',
      'mission_id: ' + (task.mission_id || ''),
      'source: pwa-progress-row-click',
      'task_status: ' + st,
      '---',
      '',
      '# ' + (task.t_id || '') + ' progress row click assign',
      '',
      'PWA 進捗ボード row click で生成 (= 1-site UX、 PO 直命 2026-05-09)。',
      '`scripts/devs_po_inbox_intake.sh --claim ' + poInboxId + ' --owner \'' + suggested + '\'`',
      'で claim → Mission Queue 確認 / 再アサイン → 完了後 archive。',
      '',
      '## task 概要',
      '',
      'goal: ' + (task.goal || '(none)'),
      'current owner: ' + (task.owner || '—'),
      'current status: ' + st,
      ''
    ].join('\n');
    return { poInboxId: poInboxId, payload: payload };
  }

  function openTaskAssignModal(task) {
    // 進捗 board row click から呼ばれる。 DONE 等 click 対象外は openPrefillModal を
    // 呼ばず即 return (= modal 起動しない)、 row click handler 側でも guard する
    // が、 二重 guard で fail-safe。
    if (!isTaskClickable(task)) return false;
    var built = buildProgressTaskPayload(task);
    openPrefillModal('進捗 row → アサイン指示を生成', built.payload, built.poInboxId + '.md');
    return true;
  }

  function renderProgressBoard() {
    // 進捗 タブ の task row 一覧 (= 既存 iframe 上に追加表示)。
    // QUEUED / IN_PROGRESS / LOCAL_DONE の active task のみ表示、 click で modal 起動。
    var list = $('#progress-board-list');
    if (!list) return;
    list.innerHTML = '';
    if (STATE.errors.tProgress) {
      list.appendChild(el('li', { class: 'empty', text: 't_progress.json を取得できないため進捗ボードを表示できません。' }));
      return;
    }
    var active = (STATE.tasks || []).filter(isTaskClickable);
    if (!active.length) {
      list.appendChild(el('li', { class: 'empty', text: 'click 対象 (QUEUED / IN_PROGRESS / LOCAL_DONE) の task はありません。' }));
      return;
    }
    // status 順 (IN_PROGRESS → QUEUED → LOCAL_DONE) + t_id 降順
    var order = { IN_PROGRESS: 0, QUEUED: 1, LOCAL_DONE: 2 };
    var sorted = active.slice().sort(function (a, b) {
      var sa = order[String(a.status || '').toUpperCase()] || 9;
      var sb = order[String(b.status || '').toUpperCase()] || 9;
      if (sa !== sb) return sa - sb;
      return (b.t_id || '').localeCompare(a.t_id || '');
    });
    sorted.forEach(function (t) {
      var st = String(t.status || '').toUpperCase();
      var head = el('div', { class: 'task-row-head' }, [
        el('span', { class: 'task-id', text: (t.t_id || '') + ' / ' + (t.mission_id || '') }),
        el('span', { class: 'task-target', text: (t.target_app || '') + ' · ' + st })
      ]);
      var goalText = (t.goal || '').slice(0, 200);
      if ((t.goal || '').length > 200) goalText += '…';
      var goal = el('div', { class: 'task-goal', text: goalText });
      var meta = el('div', { class: 'task-meta', text:
        'owner: ' + (t.owner || '—') + ' · status: ' + st + ' · click でアサイン'
      });
      // row 自体を clickable に。 keyboard accessibility 用に role="button" + tabindex=0。
      var row = el('li', {
        class: 'task-clickable',
        role: 'button',
        tabindex: '0',
        'aria-label': (t.t_id || '') + ' をアサイン',
        data: { taskId: t.t_id || '', missionId: t.mission_id || '', status: st }
      }, [head, goal, meta]);
      // click handler (進捗 row click → modal)。
      row.addEventListener('click', function () { openTaskAssignModal(t); });
      // keyboard (Enter / Space) でも 起動 (= a11y)。
      row.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openTaskAssignModal(t);
        }
      });
      list.appendChild(row);
    });
  }

  function closeAssignModal() {
    $('#assign-modal').hidden = true;
  }

  function copyAssignPayload() {
    var payload = $('#assign-modal').dataset.payload || '';
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(payload).then(function () {
        setStatus('po_inbox prefill をコピーしました。', 'ok');
      }, function () {
        setStatus('クリップボード書込に失敗。 手動コピーしてください。', 'warn');
      });
    } else {
      // legacy fallback: select pre text
      var range = document.createRange();
      range.selectNodeContents($('#assign-modal-payload'));
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      setStatus('テキストを選択しました。 長押し → コピーしてください。', 'warn');
    }
  }

  // ─── §1.4 自動 pickup ルール ────────────────────────────────────────
  function pickupRuleEnabled(def) {
    var rules = (STATE.pickupRules && STATE.pickupRules.rules) || [];
    function matchRule(targetApp, ownerTag) {
      for (var i = 0; i < rules.length; i += 1) {
        var r = rules[i] || {};
        if (r.target_app === targetApp && r.owner_tag === ownerTag) {
          return r;
        }
      }
      return null;
    }
    var found = matchRule(def.target_app, def.owner_tag) ||
      matchRule('*', def.owner_tag) ||
      matchRule(def.target_app, '*') ||
      matchRule('*', '*');
    if (!found) return true;
    return found.auto_pickup_enabled !== false;
  }

  function renderRules() {
    RULE_DEFS.forEach(function (def) {
      var box = document.querySelector('input[data-rule="' + def.key + '"]');
      if (!box) return;
      box.checked = pickupRuleEnabled(def);
      box.disabled = !!STATE.errors.pickupRules;
    });
  }

  function openRuleChangeModal(def, enabled) {
    var now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    var date = now.slice(0, 10).replace(/-/g, '');
    var poInboxId = 'pickup-rule-' + def.key + '-' + date + '-01';
    var payload = [
      '---',
      'po_inbox_id: ' + poInboxId,
      'created_at: ' + now,
      'po_intent: pickup rule ' + def.target_app + ' / ' + def.owner_tag + ' を ' + (enabled ? 'enabled' : 'disabled') + ' に変更',
      'suggested_owner: [Codex:SPEC]',
      'priority: medium',
      'target_app: Dais',
      'expected_completion_level: SPEC_ONLY',
      'status: open',
      'claimed_by: ',
      'mission_id: ',
      'source: pwa-pickup-rule',
      '---',
      '',
      '# pickup rule change request',
      '',
      'PWA pickup toggle で生成。 `docs/status/pickup_rules.json` の rule を更新してください。',
      '',
      'target_app: ' + def.target_app,
      'owner_tag: ' + def.owner_tag,
      'auto_pickup_enabled: ' + (enabled ? 'true' : 'false'),
      ''
    ].join('\n');
    openPrefillModal('pickup rule 変更指示を生成', payload, poInboxId + '.md');
  }

  function setupRules() {
    RULE_DEFS.forEach(function (def) {
      var box = document.querySelector('input[data-rule="' + def.key + '"]');
      if (!box) return;
      box.addEventListener('change', function () {
        openRuleChangeModal(def, box.checked);
        renderRules();
      });
    });
    renderRules();
  }

  // ─── §1.5 緊急通知 (Web Push subscribe + po_outbox fallback) ────────
  function setupPushToggle() {
    var btn = $('#push-toggle');
    var hint = $('#push-hint');
    if (!btn) return;

    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
      btn.disabled = true;
      hint.textContent = 'この browser は Web Push 未対応 (Apple Developer 加入後でも iOS 16.4+ Safari 限定)。';
      return;
    }

    btn.addEventListener('click', function () {
      // Apple Push 用 VAPID key は T122 で配備予定。 現状は permission 確認のみ。
      Notification.requestPermission().then(function (perm) {
        if (perm === 'granted') {
          STATE.pushSubscribed = true;
          btn.textContent = '通知 有効 (T122 配備後に push 受信開始)';
          btn.disabled = true;
          hint.textContent = 'permission granted。 T122 で VAPID + push subscription 連動予定。';
          setStatus('通知 permission を取得しました。', 'ok');
        } else {
          setStatus('通知 permission が拒否されました。', 'warn');
        }
      }).catch(function (err) {
        setStatus('通知 permission 取得失敗: ' + (err && err.message), 'error');
      });
    });
  }

  // ─── T115 App 単位 view (Phase 進捗 / retrofit 進捗 / violation count) ─
  // brief v1 §1.1 + T112 (Phase 1-9 Lifecycle) + T110 (App 知見 retrofit) +
  // verify/adv_violation_log.md の集約 view。 「進捗」 タブの 折りたたみ
  // 「追加 view」 内 (= details.extras) に App 単位の card を表示する。
  //
  // 集計 source:
  //   - Phase 進捗: STATE.tasks (= t_progress.json) を target_app で group by して
  //     mission_id が `TASK-{APP_UPPER}-PHASE[1-9]-...` パターン のもの から
  //     status (DONE / LOCAL_DONE / IN_PROGRESS / QUEUED / BLOCKED) 件数 を 集計。
  //     Phase pattern が無い App は 全 task の status 件数 (= 全体 進捗) を fallback 表示。
  //   - retrofit 進捗: STATE.retrofitStatus (= retrofit_status.json projection)。
  //     publish 経路で配信されない場合は 「未取得」 placeholder。
  //   - violation count: STATE.tasks 親 JSON に violation_summary が在る場合 read。
  //     無ければ 「集計未配備」 placeholder (= verify/adv_violation_log.md は
  //     SSoT で publish 経路に projection が無いため、 後続 mission で 集計 endpoint 追加候補)。
  function appUpperKey(app) {
    return String(app || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  }

  function aggregateAppView(tasks, retrofitStatus, violationSummary) {
    // group by target_app (= 同一 task が 「Dais / Mais」 等 複合 target を持つ場合は
    // 分割して 各 App に カウント)。 (none) は 「未指定」 として 1 group。
    var groups = {};
    function ensure(app) {
      if (!groups[app]) {
        groups[app] = {
          app: app,
          phase_total: 0,
          phase_status: { DONE: 0, LOCAL_DONE: 0, IN_PROGRESS: 0, QUEUED: 0, BLOCKED: 0 },
          all_total: 0,
          all_status: { DONE: 0, LOCAL_DONE: 0, IN_PROGRESS: 0, QUEUED: 0, BLOCKED: 0, OTHER: 0 }
        };
      }
      return groups[app];
    }

    (tasks || []).forEach(function (t) {
      var raw = (t.target_app || '(none)').trim() || '(none)';
      // 複合 target (= 「A / B」) を split
      var apps = raw.split(/\s*\/\s*/).filter(function (x) { return x; });
      if (!apps.length) apps = ['(none)'];
      var st = (t.status || '').toUpperCase();
      var mid = String(t.mission_id || '');
      apps.forEach(function (app) {
        var g = ensure(app);
        // all_status (= App 全 task の status 集計)
        if (g.all_status[st] !== undefined) g.all_status[st] += 1;
        else g.all_status.OTHER += 1;
        g.all_total += 1;
        // phase_status (= TASK-{APP_UPPER}-PHASE[1-9]-... のみ)
        var upper = appUpperKey(app);
        var phaseRe = new RegExp('^TASK-' + upper + '-PHASE([1-9])', 'i');
        if (phaseRe.test(mid)) {
          if (g.phase_status[st] !== undefined) g.phase_status[st] += 1;
          g.phase_total += 1;
        }
      });
    });

    var apps = Object.keys(groups).sort(function (a, b) {
      // 「(none)」 を末尾、 task 数 多い順
      if (a === '(none)') return 1;
      if (b === '(none)') return -1;
      return groups[b].all_total - groups[a].all_total;
    });

    return apps.map(function (app) {
      var g = groups[app];
      var rs = (retrofitStatus && retrofitStatus.apps && retrofitStatus.apps[app]) || null;
      // violation_summary: t_progress.json 親 に violation_summary.by_app[<app>] = N が在る場合
      var vc = null;
      if (violationSummary && violationSummary.by_app) {
        if (typeof violationSummary.by_app[app] === 'number') {
          vc = violationSummary.by_app[app];
        }
      }
      return {
        app: g.app,
        phase_total: g.phase_total,
        phase_status: g.phase_status,
        all_total: g.all_total,
        all_status: g.all_status,
        retrofit: rs, // null = 未取得
        violation_count: vc // null = 集計未配備
      };
    });
  }

  function renderAppView() {
    var list = $('#app-view-list');
    if (!list) return;
    list.innerHTML = '';
    if (STATE.errors.tProgress) {
      var li = el('li', { class: 'empty', text: 't_progress.json を取得できないため App 単位 view を表示できません。' });
      list.appendChild(li);
      return;
    }
    var summary = (STATE.rawTProgress && STATE.rawTProgress.violation_summary) || null;
    var rows = aggregateAppView(STATE.tasks, STATE.retrofitStatus, summary);
    if (!rows.length) {
      list.appendChild(el('li', { class: 'empty', text: 'App 情報がありません。' }));
      return;
    }
    rows.forEach(function (r) {
      var card = el('li', { class: 'app-view-card' });
      card.appendChild(el('div', { class: 'app-view-name', text: r.app }));

      // Phase 進捗 row
      var phaseRow = el('div', { class: 'app-view-row' });
      if (r.phase_total > 0) {
        phaseRow.appendChild(el('span', { class: 'app-view-badge', text: 'Phase: ' + r.phase_total }));
        ['DONE', 'LOCAL_DONE', 'IN_PROGRESS', 'QUEUED', 'BLOCKED'].forEach(function (k) {
          if (r.phase_status[k] > 0) {
            phaseRow.appendChild(el('span', {
              class: 'app-view-badge ' + k.toLowerCase(),
              text: k + ': ' + r.phase_status[k]
            }));
          }
        });
      } else {
        // Phase pattern 無し → 全 task status を fallback
        phaseRow.appendChild(el('span', { class: 'app-view-badge', text: 'Phase 未付番 (全 task: ' + r.all_total + ')' }));
        ['DONE', 'LOCAL_DONE', 'IN_PROGRESS', 'QUEUED', 'BLOCKED'].forEach(function (k) {
          if (r.all_status[k] > 0) {
            phaseRow.appendChild(el('span', {
              class: 'app-view-badge ' + k.toLowerCase(),
              text: k + ': ' + r.all_status[k]
            }));
          }
        });
      }
      card.appendChild(phaseRow);

      // retrofit + violation row
      var metaRow = el('div', { class: 'app-view-row' });
      if (r.retrofit) {
        var rfTotal = (typeof r.retrofit.total_count === 'number') ? r.retrofit.total_count : null;
        var rfDone = (typeof r.retrofit.retrofitted_count === 'number') ? r.retrofit.retrofitted_count : null;
        var rfTxt = 'retrofit: ' + (rfDone == null ? '?' : rfDone) + ' / ' + (rfTotal == null ? '?' : rfTotal);
        metaRow.appendChild(el('span', { class: 'app-view-badge', text: rfTxt }));
      } else {
        metaRow.appendChild(el('span', { class: 'app-view-badge', text: 'retrofit: 未取得' }));
      }
      if (r.violation_count != null) {
        metaRow.appendChild(el('span', { class: 'app-view-badge', text: 'violations: ' + r.violation_count }));
      } else {
        metaRow.appendChild(el('span', { class: 'app-view-badge', text: 'violations: 集計未配備' }));
      }
      card.appendChild(metaRow);

      list.appendChild(card);
    });
  }

  // ─── 進捗 サマリー ───────────────────────────────────────────────────
  function renderProgressSummary() {
    var active = (STATE.tasks || []).filter(function (t) {
      var s = (t.status || '').toUpperCase();
      return s !== 'DONE' && s !== 'COMPLETED' && s !== 'ARCHIVED';
    }).length;
    var completed = (STATE.tasks || []).filter(function (t) {
      var s = (t.status || '').toUpperCase();
      return s === 'DONE' || s === 'COMPLETED' || s === 'LOCAL_DONE';
    }).length;
    var agents = (STATE.agents || []).length;

    var a = $('#kpi-active'); if (a) a.textContent = String(active);
    var c = $('#kpi-completed'); if (c) c.textContent = String(completed);
    var g = $('#kpi-agents'); if (g) g.textContent = String(agents);
  }

  // ─── po_outbox 描画 (docs/status/po_outbox.json projection) ────────
  function renderOutbox() {
    var list = $('#outbox-list');
    if (!list) return;
    list.innerHTML = '';
    if (STATE.errors.poOutbox) {
      list.appendChild(el('li', { class: 'empty', text: 'po_outbox.json を取得できません。' }));
      return;
    }
    if (!STATE.outbox.length) {
      list.appendChild(el('li', { class: 'empty', text:
        'po_outbox の未対応通知はありません。'
      }));
      return;
    }
    var order = { urgent: 0, normal: 1, info: 2 };
    var sorted = STATE.outbox.slice().sort(function (a, b) {
      return (order[a.urgency] || 9) - (order[b.urgency] || 9);
    });
    sorted.forEach(function (o) {
      var head = el('div', { class: 'outbox-row-head' }, [
        el('span', { class: 'urgency-badge urgency-' + (o.urgency || 'info'), text: (o.urgency || 'info').toUpperCase() }),
        el('span', { class: 'agent-hb', text: o.created_at || '' })
      ]);
      var subj = el('div', { class: 'outbox-mid', text: o.subject || o.po_action_summary || o.po_outbox_id || '' });
      var meta = el('div', { class: 'outbox-meta', text:
        'mission: ' + (o.mission_id || '—') + ' · status: ' + (o.status || '—') +
        (o.po_action_required ? ' · PO action 要' : '')
      });
      list.appendChild(el('li', null, [head, subj, meta]));
    });
  }

  // ─── データ取得 ──────────────────────────────────────────────────────
  function refresh() {
    setStatus('読み込み中…');
    var jobs = [];
    STATE.errors = {};

    jobs.push(fetchJson(PATHS.agentRegistry()).then(function (d) {
      STATE.agents = (d && d.agents) || [];
    }).catch(function (err) {
      console.warn('agent_registry fetch failed:', err);
      STATE.agents = [];
      STATE.errors.agentRegistry = true;
    }));

    jobs.push(fetchJson(PATHS.tProgress()).then(function (d) {
      STATE.tasks = (d && d.tasks) || [];
      STATE.rawTProgress = d || null; // T115: violation_summary 等 親 field を保持
    }).catch(function (err) {
      console.warn('t_progress fetch failed:', err);
      STATE.tasks = [];
      STATE.rawTProgress = null;
      STATE.errors.tProgress = true;
    }));

    // T115: retrofit_status.json は publish 経路で配信されない場合あり (= 後続 mission)。
    // fetch 失敗 = 「未取得」 placeholder で表示、 violation 同様 graceful degrade。
    jobs.push(fetchJson(PATHS.retrofitStatus()).then(function (d) {
      STATE.retrofitStatus = d || null;
    }).catch(function (err) {
      console.warn('retrofit_status fetch failed (T115 placeholder OK):', err);
      STATE.retrofitStatus = null;
      STATE.errors.retrofitStatus = true;
    }));

    jobs.push(fetchJson(PATHS.poOutbox()).then(function (d) {
      STATE.outbox = (d && d.items) || [];
    }).catch(function (err) {
      console.warn('po_outbox fetch failed:', err);
      STATE.outbox = [];
      STATE.errors.poOutbox = true;
    }));

    jobs.push(fetchJson(PATHS.pickupRules()).then(function (d) {
      STATE.pickupRules = d || null;
    }).catch(function (err) {
      console.warn('pickup_rules fetch failed:', err);
      STATE.pickupRules = null;
      STATE.errors.pickupRules = true;
    }));

    return Promise.all(jobs).then(function () {
      STATE.lastFetch = new Date();
      renderAgents();
      renderTasks();
      renderOutbox();
      renderRules();
      renderProgressSummary();
      renderAppView();
      renderProgressBoard(); // T128 拡張: 進捗 row click → modal 起動
      var stamp = STATE.lastFetch.toISOString().replace(/\.\d{3}Z$/, 'Z');
      setStatus('更新: ' + stamp + ' (agents=' + STATE.agents.length + ', tasks=' + STATE.tasks.length + ', outbox=' + STATE.outbox.length + ')', 'ok');
    });
  }

  // ─── service worker 登録 ────────────────────────────────────────────
  function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    // service worker は同 directory の sw.js を相対 path で register。
    navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(function (err) {
      console.warn('sw register failed:', err);
    });
  }

  // ─── 起動 ────────────────────────────────────────────────────────────
  function setupProgressLinks() {
    // T125 dual-mode: iframe src + 「別タブで開く」 link を JS で動的設定
    var url = tProgressUrl();
    var iframe = document.getElementById('progress-iframe');
    if (iframe) iframe.src = url;
    // a[href*="t_progress.html"] = section-desc 内 「別タブで開く」 リンク
    var openLinks = document.querySelectorAll('a[href*="t_progress.html"]');
    for (var i = 0; i < openLinks.length; i += 1) {
      openLinks[i].href = url;
    }
  }

  function init() {
    setupTabs();
    setupRules();
    setupPushToggle();
    setupProgressLinks();

    $('#assign-refresh').addEventListener('click', refresh);
    $('#assign-filter').addEventListener('input', renderTasks);
    $('#assign-copy-btn').addEventListener('click', copyAssignPayload);
    $('#assign-close-btn').addEventListener('click', closeAssignModal);
    // T128: GitHub Issue で送信 (= 1-site assign deeplink)
    var issueBtn = $('#assign-modal-submit-issue');
    if (issueBtn) issueBtn.addEventListener('click', openIssueDeeplink);
    $('#assign-modal').addEventListener('click', function (e) {
      if (e.target === $('#assign-modal')) closeAssignModal();
    });

    refresh();
    registerSW();

    // periodic refresh 60s
    setInterval(refresh, 60000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
