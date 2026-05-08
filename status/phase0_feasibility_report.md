# T93 Phase 0 Feasibility Report

Mission: TASK-DEVSYS-AGENT-PARALLEL-OPS-PHASE0-FEASIBILITY
Date: 2026-05-08
Owner: [subagent:SPEC] (dispatched by ADV main session, evidence aggregated from subagent run + Claude Code hooks documentation review)

## Context

T92 (E2E test category tag strategy) closed 2026-05-08. During post-completion cleanup, ADV main session detected structural collisions among parallel agents (Claude Code worktree sessions + Codex sessions) that share the same `/Users/futoshi/Desktop/dev-system/` workspace:

1. Auto-generated branch names like `claude/mystifying-chatelet-e814e9` carry no semantic information about agent identity, mission ID, or work purpose. Neither human reviewers nor other agents can disambiguate them.
2. There is no central registry binding `<agent>` × `<mission ID>` × `<branch>` × `<worktree path>`. Each agent only knows its own state.
3. Cleanup decisions rely on `mtime` heuristics ("if no file modified in 30 min, the worktree is stale"). Under continuous parallel work, every worktree always has recent activity, so cleanup is permanently blocked.

Phase 0 must decide which mechanical enforcement strategy to apply for branch naming convention `^(claude|codex|subagent)/T[0-9]+/[a-z0-9-]+$` before T94 (validator implementation), T95 (registry + heartbeat), and T96 (reaper) can proceed.

## Option (a) PostToolUse hook

- Findings:
  - `.claude/settings.json` (currently 4576 bytes) registers `PreToolUse` (1 hook for phase_dependency_claim_check) and `Stop` (4 hooks for adv response gates) only. No `PostToolUse` is currently configured.
  - The matcher field accepts tool names. Existing PreToolUse uses `matcher: "Edit|Write|MultiEdit|NotebookEdit"`.
  - Claude Code public docs (`https://code.claude.com/docs/en/hooks`) list valid PreToolUse / PostToolUse matcher tool names: Bash, Edit, Write, Read, Glob, Grep, Agent, WebFetch, WebSearch, AskUserQuestion, ExitPlanMode + MCP tools.
  - **`EnterWorktree` and `ExitWorktree` are NOT in the PostToolUse matcher whitelist.** This means literal option (a) (PostToolUse on EnterWorktree) is infeasible.
  - **However**, Claude Code provides a dedicated `WorktreeCreate` hook event (separate from PreToolUse / PostToolUse). Per docs:
    - Fires before worktree creation
    - Replaces default git behavior (the harness no longer runs `git worktree add` directly — the hook command is invoked instead)
    - Receives stdin JSON with `branch_name`, `worktree_path`, `original_branch`
    - Non-zero exit blocks creation
  - This event is structurally equivalent to what option (a) was reaching for, with **stronger** semantics (replaces creation rather than reacting after).
- Feasibility: **feasible (with corrected event name)**. Option (a) becomes "WorktreeCreate hook in `.claude/settings.json` invoking a script that runs `git worktree add -b <agent>/T<id>/<purpose> <path>` instead of accepting auto-generated branch name".
- Tradeoffs:
  - **Pro**: Enforced at creation time. No race condition with other operations.
  - **Pro**: Strictly stronger than polling (option b) and alias-only (option c).
  - **Pro**: Failure to register convention-compliant name = creation blocked = clear failure signal.
  - **Con**: `WorktreeCreate` cannot rename `branch_name` directly. Hook script must take over the creation entirely. Requires careful shell script.
  - **Con**: Coverage gap. `WorktreeCreate` only fires for Claude Code's worktree creation. Codex sessions or shell-spawned `git worktree add` do NOT trigger it. Those need a fallback (effectively the option-c `branch_alias` mechanism, but only as a degraded fallback for non-Claude-Code worktrees).

## Option (b) Polling rename watcher

- Findings:
  - A background script polling `git worktree list` every ~60s could detect auto-named branches matching `claude/[a-z]+-[a-z]+-[0-9a-f]+` pattern and rename them.
  - To infer the TASK-ID, the watcher would `git log -1 <branch>` and parse `Mission-SSoT-Function:` trailer or session-progress side-effect commits.
  - But: between detection and rename, the harness could create more files, perform commits, or have humans/CI relying on the auto-name. Renaming a live branch breaks `git status` parents and `gh pr` references.
- Feasibility: **partially feasible** but fragile.
- Tradeoffs:
  - **Pro**: No Claude Code internals dependency. Works for Codex / shell / any creation path.
  - **Con**: Race condition window. The harness can re-create worktrees with the same auto-name mid-poll cycle (this was directly observed in T93 cleanup — `.claude/worktrees/` was recreated 2× during a single ADV cleanup pass).
  - **Con**: TASK-ID inference can be wrong if the branch is created before any commits land.
  - **Con**: Renaming a checked-out branch in another session's worktree may break that session.

## Option (c) alias-only fallback

- Findings:
  - Add a `branch_alias:` field to `instructions/in_flight_topics.md` TASK detail. Map `<auto-name>` → `<convention-name>` for display purposes only. Underlying git branch keeps its auto-generated name.
  - All git operations (push, log, status) continue to use auto-name. Only Mission Queue projection (`docs/status/t_progress.json`) and Git Page display use the alias.
