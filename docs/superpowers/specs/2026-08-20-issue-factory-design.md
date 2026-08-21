# View Master — Issue Factory (Design Spec)

**Date:** 2026-08-20
**Status:** Approved
**Resolves:** internal tooling request (no GitHub issue — this spec produces the
tooling, not an app feature). Builds on the per-issue pipeline already proven
by issues #3–#25 (brainstorm → `docs/superpowers/specs/` → `docs/superpowers/plans/`
→ SDD ledger under `.superpowers/sdd/` → `worktree-issue-N-slug` → PR → merge).

## Purpose

Today, working an issue end-to-end is a fully manual sequence of skill
invocations the human drives one step at a time. With up to a few dozen open
issues at once, the bottleneck should be the human's brainstorming time, not
babysitting sequential single-issue runs. This spec adds a triage +
orchestration layer — the "factory" — that: ranks the open-issue backlog for
throughput, runs up to N issues' plan+execution stages concurrently in
separate worktrees, and gates the only two truly human-owned actions (pushing
a branch, merging a PR) behind explicit commands, while letting everything
else advance on its own.

It does not replace or reimplement any existing skill. `brainstorming`,
`writing-plans`, `executing-plans`/`subagent-driven-development`, and
`code-review` are invoked exactly as before; this spec only adds the
scheduler around them.

## Load-bearing decisions

1. **Triage order: bugs first, then ascending difficulty.** Among issues of
   comparable difficulty, prefer the more impactful one, but difficulty
   dominates impact — the goal is maximum issues closed per day, not maximum
   impact per day. Bug-vs-feature and difficulty are both judged by Claude
   reading the issue body and skimming likely-touched code (this repo's open
   issues currently carry no `bug`/`enhancement` labels to lean on).
2. **Parallel-safety is decided by likely file/module overlap, not issue
   text alone.** Each triage candidate gets skimmed for its probable
   touched files; two issues whose probable file sets overlap are marked
   conflicting and never scheduled into concurrently-executing slots
   together. This is a heuristic, not a guarantee — real conflicts are still
   caught at push/merge time (see Error handling).
3. **State lives in two places, not a database.** GitHub issue labels are
   the visible, shareable pipeline stage (`factory:queued`,
   `factory:brainstorming`, `factory:plan-ready`, `factory:executing`,
   `factory:awaiting-push`, `factory:in-review`, `factory:ready-to-merge`,
   `factory:needs-attention`), created once via `gh label create`. A local
   `.claude/factory/queue.md` holds the ordered triage queue and the
   conflict/parallel-group notes — working state, not shipped history.
   `.claude/factory/` is added to `.git/info/exclude`, the same mechanism
   already used for `.claude/worktrees/`.
