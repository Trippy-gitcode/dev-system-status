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
    pickupRules: function () { return statusBase() + 'pickup_rules.json'; }
  };

  // legacy ENDPOINTS object: po_inbox path のみ参考用 (PWA は po_inbox を fetch しない)
  var ENDPOINTS = {
    poInboxList: '../../instructions/po_inbox/'
  };

  // 公開用 (= test 利用 + dual-mode 検出 unit test 容易化)
  if (typeof window !== 'undefined') {
    window.__dais_pwa = window.__dais_pwa || {};
    window.__dais_pwa.pwaBase = pwaBase;
    window.__dais_pwa.statusBase = statusBase;
    window.__dais_pwa.tProgressUrl = tProgressUrl;
    window.__dais_pwa.PATHS = PATHS;
  }

  var STATE = {
    agents: [],
    tasks: [],
    outbox: [],
    pickupRules: null,
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
    }).catch(function (err) {
      console.warn('t_progress fetch failed:', err);
      STATE.tasks = [];
      STATE.errors.tProgress = true;
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