- Feasibility: **always feasible** but mechanically weakest.
- Tradeoffs:
  - **Pro**: Zero risk. Pure metadata layer. No git state changes.
  - **Pro**: Works for ALL creation paths (Claude Code / Codex / shell / etc.).
  - **Con**: `git log` / `gh pr list` / CLI `git branch` output stay cryptic. Humans debugging through git native tools see no improvement.
  - **Con**: No mechanical enforcement — agents can ignore the convention and break the alias mapping.
  - **Con**: Effectively documentation, not enforcement.

## 3-layer design verification

- **Layer 1 (long-term SSoT)**: TASK detail in `instructions/in_flight_topics.md` extended with `branch:` / `worktree_path:` / `agent:` / `agent_pid:` / `last_heartbeat:` fields. Update via Edit on existing TASK blocks. No conflict with existing fields.
- **Layer 2 (liveness)**: New file `docs/status/agent_heartbeats.json` (writable, gitignore-watch but committed for cross-session sync). Schema: `{ "<agent>": { "agent_pid": <int>, "last_heartbeat": "<iso8601>", "current_task_id": "<TASK-ID>", "branch": "<branch>", "worktree_path": "<path>" } }`. Updated by `scripts/devs_heartbeat_update.sh` on commit + 5min timer.
- **Layer 3 (per-agent inbox + merger)**: New dir `instructions/agent_inbox/<agent>.md` for append-only per-agent writes. New script `scripts/devs_write_lane_merger.sh` (T95) holds `mission_queue_lock`, reads each inbox, merges into SSoT 4 files atomically, truncates inboxes. This is consistent with the existing global queue-write lock — the merger is the only writer to SSoT 4 files; agents append to their own inbox without contention.
- **Contradictions: none**. The merger script reuses `scripts/devs_mission_queue_lock.sh` for atomic SSoT writes. Agents writing to per-agent inboxes do not conflict because each agent owns its own file.

## DECISION

DECISION: a

Rationale:
- Option (a) with corrected event name `WorktreeCreate` provides creation-time mechanical enforcement.
- Option (b) is fragile under the actual observed race condition (worktree dirs being recreated mid-cleanup).
- Option (c) provides zero enforcement and only fixes the display surface.
- Option (a)'s coverage gap (Codex / shell-spawned worktrees not triggering `WorktreeCreate`) is acceptable because:
  - The dominant collision source observed in T92→T93 cleanup is Claude Code worktree auto-naming.
  - Codex consistently uses convention-compliant names already (`codex/<purpose>` form).
  - For the residual gap, a `branch_alias:` fallback (option-c style mechanism) can be layered on top of option (a) — implementing both as overlapping concerns rather than mutually exclusive choices.

## Phase 1 entry conditions

T94 (TASK-DEVSYS-AGENT-PARALLEL-OPS-BRANCH-NAMING-VALIDATOR) entry conditions per this DECISION:

1. **Hook event name**: register a `WorktreeCreate` event in `.claude/settings.json` (NOT `PostToolUse` matcher on `EnterWorktree`).
2. **Hook script**: implement `scripts/devs_worktree_rename_hook.sh` that reads stdin JSON (`branch_name`, `worktree_path`, `original_branch`), determines the active TASK-ID from environment / Mission Queue, and runs `git worktree add -b <agent>/T<id>/<purpose> <worktree_path>` to take over creation.
3. **Validator**: implement `scripts/devs_branch_name_validator.sh` with regex `^(claude|codex|subagent)/T[0-9]+/[a-z0-9-]+$`. Wire into `scripts/devs_mission_registration_gate.sh` step that BLOCKS push from non-compliant branches.
4. **Validator regex**: must accept legacy auto-generated names (e.g. `claude/charming-mendeleev-32f382`) for grandfathering existing branches via a transition window. Add a deprecation warning rather than BLOCK during the transition.
5. **SSoT field reservation**: T95 will add `branch:` / `worktree_path:` / `agent:` / `agent_pid:` / `last_heartbeat:` fields. T94 must reserve these in `instructions/templates/in_flight_topics.template.md` so generator-created Apps inherit the schema.
6. **Codex / shell coverage gap**: T94 must add a `branch_alias:` field to TASK detail schema for branches that bypass `WorktreeCreate` (shell-spawned, Codex). Display-only fallback.
7. **Realworld smoke test** (per `core_spec.md §3.14` ADV pre-push primary quality gate): T94 verification must include a smoke test that creates a Claude Code worktree, observes the `WorktreeCreate` hook firing, and verifies the resulting branch name matches the convention regex. Cannot be marked LOCAL_DONE without this.

## Notes on report generation

This report was reconstructed from the subagent run summary after the original file was lost to a concurrent worktree branch swap during ADV / Codex parallel operation. The investigation findings (PostToolUse matcher whitelist, `WorktreeCreate` event behavior, settings.json inventory, 3-layer design verification) reflect the subagent's actual research output. The reconstruction is direct-write to the main worktree path to avoid further parallel-swap data loss.
