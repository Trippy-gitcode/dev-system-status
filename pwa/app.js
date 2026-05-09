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
    var suffix = '?progress_ts=' + Date.now();
    if (/\/docs\/pwa\/$/.test(pb)) {
      return pb.replace(/pwa\/$/, 'status/t_progress.html') + suffix;
    }
    if (/\/pwa\/$/.test(pb)) {
      return pb.replace(/pwa\/$/, 't_progress.html') + suffix;
    }
    return pb + 't_progress.html' + suffix;
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
    retrofitStatus: function () { return statusBase() + 'retrofit_status.json'; },
    // T172 / TASK-DAIS-ASSIGN-SETTINGS-IMPL
    // T149 SPEC §11 設定 JSON file の projection。 SSoT = docs/dais_assign_settings.json
    // + localStorage('dais_assign_settings'). publish 経路から PWA に配信、
    // fetch 失敗時は default + localStorage で graceful degrade。
    assignSettings: function () { return statusBase() + 'assign_settings.json'; }
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
    window.__dais_pwa.isPendingConfirmationTask = isPendingConfirmationTask;
    window.__dais_pwa.buildPoConfirmationPayload = buildPoConfirmationPayload;
    window.__dais_pwa.openPoConfirmationModal = openPoConfirmationModal;
    // T147 / TASK-DAIS-HEAVY-TASK-DECOMPOSITION-RULE
    // Heavy task manual decomposition affordance.
    window.__dais_pwa.isTaskDecompositionCandidate = isTaskDecompositionCandidate;
    window.__dais_pwa.buildTaskDecompositionPayload = buildTaskDecompositionPayload;
    window.__dais_pwa.openTaskDecompositionModal = openTaskDecompositionModal;
    // T139 / TASK-DEVSYS-MISSION-GRAPH-SSOT-AND-VERDICT-PROPAGATE
    // Mission Graph view: depends_on / parent_of / parallel_with の視覚化 +
    // critical_input_from がある task を BLOCK badge で 視認 化。
    window.__dais_pwa.renderMissionGraph = renderMissionGraph;
    window.__dais_pwa.computeMissionGraph = computeMissionGraph;
    window.__dais_pwa.parseGraphList = parseGraphList;
    // T163 / TASK-DAIS-PARENT-CHILD-DETECTOR-IMPL
    // 詳細カード「関連 task suggest」 section (= projection-only field
    // `parent_child_suggest`、 detector が SSoT を mutate しないため、
    // accept/edit/skip は po_inbox prefill / 手動 commit 経由で実行)。
    window.__dais_pwa.renderParentChildSuggestSection = renderParentChildSuggestSection;
    window.__dais_pwa.buildParentChildAcceptPayload = buildParentChildAcceptPayload;
    window.__dais_pwa.buildParentChildEditPayload = buildParentChildEditPayload;
    window.__dais_pwa.openParentChildSkipDialog = openParentChildSkipDialog;
    window.__dais_pwa.recordParentChildSkip = recordParentChildSkip;
    // T172 / TASK-DAIS-ASSIGN-SETTINGS-IMPL (T149 SPEC §2-§8)
    // 階層判定 + 負荷分散 + クロスレビュー UI 強制 + 警告 + OFF 永続化 を test 公開。
    window.__dais_pwa.defaultAssignSettings = defaultAssignSettings;
    window.__dais_pwa.mergeAssignSettings = mergeAssignSettings;
    window.__dais_pwa.resolveAssignPriority = resolveAssignPriority;
    window.__dais_pwa.computeLoadBalanceScore = computeLoadBalanceScore;
    window.__dais_pwa.gatherSideStats = gatherSideStats;
    window.__dais_pwa.countUnassignedTasks = countUnassignedTasks;
    window.__dais_pwa.shouldHideReviewSelector = shouldHideReviewSelector;
    window.__dais_pwa.readAssignSettingsLocal = readAssignSettingsLocal;
    window.__dais_pwa.writeAssignSettingsLocal = writeAssignSettingsLocal;
    window.__dais_pwa.ASSIGN_SETTINGS_LS_KEY = ASSIGN_SETTINGS_LS_KEY;
  }

  var STATE = {
    agents: [],
    tasks: [],
    outbox: [],
    pickupRules: null,
    retrofitStatus: null, // T115: { apps: { <app>: { retrofitted_count, total_count, ... } } }
    // T172 / TASK-DAIS-ASSIGN-SETTINGS-IMPL
    // T149 SPEC §11 設定 JSON. assignSettings = 解決済 設定 (default + remote + localStorage merge)。
    assignSettings: null,
    lastFetch: null,
    pushSubscribed: false,
    errors: {}
  };

  // ─── T172 / TASK-DAIS-ASSIGN-SETTINGS-IMPL ───────────────────────────
  // T149 SPEC §2 / §11 設定 JSON schema + §5 階層判定 + §7 負荷分散 4 観点 +
  // §8 クロスレビュー UI 強制 + §9 未アサイン 5 件警告 + §10 OFF 永続化。
  // PO 直命 2026-05-09「アサイン設定 提案書」 → T149 SPEC v1.1 → T172 IMPL。
  var ASSIGN_SETTINGS_LS_KEY = 'dais_assign_settings';

  // §13 推奨デフォルト + §11.2 schema 構造の default object。 assign_settings.json
  // fetch 失敗時 / localStorage 不在時の fallback。
  function defaultAssignSettings() {
    return {
      schema_version: '1.0',
      auto_assign_enabled: true,
      global: {
        impl: 'load_balance',
        spec: 'codex_priority',
        review: 'cross_review_locked'
      },
      by_kind: {
        impl_medium: 'load_balance',
        impl_large: 'claude_priority',
        ops: 'load_balance'
      },
      by_app: { lais: null, mais: null, dais: null },
      by_task: {},
      load_balance_weights: { slot: 0.4, load: 0.2, context: 0.2, time: 0.2 },
      unassigned_warning_threshold: 5,
      off_persistence: true,
      updated_at: null,
      updated_by: null
    };
  }

  // §10 OFF 永続化 + §8 review override 拒否 を強制する merge logic。
  // localStorage 値が存在し off_persistence=true なら remote/default に優先して
  // OFF 状態を維持する。 review key は cross_review_locked 固定 (例外なし、 §8.4)。
  function mergeAssignSettings(remote, local) {
    var merged = defaultAssignSettings();
    if (remote && typeof remote === 'object') {
      Object.keys(remote).forEach(function (k) { merged[k] = remote[k]; });
    }
    if (local && typeof local === 'object') {
      // off_persistence=true 時のみ auto_assign_enabled を localStorage 優先
      if (merged.off_persistence !== false && typeof local.auto_assign_enabled === 'boolean') {
        merged.auto_assign_enabled = local.auto_assign_enabled;
      }
      ['by_app', 'by_kind', 'by_task'].forEach(function (key) {
        if (local[key] && typeof local[key] === 'object') {
          var combined = {};
          Object.keys(merged[key] || {}).forEach(function (k) { combined[k] = merged[key][k]; });
          Object.keys(local[key]).forEach(function (k) { combined[k] = local[key][k]; });
          merged[key] = combined;
        }
      });
    }
    // §8 cross-review locked 強制 (= API レイヤ override 拒否、 例外なし)
    if (!merged.global) merged.global = {};
    merged.global.review = 'cross_review_locked';
    return merged;
  }

  function readAssignSettingsLocal() {
    try {
      if (typeof window === 'undefined' || !window.localStorage) return null;
      var raw = window.localStorage.getItem(ASSIGN_SETTINGS_LS_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (e) {
      return null;
    }
  }

  function writeAssignSettingsLocal(settings) {
    try {
      if (typeof window === 'undefined' || !window.localStorage) return false;
      // §10 OFF 永続化: off_persistence=false 時は永続化しない。
      var offPersist = settings && settings.off_persistence !== false;
      if (!offPersist) {
        window.localStorage.removeItem(ASSIGN_SETTINGS_LS_KEY);
        return true;
      }
      window.localStorage.setItem(ASSIGN_SETTINGS_LS_KEY, JSON.stringify(settings));
      return true;
    } catch (e) {
      return false;
    }
  }

  // §11.5 階層判定実装擬似コード。review は §8 の例外なしロックを最優先。
  function resolveAssignPriority(task, settings) {
    if (!task) return 'load_balance';
    var s = settings || STATE.assignSettings || defaultAssignSettings();
    var tid = task.t_id || '';
    var missionId = task.mission_id || task.task_id || '';
    var app = String(task.target_app || task.app || '').toLowerCase();
    var kind = String(task.kind || task.task_kind || '').toLowerCase();
    // 0. §8 cross-review 強制 (review kind は UI/API 変更不可)
    if (kind === 'review') return 'cross_review_locked';
    // 1. タスク別 override (= 最優先、 §5.2 step 1)
    if (s.by_task) {
      var keys = [];
      if (tid) keys.push(tid);
      if (missionId && missionId !== tid) keys.push(missionId);
      for (var i = 0; i < keys.length; i += 1) {
        if (s.by_task[keys[i]]) return s.by_task[keys[i]];
      }
    }
    // 2. App 別設定 (§5.2 step 2)
    if (s.by_app && s.by_app[app]) return s.by_app[app];
    // 3. 種類別個別設定 (§5.2 step 3)
    if (s.by_kind && s.by_kind[kind]) return s.by_kind[kind];
    // 4. 種類別 spec マッピング (§5.4)
    if (kind === 'spec') return (s.global && s.global.spec) || 'codex_priority';
    // 5. グローバルデフォルト
    return (s.global && s.global.impl) || 'load_balance';
  }

  // §7.3 score 算出式 (= w_slot * 空き枠 + w_load * 1/進行中量 + w_ctx * コンテキスト残量 + w_time * 1/直近実行時間)
  // sideStats = { slot, load, context, time } それぞれ正規化済 0-1。
  function computeLoadBalanceScore(sideStats, weights) {
    var s = sideStats || {};
    var w = weights || { slot: 0.4, load: 0.2, context: 0.2, time: 0.2 };
    function num(v) { return typeof v === 'number' && isFinite(v) ? v : 0; }
    return (
      num(w.slot) * num(s.slot) +
      num(w.load) * num(s.load) +
      num(w.context) * num(s.context) +
      num(w.time) * num(s.time)
    );
  }

  // §7.4 入力データソース。 agents = STATE.agents、 tasks = STATE.tasks。
  // 4 観点 (空き枠 / 進行中量 / コンテキスト残量 / 直近実行時間) を CLD/CDX 別に集計。
  function gatherSideStats(agents, tasks, side) {
    var prefix = side === 'CLD' ? 'CLD' : 'CDX';
    var ag = (agents || []).filter(function (a) {
      var n = String(a.agent || '').toUpperCase();
      return n.indexOf(prefix) === 0;
    });
    // 空き枠 = current_task_id が空 の agent 数 (§7.4)
    var emptySlots = ag.filter(function (a) { return !a.current_task_id; }).length;
    // 進行中量 = current_task_id が埋まっている agent 数 (§7.4)
    var inFlight = ag.filter(function (a) { return !!a.current_task_id; }).length;
    // 直近実行時間 = last_heartbeat の delta 平均 (簡易、 §7.4)
    var now = Date.now();
    var hbAvg = 0;
    var hbCount = 0;
    ag.forEach(function (a) {
      if (a.last_heartbeat) {
        var t = Date.parse(a.last_heartbeat);
        if (!isNaN(t)) { hbAvg += (now - t); hbCount += 1; }
      }
    });
    if (hbCount > 0) hbAvg = hbAvg / hbCount; else hbAvg = 0;
    // コンテキスト残量 = 進行中 task の sub 数で減点 (§7.2、 簡易)
    var contextLeft = Math.max(0, 4 - inFlight); // 主枠 4 + 予備の単純化
    return {
      slot: emptySlots / 4, // 正規化 (4 = max 主枠数)
      load: inFlight === 0 ? 1 : (1 / inFlight),
      context: contextLeft / 4,
      // 直近実行時間が長い = idle = 余裕 → 0-1 正規化 (1h base)
      time: hbAvg === 0 ? 0.5 : Math.min(1, hbAvg / (60 * 60 * 1000))
    };
  }

  // §9 未アサイン警告: status=未着手 / QUEUED で 担当 AI ブランク の task 数。
  function countUnassignedTasks(tasks) {
    if (!Array.isArray(tasks)) return 0;
    return tasks.filter(function (t) {
      var st = String(t.status || '').toUpperCase();
      if (st !== 'QUEUED' && st !== '未着手' && st !== 'UNASSIGNED') return false;
      var owner = sanitizeLine(t.owner || t.owner_ai || '');
      // 「(停)」 系 (PO 判断 / T*** / 外部) は滞留対象外 (§9.3)
      if (/\(停\)|PO 判断|外部/.test(owner)) return false;
      return owner === '' || owner === '—' || owner.toLowerCase() === 'unassigned';
    }).length;
  }

  // §8 クロスレビュー UI 強制: review 対象は UI で選択不可。
  // 実装側 actor 選択時に review actor pulldown を非表示にするための判定。
  function shouldHideReviewSelector(implOwnerTag) {
    // 実装側が決まれば review 側は cross_review_locked で自動決定 (§8 強制)
    // → review pulldown 非表示 (= UI 変更不可)
    if (!implOwnerTag) return false;
    var t = String(implOwnerTag);
    return /\[(Claude|Codex|subagent):(IMPL|SPEC|OPS)\]/.test(t);
  }


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

  function isPendingConfirmationTask(task) {
    if (!task) return false;
    return String(task.status || '').toUpperCase() === 'PENDING_CONFIRMATION';
  }

  function isProgressVisibleTask(task) {
    return isTaskClickable(task) || isPendingConfirmationTask(task);
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

  function buildPoConfirmationPayload(task) {
    var now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    var date = now.slice(0, 10).replace(/-/g, '');
    var topic = (task.t_id || 'task').toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-po-confirm';
    var poInboxId = topic + '-' + date + '-01';
    var missionId = task.mission_id || task.task_id || '';
    var payload = [
      '---',
      'po_inbox_id: ' + poInboxId,
      'created_at: ' + now,
      'po_intent: ' + sanitizeLine((task.t_id || '') + ' PO 確認済 Gate G event 記録'),
      'suggested_owner: [PO:DECISION]',
      'priority: ' + (task.priority || 'high'),
      'target_app: ' + (task.target_app || 'Dais'),
      'expected_completion_level: PO_DECISION',
      'status: open',
      'claimed_by: ',
      'mission_id: ' + missionId,
      'source: pwa-po-confirmation',
      'verification_gate: verification_gate_po_tap',
      'verification_gate_result: PASS',
      'reason: po_confirmation',
      '---',
      '',
      '# ' + (task.t_id || '') + ' PO confirmation',
      '',
      'PWA 進捗ボードの「PO 確認済」から生成。',
      'PENDING_CONFIRMATION task の Gate G を PASS として記録してください。',
      '',
      '## suggested command',
      '',
      '`sh scripts/devs_status_log_append.sh --task-id ' + missionId + ' --field verification_gate_po_tap --old "" --new PASS --changed-by "[PO:DECISION]" --reason "po_confirmation" --trigger "docs/pwa/app.js"`',
      '',
      '## task 概要',
      '',
      'goal: ' + (task.goal || '(none)'),
      'current status: PENDING_CONFIRMATION',
      ''
    ].join('\n');
    return { poInboxId: poInboxId, payload: payload };
  }

  function taskSearchText(task) {
    return JSON.stringify(task || {}).toLowerCase();
  }

  function countChangedFiles(task) {
    var raw = task && (task.changed_files || task.changedFiles || task.updated_refs || '');
    if (Array.isArray(raw)) return raw.length;
    raw = String(raw || '');
    if (!raw || raw === 'none' || raw === 'なし') return 0;
    if (raw.indexOf(';') >= 0) return raw.split(';').filter(Boolean).length;
    return raw.split(/\s+\/\s+|,\s*/).filter(function (p) { return p.trim(); }).length;
  }

  function countReviewPersonas(task) {
    var raw = task && (task.review_personas || task.reviewPersonas || '');
    if (Array.isArray(raw)) return raw.length;
    return (String(raw || '').match(/REVIEW_PERSONA:[A-Z0-9_]+/g) || []).length;
  }

  function chooseTaskDecompositionPattern(task) {
    var text = taskSearchText(task);
    if (/architecture|アーキ|migration|移行/.test(text)) return 'architecture';
    if (/refactor|リファクタ|再設計/.test(text)) return 'refactor';
    if (/bug|バグ|不具合|再現|fix/.test(text)) return 'bugfix';
    return 'feature';
  }

  function isTaskDecompositionCandidate(task) {
    if (!task || !isTaskClickable(task)) return false;
    var text = taskSearchText(task);
    if (/task_kind.*parent|parent_task|decomposition_parent/.test(text)) return false;
    var hasSpec = /(spec|仕様|要件|設計|schema|スキーマ|acceptance|criteria)/.test(text);
    var hasImpl = /(impl|実装|backend|frontend|test|テスト|deploy|release|push|PR)/i.test(text);
    return (hasSpec && hasImpl) ||
      countChangedFiles(task) >= 5 ||
      countReviewPersonas(task) >= 3 ||
      /(大規模|sub期待値)/.test(text);
  }

  function buildTaskDecompositionPayload(task) {
    var now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    var date = now.slice(0, 10).replace(/-/g, '');
    var topic = (task.t_id || 'task').toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-decompose';
    var poInboxId = topic + '-' + date + '-01';
    var missionId = task.mission_id || task.task_id || '';
    var pattern = chooseTaskDecompositionPattern(task);
    var payload = [
      '---',
      'po_inbox_id: ' + poInboxId,
      'created_at: ' + now,
      'po_intent: ' + sanitizeLine((task.t_id || '') + ' を親子タスク化'),
      'suggested_owner: [Codex:OPS]',
      'priority: ' + (task.priority || 'medium'),
      'target_app: ' + (task.target_app || 'Dais'),
      'expected_completion_level: IMPL_TESTED',
      'status: open',
      'claimed_by: ',
      'mission_id: ' + missionId,
      'source: pwa-task-decomposition',
      'decomposition_pattern: ' + pattern,
      '---',
      '',
      '# ' + (task.t_id || '') + ' parent/child decomposition request',
      '',
      'PWA 進捗ボードの「分解する」から生成。',
      '',
      '## suggested commands',
      '',
      '`sh scripts/devs_task_decomposition_check.sh --task-id ' + missionId + '`',
      '`sh scripts/devs_task_decomposition_apply.sh --task-id ' + missionId + ' --pattern ' + pattern + ' --dry-run`',
      '',
      '## task概要',
      '',
      'goal: ' + (task.goal || '(none)'),
      'status: ' + (task.status || '—'),
      'owner: ' + (task.owner || '—'),
      ''
    ].join('\n');
    return { poInboxId: poInboxId, payload: payload, pattern: pattern };
  }

  function openTaskDecompositionModal(task) {
    if (!isTaskDecompositionCandidate(task)) return false;
    var built = buildTaskDecompositionPayload(task);
    openPrefillModal('親子タスク化を依頼', built.payload, built.poInboxId + '.md');
    return true;
  }

  // ─── T163 / TASK-DAIS-PARENT-CHILD-DETECTOR-IMPL ────────────────────
  // 詳細カード内「関連 task suggest」 section の rendering / 操作。
  //
  // 重要 (T148 §4.2 / 役割境界 不変則):
  //   PWA は detector の suggest を **表示** する だけで、 Mission Queue /
  //   TASK detail / projection を直接 mutate しない。 [Apply] / [Edit] /
  //   [Skip] は それぞれ:
  //     - [Apply] = po_inbox prefill (= 既存 1-site UX を流用)
  //     - [Edit]  = relationship を変更してから po_inbox prefill
  //     - [Skip]  = recordParentChildSkip → verify/parent_child_suggest_skip_log.md
  //   へ流し、 確定書込は scripts/devs_mission_queue_lock.sh +
  //   scripts/devs_mission_register_and_push.sh 経由で行う。
  //
  // task オブジェクトは t_progress.json の各 entry。 projection には
  // `parent_child_suggest` field (= projection-only) が array で乗る:
  //   [{ related_task_id, score, relationship, signals: [..] }, ...]
  function getParentChildSuggestList(task) {
    if (!task) return [];
    var raw = task.parent_child_suggest;
    if (!Array.isArray(raw)) return [];
    return raw.filter(function (s) { return s && s.related_task_id; });
  }

  function buildParentChildAcceptPayload(task, suggestion) {
    if (!task || !suggestion) return null;
    var now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    var date = now.slice(0, 10).replace(/-/g, '');
    var topic = (task.t_id || 'task').toLowerCase().replace(/[^a-z0-9]+/g, '-') +
      '-relate-' + (suggestion.relationship || 'related');
    var poInboxId = topic + '-' + date + '-01';
    var missionId = task.mission_id || task.task_id || '';
    var rel = suggestion.relationship || 'verdict_input_from';
    var related = suggestion.related_task_id || '';
    var score = (typeof suggestion.score === 'number') ? suggestion.score.toFixed(2) : String(suggestion.score || '');
    var signals = Array.isArray(suggestion.signals) ? suggestion.signals.join(' + ') : '';
    var payload = [
      '---',
      'po_inbox_id: ' + poInboxId,
      'created_at: ' + now,
      'po_intent: ' + sanitizeLine((task.t_id || '') + ' に ' + rel + ' = ' + related + ' を追加'),
      'suggested_owner: [Codex:OPS]',
      'priority: ' + (task.priority || 'medium'),
      'target_app: ' + (task.target_app || 'Dais'),
      'expected_completion_level: IMPL_TESTED',
      'status: open',
      'claimed_by: ',
      'mission_id: ' + missionId,
      'source: pwa-parent-child-suggest-accept',
      'parent_child_suggest_score: ' + score,
      'parent_child_suggest_signals: ' + signals,
      '---',
      '',
      '# ' + (task.t_id || '') + ' parent_child_suggest accept',
      '',
      'PWA 詳細カードの「関連 task suggest」から accept。',
      '',
      '## suggested edit',
      '',
      '`instructions/in_flight_topics.md` の `### ' + missionId + '` に',
      '`- **' + rel + '**: ' + related + '` を追記してください。',
      '',
      '## detector context',
      '',
      'score: ' + score,
      'relationship: ' + rel,
      'signals: ' + signals,
      'related_task_id: ' + related,
      '',
      '## task概要',
      '',
      'goal: ' + (task.goal || '(none)'),
      'status: ' + (task.status || '—'),
      'owner: ' + (task.owner || '—'),
      ''
    ].join('\n');
    return { poInboxId: poInboxId, payload: payload, relationship: rel };
  }

  function buildParentChildEditPayload(task, suggestion, overrideRelationship) {
    if (!task || !suggestion) return null;
    var clone = {
      related_task_id: suggestion.related_task_id,
      score: suggestion.score,
      relationship: overrideRelationship || suggestion.relationship,
      signals: suggestion.signals
    };
    var built = buildParentChildAcceptPayload(task, clone);
    if (built) {
      built.payload = built.payload.replace(
        'source: pwa-parent-child-suggest-accept',
        'source: pwa-parent-child-suggest-edit'
      );
    }
    return built;
  }

  function recordParentChildSkip(task, suggestion) {
    // SSoT は触らない。 同 session 内の memo として localStorage に記録し、
    // 永続化 (= verify/parent_child_suggest_skip_log.md への append) は
    // `scripts/devs_parent_child_detector.sh --skip TASK-A:TASK-B` を
    // 呼ぶ手順を payload で示す (= human が CLI で実行)。
    if (!task || !suggestion) return null;
    var key = 'parent_child_suggest_skip:' + (task.mission_id || task.task_id || '') +
      ':' + (suggestion.related_task_id || '');
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(key, new Date().toISOString());
      }
    } catch (e) { /* ignore quota */ }
    return key;
  }

  function openParentChildSkipDialog(task, suggestion) {
    if (!task || !suggestion) return false;
    recordParentChildSkip(task, suggestion);
    var related = suggestion.related_task_id || '';
    var src = task.mission_id || task.task_id || '';
    var hint = [
      '# parent_child_suggest skip 永続化手順',
      '',
      '同一 score の再 suggest を防ぐため、 以下を実行してください:',
      '',
      '`sh scripts/devs_parent_child_detector.sh --skip ' + src + ':' + related + '`',
      '',
      '実行すると `verify/parent_child_suggest_skip_log.md` に append-only で記録されます。',
      'SSoT (Mission Queue / TASK detail / projection) は変更されません。'
    ].join('\n');
    openPrefillModal('関連 task suggest を skip', hint, 'parent_child_suggest_skip_hint.md');
    return true;
  }

  function renderParentChildSuggestSection(task) {
    // 詳細カード描画用 helper。 戻り値 = HTMLElement (= 親要素に append)。
    // task オブジェクトは t_progress.json の entry。
    var section = el('section', {
      class: 'parent-child-suggest',
      'data-section': 'parent_child_suggest',
      'aria-label': '関連 task suggest (T148)'
    });
    section.appendChild(el('h4', { class: 'pcs-title', text: '関連 task suggest (T148)' }));
    var suggestions = getParentChildSuggestList(task);
    if (!suggestions.length) {
      section.appendChild(el('p', {
        class: 'pcs-empty',
        text: '関連 task suggest はありません (= score < 0.3 / detector 未走査)。'
      }));
      return section;
    }
    var list = el('ul', { class: 'pcs-list' });
    suggestions.forEach(function (s) {
      var rel = s.relationship || 'verdict_input_from';
      var rid = s.related_task_id || '';
      var score = (typeof s.score === 'number') ? s.score.toFixed(2) : String(s.score || '');
      var signals = Array.isArray(s.signals) ? s.signals.join(' + ') : '';
      var li = el('li', { class: 'pcs-item' });
      li.appendChild(el('div', {
        class: 'pcs-line',
        text: rel + ': ' + rid + ' (score ' + score + ', signals: ' + signals + ')'
      }));
      var btnApply = el('button', {
        class: 'primary-btn',
        type: 'button',
        'data-action': 'parent_child_suggest_apply',
        'aria-label': rid + ' を ' + rel + ' で受け入れる',
        onclick: function (event) {
          event.stopPropagation();
          var built = buildParentChildAcceptPayload(task, s);
          if (built) openPrefillModal('Apply: ' + rel, built.payload, built.poInboxId + '.md');
        }
      }, 'Apply');
      var btnEdit = el('button', {
        class: 'ghost-btn',
        type: 'button',
        'data-action': 'parent_child_suggest_edit',
        'aria-label': rid + ' の relationship を変更して受け入れる',
        onclick: function (event) {
          event.stopPropagation();
          var alt = window.prompt('relationship を変更 (depends_on / parent_of / parallel_with / verdict_input_from / critical_input_from / clarification_input_from):', rel);
          if (!alt) return;
          var built = buildParentChildEditPayload(task, s, alt);
          if (built) openPrefillModal('Edit: ' + alt, built.payload, built.poInboxId + '.md');
        }
      }, 'Edit');
      var btnSkip = el('button', {
        class: 'ghost-btn',
        type: 'button',
        'data-action': 'parent_child_suggest_skip',
        'aria-label': rid + ' を skip',
        onclick: function (event) {
          event.stopPropagation();
          openParentChildSkipDialog(task, s);
        }
      }, 'Skip');
      li.appendChild(el('div', { class: 'pcs-actions' }, [btnApply, btnEdit, btnSkip]));
      list.appendChild(li);
    });
    section.appendChild(list);
    return section;
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

  function openPoConfirmationModal(task) {
    if (!isPendingConfirmationTask(task)) return false;
    var built = buildPoConfirmationPayload(task);
    openPrefillModal('PO 確認済 Gate G event を生成', built.payload, built.poInboxId + '.md');
    return true;
  }

  function renderProgressBoard() {
    // 進捗 タブ の task row 一覧 (= 既存 iframe 上に追加表示)。
    // QUEUED / IN_PROGRESS / LOCAL_DONE / PENDING_CONFIRMATION を表示。
    // PENDING_CONFIRMATION は PO 確認済 Gate G event を生成する。
    var list = $('#progress-board-list');
    if (!list) return;
    list.innerHTML = '';
    if (STATE.errors.tProgress) {
      list.appendChild(el('li', { class: 'empty', text: 't_progress.json を取得できないため進捗ボードを表示できません。' }));
      return;
    }
    var active = (STATE.tasks || []).filter(isProgressVisibleTask);
    if (!active.length) {
      list.appendChild(el('li', { class: 'empty', text: 'click 対象 (QUEUED / IN_PROGRESS / LOCAL_DONE / PENDING_CONFIRMATION) の task はありません。' }));
      return;
    }
    // status 順 (確認待ち → IN_PROGRESS → QUEUED → LOCAL_DONE) + t_id 降順
    var order = { PENDING_CONFIRMATION: 0, IN_PROGRESS: 1, QUEUED: 2, LOCAL_DONE: 3 };
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
      var pending = isPendingConfirmationTask(t);
      var meta = el('div', { class: 'task-meta', text:
        'owner: ' + (t.owner || '—') + ' · status: ' + st + ' · ' + (pending ? 'PO 確認済で Gate G event' : 'click でアサイン')
      });
      var children = [head, goal, meta];
      if (pending) {
        children.push(el('div', { class: 'assign-buttons' }, [
          el('button', {
            class: 'primary-btn',
            type: 'button',
            'aria-label': (t.t_id || '') + ' を PO 確認済にする',
            onclick: function (event) {
              event.stopPropagation();
              openPoConfirmationModal(t);
            }
          }, 'PO 確認済')
        ]));
      } else if (isTaskDecompositionCandidate(t)) {
        children.push(el('div', { class: 'assign-buttons' }, [
          el('button', {
            class: 'ghost-btn',
            type: 'button',
            'aria-label': (t.t_id || '') + ' を親子タスク化',
            onclick: function (event) {
              event.stopPropagation();
              openTaskDecompositionModal(t);
            }
          }, '分解する')
        ]));
      }
      // row 自体を clickable に。 keyboard accessibility 用に role="button" + tabindex=0。
      var row = el('li', {
        class: 'task-clickable' + (pending ? ' task-pending-confirmation' : ''),
        role: 'button',
        tabindex: '0',
        'aria-label': pending ? (t.t_id || '') + ' を PO 確認済にする' : (t.t_id || '') + ' をアサイン',
        data: { taskId: t.t_id || '', missionId: t.mission_id || '', status: st }
      }, children);
      // click handler (進捗 row click → modal)。
      row.addEventListener('click', function () {
        if (isPendingConfirmationTask(t)) openPoConfirmationModal(t);
        else openTaskAssignModal(t);
      });
      // keyboard (Enter / Space) でも 起動 (= a11y)。
      row.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          if (isPendingConfirmationTask(t)) openPoConfirmationModal(t);
          else openTaskAssignModal(t);
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
  //     mission_id が `TASK-{APP_UPPER}[-V0]-PHASE<N>-...` パターン のもの から
  //     status (DONE / LOCAL_DONE / IN_PROGRESS / QUEUED / BLOCKED) 件数 を 集計。
  //     Phase pattern が無い App は 全 task の status 件数 (= 全体 進捗) を fallback 表示。
  //   - retrofit 進捗: STATE.retrofitStatus (= retrofit_status.json projection)。
  //     publish 経路で配信されない場合は 「未取得」 placeholder。
  //   - violation count: STATE.tasks 親 JSON に violation_summary が在る場合 read。
  //     無ければ 「集計未配備」 placeholder (= verify/adv_violation_log.md は
  //     SSoT で publish 経路に projection が無いため、 後続 mission で 集計 endpoint 追加候補)。
  function appUpperKey(app) {
    return String(app || '')
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
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
        // phase_status (= TASK-{APP_UPPER}[-V0]-PHASE<N>-... のみ)
        var upper = appUpperKey(app);
        var phaseRe = new RegExp('^TASK-' + upper + '(?:-[A-Z0-9]+)?-PHASE([0-9]+)(?:-|$)', 'i');
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

  // ─── T139 Mission Graph view ─────────────────────────────────────────
  // PO 直命 2026-05-09「Task 同士を結ぶ仕組み、 親子関係 + 並列 OK 一目」 反映。
  // depends_on / parent_of / parallel_with / critical_input_from /
  // clarification_input_from / verdict_input_from を視覚化。
  // - 各 task = node (= 縦並び card)
  // - depends_on / parent_of edge = 矢印で連結 (= ASCII / character glyph で表現)
  // - parallel_with = 横並び (= sibling chip)
  // - critical_input_from がある task = 赤枠 (.graph-blocked)
  function parseGraphList(value) {
    // value 例: "TASK-A / TASK-B / TASK-C" or "[TASK-A, TASK-B]" or "none"
    // → ["TASK-A", "TASK-B", "TASK-C"]
    if (!value) return [];
    var s = String(value).trim();
    if (!s || /^(none|なし|-|n\/a|\[\])$/i.test(s)) return [];
    var ids = s.match(/TASK-[A-Z0-9_-]+/g);
    return ids || [];
  }

  function computeMissionGraph(tasks) {
    // tasks = STATE.tasks (= t_progress.json tasks[] each with .graph)
    // returns: array of node objects sorted by t_id desc, each with edges resolved.
    var nodes = (tasks || []).map(function (t) {
      var g = t.graph || {};
      return {
        t_id: t.t_id || '',
        mission_id: t.mission_id || '',
        status: String(t.status || '').toUpperCase(),
        target_app: t.target_app || '',
        goal: t.goal || '',
        depends_on: parseGraphList(g.depends_on),
        parent_of: parseGraphList(g.parent_of),
        parallel_with: parseGraphList(g.parallel_with),
        verdict_input_from: g.verdict_input_from || '',
        critical_input_from: g.critical_input_from || '',
        clarification_input_from: g.clarification_input_from || '',
        is_critical_blocked: false
      };
    });
    // critical_input_from が "none" / 空 以外 で 件数 ≥ 1 を含む = BLOCK 候補
    nodes.forEach(function (n) {
      var c = String(n.critical_input_from || '').trim();
      if (!c || /^(none|なし|-|n\/a)$/i.test(c)) return;
      // critical_input_from の text に「N 件」 が含まれていれば BLOCK 視認
      if (/[1-9][0-9]*\s*件/.test(c)) {
        n.is_critical_blocked = true;
      } else if (c.indexOf('TASK-') === 0 || c.indexOf(':') > 0) {
        n.is_critical_blocked = true;
      }
    });
    // sort: t_id desc (= 大番号先頭、 Mission Queue 表示順序ルール §2.25.31 整合)
    nodes.sort(function (a, b) {
      var an = parseInt(String(a.t_id).replace(/^T/, ''), 10) || 0;
      var bn = parseInt(String(b.t_id).replace(/^T/, ''), 10) || 0;
      return bn - an;
    });
    return nodes;
  }

  function renderMissionGraph() {
    var list = $('#mission-graph-list');
    if (!list) return;
    list.innerHTML = '';
    if (STATE.errors.tProgress) {
      list.appendChild(el('li', { class: 'empty', text: 't_progress.json を取得できないため Mission Graph を表示できません。' }));
      return;
    }
    var nodes = computeMissionGraph(STATE.tasks);
    if (!nodes.length) {
      list.appendChild(el('li', { class: 'empty', text: 'Mission Graph 情報がありません。' }));
      return;
    }
    // graph fields のいずれかが値を持つ task のみ 表示 (= 純 sequential / 孤立 task は省略)
    var withEdges = nodes.filter(function (n) {
      return n.depends_on.length > 0 || n.parent_of.length > 0 ||
             n.parallel_with.length > 0 || n.is_critical_blocked ||
             (n.verdict_input_from && !/^(none|なし|-)$/i.test(n.verdict_input_from)) ||
             (n.clarification_input_from && !/^(none|なし|-)$/i.test(n.clarification_input_from));
    });
    if (!withEdges.length) {
      list.appendChild(el('li', { class: 'empty', text: 'graph fields が設定された task はありません (= propagate 未実行)。' }));
      return;
    }
    withEdges.forEach(function (n) {
      var card = el('li', {
        class: 'mission-graph-card' + (n.is_critical_blocked ? ' graph-blocked' : '')
      });
      // header
      var head = el('div', { class: 'mission-graph-head' }, [
        el('span', { class: 'mission-graph-tid', text: n.t_id }),
        el('span', { class: 'mission-graph-status status-' + n.status.toLowerCase(), text: n.status }),
        el('span', { class: 'mission-graph-app', text: n.target_app || '—' })
      ]);
      card.appendChild(head);
      // mission id (= short)
      card.appendChild(el('div', { class: 'mission-graph-mid', text: n.mission_id }));
      // edges
      var edgeBox = el('div', { class: 'mission-graph-edges' });
      if (n.depends_on.length) {
        edgeBox.appendChild(el('div', { class: 'edge-row edge-depends', text: '↑ depends_on: ' + n.depends_on.join(' / ') }));
      }
      if (n.parent_of.length) {
        edgeBox.appendChild(el('div', { class: 'edge-row edge-parent-of', text: '↓ parent_of: ' + n.parent_of.join(' / ') }));
      }
      if (n.parallel_with.length) {
        var par = el('div', { class: 'edge-row edge-parallel' });
        par.appendChild(el('span', { class: 'edge-label', text: '⇔ parallel_with:' }));
        n.parallel_with.forEach(function (sib) {
          par.appendChild(el('span', { class: 'sibling-chip', text: sib }));
        });
        edgeBox.appendChild(par);
      }
      if (n.verdict_input_from && !/^(none|なし|-)$/i.test(n.verdict_input_from)) {
        edgeBox.appendChild(el('div', { class: 'edge-row edge-verdict', text: '⌥ verdict_input_from: ' + n.verdict_input_from }));
      }
      if (n.is_critical_blocked) {
        edgeBox.appendChild(el('div', { class: 'edge-row edge-critical', text: '⚠ critical_input_from: ' + n.critical_input_from }));
      } else if (n.critical_input_from && !/^(none|なし|-)$/i.test(n.critical_input_from)) {
        edgeBox.appendChild(el('div', { class: 'edge-row edge-critical', text: '? critical_input_from: ' + n.critical_input_from }));
      }
      if (n.clarification_input_from && !/^(none|なし|-)$/i.test(n.clarification_input_from)) {
        edgeBox.appendChild(el('div', { class: 'edge-row edge-clarification', text: '? clarification_input_from: ' + n.clarification_input_from }));
      }
      card.appendChild(edgeBox);
      list.appendChild(card);
    });
  }

  // ─── T163: 関連 task suggest list (親子・並列・input 候補) ───────────
  // STATE.tasks の各 entry の projection-only field `parent_child_suggest` を
  // 集約して 詳細カード を 1 つ ずつ 描画 する。
  function renderParentChildSuggestList() {
    var list = $('#parent-child-suggest-list');
    if (!list) return;
    list.innerHTML = '';
    if (STATE.errors.tProgress) {
      list.appendChild(el('li', { class: 'empty', text: 't_progress.json を取得できないため関連 task suggest を表示できません。' }));
      return;
    }
    var tasks = (STATE.tasks || []).filter(function (t) {
      var arr = t && t.parent_child_suggest;
      return Array.isArray(arr) && arr.length;
    });
    if (!tasks.length) {
      list.appendChild(el('li', {
        class: 'empty',
        text: '関連 task suggest はありません (= detector 未走査 / score < 0.3 のみ)。'
      }));
      return;
    }
    tasks.forEach(function (t) {
      var card = el('li', { class: 'parent-child-suggest-card' });
      card.appendChild(el('div', { class: 'pcs-card-head' }, [
        el('span', { class: 'pcs-card-tid', text: t.t_id || '' }),
        el('span', { class: 'pcs-card-mid', text: t.mission_id || '' })
      ]));
      card.appendChild(renderParentChildSuggestSection(t));
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
  // ─── T172 assign_settings UI render ────────────────────────────────
  // §3.1 ページトップ toggle / §4 priority プルダウン / §9 未アサインバッジ /
  // §12.2 設定画面 (4 階層 UI)。
  function renderAssignSettingsUI() {
    var s = STATE.assignSettings || defaultAssignSettings();
    // toggle (= 自動アサイン ON/OFF)
    var toggleEl = $('#assign-settings-toggle');
    if (toggleEl) {
      toggleEl.checked = !!s.auto_assign_enabled;
      toggleEl.setAttribute('aria-checked', s.auto_assign_enabled ? 'true' : 'false');
    }
    // priority pulldown (= グローバル impl デフォルト)
    var prioEl = $('#assign-settings-priority');
    if (prioEl) {
      prioEl.value = (s.global && s.global.impl) || 'load_balance';
    }
    // 未アサイン件数バッジ (§9、 5 件閾値)
    var badgeEl = $('#assign-unassigned-badge');
    if (badgeEl) {
      var count = countUnassignedTasks(STATE.tasks || []);
      var threshold = s.unassigned_warning_threshold || 5;
      if (count >= threshold) {
        badgeEl.hidden = false;
        badgeEl.textContent = '⚠️ 未アサインタスク ' + count + ' 件';
        badgeEl.className = 'assign-unassigned-badge ' +
          (count >= 10 ? 'badge-red' : 'badge-yellow');
      } else {
        badgeEl.hidden = true;
        badgeEl.textContent = '';
      }
    }
    // 設定詳細 (§12.2)
    var detailEl = $('#assign-settings-detail');
    if (detailEl) {
      // 各 by_kind / by_app の現状値を読み出し表示 (UI from data)
      ['impl_medium', 'impl_large', 'ops'].forEach(function (k) {
        var sel = detailEl.querySelector('[data-kind="' + k + '"]');
        if (sel) sel.value = (s.by_kind && s.by_kind[k]) || '';
      });
      ['lais', 'mais', 'dais'].forEach(function (a) {
        var sel = detailEl.querySelector('[data-app="' + a + '"]');
        if (sel) sel.value = (s.by_app && s.by_app[a]) || '';
      });
    }
    renderAssignTaskOverrides(s);
    // §8 review pulldown 非表示確認: index.html で初期描画時から hidden、 ここで強制
    var reviewSel = $('#assign-settings-review-selector');
    if (reviewSel) {
      reviewSel.hidden = true;
      reviewSel.style.display = 'none';
    }
  }

  function priorityLabel(value) {
    if (value === 'claude_priority') return 'Claude 優先';
    if (value === 'codex_priority') return 'Codex 優先';
    if (value === 'load_balance') return '負荷分散';
    if (value === 'cross_review_locked') return 'クロスレビュー固定';
    return value || '(未指定)';
  }

  function normalizeAssignTaskKey(raw) {
    var v = String(raw || '').trim();
    return v.replace(/\s+/g, '');
  }

  function renderAssignTaskOverrides(settings) {
    var list = $('#assign-settings-task-list');
    if (!list) return;
    list.innerHTML = '';
    var byTask = (settings && settings.by_task) || {};
    var keys = Object.keys(byTask).filter(function (k) { return !!byTask[k]; }).sort();
    if (!keys.length) {
      list.appendChild(el('li', { class: 'empty', text: 'タスク別 override なし' }));
      return;
    }
    keys.forEach(function (key) {
      var li = el('li', { class: 'assign-task-override-item' });
      li.appendChild(el('span', { text: key + ' → ' + priorityLabel(byTask[key]) }));
      li.appendChild(el('button', {
        class: 'ghost-btn',
        type: 'button',
        'data-task-override-remove': key,
        onclick: function (event) {
          event.stopPropagation();
          STATE.assignSettings = STATE.assignSettings || defaultAssignSettings();
          if (!STATE.assignSettings.by_task) STATE.assignSettings.by_task = {};
          delete STATE.assignSettings.by_task[key];
          STATE.assignSettings.updated_at = new Date().toISOString();
          writeAssignSettingsLocal(STATE.assignSettings);
          renderAssignSettingsUI();
          setStatus('タスク別 override を削除: ' + key, 'ok');
        }
      }, '削除'));
      list.appendChild(li);
    });
  }

  function setupAssignSettingsControls() {
    var toggleEl = $('#assign-settings-toggle');
    if (toggleEl) {
      toggleEl.addEventListener('change', function () {
        STATE.assignSettings = STATE.assignSettings || defaultAssignSettings();
        STATE.assignSettings.auto_assign_enabled = !!toggleEl.checked;
        STATE.assignSettings.updated_at = new Date().toISOString();
        STATE.assignSettings.updated_by = '[PO:DECISION]';
        // §10 OFF 永続化 (= localStorage で再起動時 OFF 維持)
        writeAssignSettingsLocal(STATE.assignSettings);
        renderAssignSettingsUI();
        setStatus(
          '自動アサイン ' + (toggleEl.checked ? 'ON' : 'OFF') + ' に切替 (= localStorage 永続化)',
          toggleEl.checked ? 'ok' : 'warn'
        );
      });
    }
    var prioEl = $('#assign-settings-priority');
    if (prioEl) {
      prioEl.addEventListener('change', function () {
        STATE.assignSettings = STATE.assignSettings || defaultAssignSettings();
        if (!STATE.assignSettings.global) STATE.assignSettings.global = {};
        STATE.assignSettings.global.impl = prioEl.value;
        STATE.assignSettings.global.review = 'cross_review_locked'; // §8 強制
        STATE.assignSettings.updated_at = new Date().toISOString();
        STATE.assignSettings.updated_by = '[PO:DECISION]';
        writeAssignSettingsLocal(STATE.assignSettings);
        renderAssignSettingsUI();
        setStatus('実装系デフォルト = ' + prioEl.value, 'ok');
      });
    }
    // 詳細 by_kind / by_app handler
    var detailEl = $('#assign-settings-detail');
    if (detailEl) {
      detailEl.querySelectorAll('select[data-kind]').forEach(function (sel) {
        sel.addEventListener('change', function () {
          STATE.assignSettings = STATE.assignSettings || defaultAssignSettings();
          if (!STATE.assignSettings.by_kind) STATE.assignSettings.by_kind = {};
          STATE.assignSettings.by_kind[sel.dataset.kind] = sel.value || null;
          STATE.assignSettings.updated_at = new Date().toISOString();
          writeAssignSettingsLocal(STATE.assignSettings);
        });
      });
      detailEl.querySelectorAll('select[data-app]').forEach(function (sel) {
        sel.addEventListener('change', function () {
          STATE.assignSettings = STATE.assignSettings || defaultAssignSettings();
          if (!STATE.assignSettings.by_app) STATE.assignSettings.by_app = {};
          STATE.assignSettings.by_app[sel.dataset.app] = sel.value || null;
          STATE.assignSettings.updated_at = new Date().toISOString();
          writeAssignSettingsLocal(STATE.assignSettings);
        });
      });
    }
    var taskAdd = $('#assign-settings-task-add');
    if (taskAdd) {
      taskAdd.addEventListener('click', function () {
        var idEl = $('#assign-settings-task-id');
        var prioEl = $('#assign-settings-task-priority');
        var key = normalizeAssignTaskKey(idEl && idEl.value);
        var prio = prioEl && prioEl.value;
        if (!key || !prio) {
          setStatus('タスク別 override は Task ID と priority を指定してください', 'warn');
          return;
        }
        STATE.assignSettings = STATE.assignSettings || defaultAssignSettings();
        if (!STATE.assignSettings.by_task) STATE.assignSettings.by_task = {};
        STATE.assignSettings.by_task[key] = prio;
        STATE.assignSettings.updated_at = new Date().toISOString();
        STATE.assignSettings.updated_by = '[PO:DECISION]';
        writeAssignSettingsLocal(STATE.assignSettings);
        if (idEl) idEl.value = '';
        if (prioEl) prioEl.value = '';
        renderAssignSettingsUI();
        setStatus('タスク別 override を保存: ' + key + ' → ' + priorityLabel(prio), 'ok');
      });
    }
  }

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

    // T172 / TASK-DAIS-ASSIGN-SETTINGS-IMPL: assign_settings.json を fetch 後、
    // localStorage の OFF 永続化値と merge (= §10 + §11.2 schema)。
    jobs.push(fetchJson(PATHS.assignSettings()).then(function (d) {
      var local = readAssignSettingsLocal();
      STATE.assignSettings = mergeAssignSettings(d, local);
    }).catch(function (err) {
      console.warn('assign_settings fetch failed (default + localStorage 使用):', err);
      var local = readAssignSettingsLocal();
      STATE.assignSettings = mergeAssignSettings(null, local);
      STATE.errors.assignSettings = true;
    }));

    return Promise.all(jobs).then(function () {
      STATE.lastFetch = new Date();
      renderAgents();
      renderTasks();
      renderOutbox();
      renderRules();
      renderProgressSummary();
      renderAppView();
      renderMissionGraph(); // T139: Mission Graph 親子 / 並列 / verdict propagate
      renderParentChildSuggestList(); // T163: 詳細カード「関連 task suggest」 section
      renderProgressBoard(); // T128 拡張: 進捗 row click → modal 起動
      renderAssignSettingsUI(); // T172: assign_settings UI (toggle + priority + 警告バッジ + 詳細)
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
    setupAssignSettingsControls(); // T172: assign_settings (§3 toggle + §4 priority + §12 詳細)
    // T172: 起動直後に localStorage 永続化値を即座反映 (= 再起動時 OFF 維持、 §10)
    var localBoot = readAssignSettingsLocal();
    if (localBoot) {
      STATE.assignSettings = mergeAssignSettings(STATE.assignSettings, localBoot);
      renderAssignSettingsUI();
    }

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
