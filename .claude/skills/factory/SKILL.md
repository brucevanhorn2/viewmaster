---
name: factory
description: Triage and orchestrate viewmaster's open GitHub issues across brainstorming, autonomous plan+execution in worktrees, and human-gated push/review/merge. Use when the user runs /factory <verb>.
---

# Issue Factory

Dispatcher for the pipeline described in
`docs/superpowers/specs/2026-08-20-issue-factory-design.md` — read that spec
if anything here is ambiguous; it explains *why*, this file is *exactly what
to run*.

Run every command below from the repo root
(`/home/bruce/Projects/viewmaster`) unless a worktree path is given
explicitly. The driver is `.claude/skills/factory/driver.mjs`, always
invoked as `node .claude/skills/factory/driver.mjs <command> [args]`.

Dispatch on the first word of `$ARGUMENTS`.

## `/factory triage [--cap N]`

1. `node .claude/skills/factory/driver.mjs setup-labels` (idempotent, safe every time).
2. `node .claude/skills/factory/driver.mjs list-open-issues` — untriaged open issues as JSON.
3. For each issue returned, spawn a parallel `Agent` call (`subagent_type: "Explore"`) with a prompt along these lines: "Read GitHub issue #<n> in the viewmaster repo — title: <title>, body: <body>. Skim the codebase to judge: (a) bug fix or feature/enhancement, (b) difficulty 1-5 (1 = one small well-contained file, 5 = many files/subsystems or new architecture), (c) impact 1-5, (d) the repo-relative paths it will likely touch. Reply with ONLY this JSON object, no prose: {\"issue\": <n>, \"title\": \"<title>\", \"bugOrFeature\": \"bug\"|\"feature\", \"difficulty\": <1-5>, \"impact\": <1-5>, \"likelyFiles\": [\"...\"]}."
4. Collect the results into `{ entries: [...] }`. Skip and report (don't block on) any issue whose subagent errored or returned invalid JSON.
5. `echo '<json with cap and generatedAt=now added>' | node .claude/skills/factory/driver.mjs write-queue` — `cap` from `--cap` (default 3), `generatedAt` an ISO timestamp, `conflicts` from piping the same entries through `driver.mjs conflicts` first.
6. For each entry: `node .claude/skills/factory/driver.mjs set-label <issue> factory:queued`.
7. Show the user `.claude/factory/queue.md`'s "Queue (ordered)" section.

## Slot-queue drain (used by both `/factory next` and `/factory push-done`)

Before doing anything else, both verbs below first check for waiting work:

1. `node .claude/skills/factory/driver.mjs next-slot`. If it prints an issue
   number `<m>` (not `none` — this is the earliest by issue number among
   plan-ready issues not conflicting with anything currently executing):
   find its worktree under
   `.claude/worktrees/issue-<m>-*`, launch its background execution agent
   the same way as step 7 of `/factory next` below (same prompt shape,
   pointed at that worktree and `docs/superpowers/plans/` file), and run
   `node .claude/skills/factory/driver.mjs set-label <m> factory:executing`.
   Tell the user issue `<m>` just started executing (a slot freed up).
2. Repeat step 1 until `next-slot` prints `none` (multiple slots could be
   free at once, e.g. right after `/factory triage --cap` was lowered).
3. Continue with the verb's own steps below.

## `/factory next`

0. Run the slot-queue drain above.
1. `node .claude/skills/factory/driver.mjs next-issue`. If it prints `none`, tell the user nothing is eligible right now (empty queue, or everything queued conflicts with what's executing) and stop.
2. Otherwise it prints an issue number `<n>`. `node .claude/skills/factory/driver.mjs set-label <n> factory:brainstorming`.
3. `gh issue view <n> --json title,body,url` for the issue content.
4. Invoke `superpowers:brainstorming` against this issue interactively with the user, exactly as for any other feature request — do not skip its approval gate. This produces `docs/superpowers/specs/<date>-<slug>-design.md`.
5. Once approved, invoke `superpowers:writing-plans` to produce `docs/superpowers/plans/<date>-<slug>.md`.
6. `node .claude/skills/factory/driver.mjs create-worktree <n> <slug>` (same `<slug>` as the spec/plan filename). Note the printed `<worktree-path>`.
7. Check whether a slot is free right now: run `node .claude/skills/factory/driver.mjs next-slot` — since `<n>` isn't labeled `factory:plan-ready` yet, a non-`none` result here means some *other* plan-ready issue is owed the slot first (shouldn't normally happen right after a drain, but handles a race). If it prints `none` because the cap is genuinely full (check via `node .claude/skills/factory/driver.mjs status`, `factory:executing` count `>=` the queue's `cap`), run `node .claude/skills/factory/driver.mjs set-label <n> factory:plan-ready` and tell the user `<n>` is planned and worktree-ready, queued for the next available slot — stop here for this issue. Otherwise (a slot is genuinely free): launch a background `Agent` call (`run_in_background: true`, `subagent_type: "general-purpose"`) with a self-contained prompt stating: the absolute `<worktree-path>` to run all Bash commands from; to invoke `superpowers:subagent-driven-development` to execute `docs/superpowers/plans/<date>-<slug>.md` in full; that on completion (all tasks committed) it must NOT push, but instead print the exact `git push -u origin worktree-issue-<n>-<slug>` command, then — from the repo root, not the worktree — run `node .claude/skills/factory/driver.mjs set-label <n> factory:awaiting-push` and `gh issue comment <n> --body "Ready to push. Run: git push -u origin worktree-issue-<n>-<slug>"`; and that if it gets stuck, it must instead run `node .claude/skills/factory/driver.mjs set-label <n> factory:needs-attention` and explain why in an issue comment, rather than committing incomplete or broken work. Then run `node .claude/skills/factory/driver.mjs set-label <n> factory:executing`.
8. Tell the user what happened to `<n>` (executing now, or plan-ready and queued) and that `/factory next` is immediately safe to run again for the following issue.

## `/factory push-done <issue>`

0. Run the slot-queue drain above.
1. `gh issue view <issue> --json labels` — confirm it's currently `factory:awaiting-push`; if not, tell the user and stop.
2. `node .claude/skills/factory/driver.mjs set-label <issue> factory:in-review`.
3. Read the branch name from the worktree directory under `.claude/worktrees/issue-<issue>-*` (it's `worktree-issue-<issue>-<slug>`). `node .claude/skills/factory/driver.mjs create-pr <issue> <branch> "<title from the issue>"` (safe to re-run — it reuses an existing open PR for that branch instead of erroring).
4. `node .claude/skills/factory/driver.mjs count-review-rounds <issue>`. If the count is already `3` or more, skip review entirely: run `node .claude/skills/factory/driver.mjs set-label <issue> factory:needs-attention` and tell the user review isn't converging, then stop.
5. Otherwise invoke `code-review` at medium effort against this PR's diff.
6. If it finds issues: address them (commit fixes in the worktree), run `node .claude/skills/factory/driver.mjs mark-review-round <issue>` to record that this round happened, then `node .claude/skills/factory/driver.mjs set-label <issue> factory:awaiting-push`, print the push command, and stop — tell the user to push and re-run `/factory push-done <issue>`.
7. If review is clean: `node .claude/skills/factory/driver.mjs set-label <issue> factory:ready-to-merge` and tell the user the PR is ready for them to merge.

## `/factory review <issue>`

Same as steps 4-7 of `/factory push-done` above, for re-running review on demand (e.g. after the user pushed manual changes) without a fresh push cycle.

## `/factory status`

`node .claude/skills/factory/driver.mjs status` — show the output verbatim.