4. **Only "executing" is capped; brainstorming is not.** The concurrency cap
   (default 3, overridable via `/factory triage --cap N`) limits how many
   issues can have an autonomous plan+execution agent running at once —
   that's the expensive, resource-consuming stage. Brainstorming is
   inherently serial (it's a conversation with one human) and is never
   throttled by the cap: if you approve a brainstormed issue while all
   execution slots are full, its worktree and plan are still produced
   immediately, but it's labeled `factory:plan-ready` instead of
   `factory:executing` — its execution agent queues (FIFO by issue number)
   until a slot frees. Since no polling process exists (see Non-goals), the
   queue is drained opportunistically: `/factory next` and
   `/factory push-done` both check for a `factory:plan-ready` issue whenever
   a slot is free, before doing anything else, and launch its execution
   agent first. This keeps the human never blocked, which is the stated
   goal, without requiring a background watcher.
5. **Push is the only guardrail on what leaves a worktree, and it applies
   every time, not just once.** The human always runs `git push` themselves;
   Claude only ever hands them the exact command. This applies identically
   to the first push (worktree → PR) and to every code-review fix-round
   commit — a review-driven fix is still new code going out, so it re-enters
   the same `awaiting-push` → `push-done` handshake rather than
   self-pushing because "the branch was already approved once."
6. **Merge is a second, separate human checkpoint.** The review loop stops
   at `factory:ready-to-merge` once a review round comes back clean; it
   never merges on its own. This is a deliberate choice over full
   auto-merge, so a human still looks at what actually lands on `main`.
7. **One dispatcher skill, not several.** All factory behavior lives behind
   a single `.claude/skills/factory/SKILL.md`, invoked as
   `/factory <verb> [args]` (`triage`, `next`, `push-done <n>`,
   `review <n>`, `status`). This matches the existing `run-viewmaster`
   skill's shape (one skill, one concern) while keeping the five verbs
   discoverable from one place instead of five.
8. **Triage's skim step is where the actual parallel-agent tooling gets
   used.** `/factory triage` fans out one subagent per open issue
   concurrently (via `Agent` calls or a small `Workflow`) to read the issue
   and skim the codebase, then a single synthesis step assembles the
   ordered queue from all returned `{issue, bug_or_feature, difficulty,
   likely_files[]}` results. This is a barrier by nature (the conflict
   graph needs every result at once) — not a `pipeline()`.
9. **The execution stage runs as a background `Agent`, not inline.** After
   brainstorming is approved, the worktree is created with
   `git worktree add` following the existing `worktree-issue-N-slug`
   naming convention, and a background `Agent` call is launched with that
   worktree's path as its working context to run `writing-plans` then
   `executing-plans`/`subagent-driven-development` unattended. Control
   returns to the human immediately (not blocked on the background agent),
   which is what makes `/factory next` callable again right away for the
   next brainstorm.

## Components

### Label scheme (created once, idempotent setup step)
`factory:queued`, `factory:brainstorming`, `factory:plan-ready`,
`factory:executing`, `factory:awaiting-push`, `factory:in-review`,
`factory:ready-to-merge`, `factory:needs-attention`. An issue carries
exactly one `factory:*` label at a time (the dispatcher swaps it, not adds
to it). No label = not yet triaged. `factory:plan-ready` means brainstormed
and planned (spec + plan + worktree all exist) but not yet executing because
the concurrency cap was full at the time.

### `.claude/factory/queue.md`
Human-readable ledger holding only the *static* triage output: the ranked
queue entries (`{bug_or_feature, difficulty, impact, likely_files}`), the
conflict graph derived from file overlap, and the configured `cap`.
Regenerated wholesale by `/factory triage`. It does not track live pipeline
state (who's currently executing, awaiting push, etc.) — that's always
queried fresh from GitHub labels at command time, so there is exactly one
source of truth for stage and one for ranking, never two copies to drift.

### `/factory triage [--cap N]`
Fans out parallel skim agents over every open issue with no `factory:*`
label. Synthesizes the ordered queue (bugs first, then ascending
difficulty) and the conflict graph. Writes `.claude/factory/queue.md`,
labels each triaged issue `factory:queued`. Idempotent — rerunning
recomputes from current GitHub state without corrupting in-flight issues
(anything already past `queued` is left untouched).

### `/factory next`
First, drains the slot queue: if any issue is `factory:plan-ready` and the
current `factory:executing` count is below `cap`, launches that issue's
(earliest by issue number) execution agent now instead of picking something
new. Otherwise, pops the next `factory:queued` entry that doesn't conflict
with anything currently `factory:executing`. Relabels `factory:brainstorming`.
Runs `superpowers:brainstorming` interactively. On spec approval, proceeds
without further prompting: `writing-plans` → `git worktree add`, then either
launches the background execution agent immediately and relabels
`factory:executing` (slot available) or relabels `factory:plan-ready` and
stops (cap full). Returns control immediately either way.

### Background execution agent
Runs `executing-plans`/`subagent-driven-development` inside the worktree
per the existing SDD convention (task briefs, `progress.md` ledger, review
diffs under `.superpowers/sdd/`). On completing and committing all tasks,
relabels `factory:awaiting-push`, writes the exact `git push` command as an
issue comment, and frees its slot. Nothing automatically fills the freed
slot — the next `/factory next` or `/factory push-done` invocation drains it
(see above; no polling process is introduced). On getting stuck, relabels
`factory:needs-attention` instead of committing incomplete/broken work.

### `/factory push-done <issue>`
First, the same slot-queue drain as `/factory next` — a freed slot from this
issue finishing execution is exactly the common case where a `plan-ready`
issue should start now. Then: relabels `factory:in-review`, opens the PR
(`gh pr create`), runs `code-review` at medium, and addresses findings. Each
round of fix commits re-enters `awaiting-push` and needs another
`push-done`. Capped at 3 review rounds — a 4th round of new findings stops
and relabels `factory:needs-attention` instead of looping. Clean review →
`factory:ready-to-merge`, stop.

### `/factory review <issue>`
Manually re-triggers a review pass on a `factory:in-review` or
`factory:ready-to-merge` issue (e.g. after the human pushed additional
manual changes).

### `/factory status`
Reads current labels across all open issues plus `queue.md` and prints a
single at-a-glance table: stage per issue, which slots are occupied, what's
waiting on a human push.

## Data flow (single issue's lifecycle)

```
queued
  → /factory next → brainstorming (interactive)
  → spec approved → plan written → worktree created
  → [cap full] plan-ready → (drained by a later /factory next or push-done)
  → executing (background agent)
  → awaiting-push (slot freed)
  → human pushes + /factory push-done
  → in-review: PR opened, code-review loop
      (each fix round → awaiting-push → human push + push-done again)
  → ready-to-merge
  → human merges
```

## Error handling

- A single issue's triage skim failing (inaccessible, agent error) doesn't
  block the rest of the batch — that issue is left unlabeled for manual
  triage.
- A stuck execution agent stops and relabels `factory:needs-attention`
  rather than committing broken or partial work.
- Merge conflicts against `main` discovered at push time (a parallel issue
  merged first and touched overlapping code the conflict-graph heuristic
  missed) are surfaced to the human, not auto-resolved.
- A code-review loop that doesn't converge within 3 rounds stops and flags
  `factory:needs-attention` rather than looping indefinitely.

## Testing / validation

- `/factory triage` is safe to run repeatedly and should be checked against
  human judgment on the first run or two before trusting its ordering on a
  large backlog.
- First real end-to-end run should force `--cap 1` for the first one or two
  issues, to validate the full mechanism (worktree → background execution →
  awaiting-push → push-done → PR → review) before trusting 3-wide
  concurrency.
- No automated test suite is proposed for the factory skill itself — like
  `run-viewmaster`, this is operator tooling validated by using it, not
  application code covered by `vitest`.

## Non-goals

- Auto-merge. Merge stays a human action, always.
- Polling GitHub for push detection. The human explicitly signals via
  `/factory push-done`; no scheduled/background watcher is introduced.
- Reworking the existing single-issue pipeline (`brainstorming`,
  `writing-plans`, `executing-plans`, SDD ledger, `code-review`). This spec
  only schedules and gates those existing stages.
- Cross-repo use. This spec is scoped to the `viewmaster` repo; generalizing
  the `factory` skill to other projects is future work if it proves out
  here.
- Configurable ranking weights beyond the bugs-first/difficulty-ascending
  rule and the `--cap` flag — no config file for tuning the triage formula.
