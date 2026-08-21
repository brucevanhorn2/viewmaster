#!/usr/bin/env node
// .claude/skills/factory/driver.mjs
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  rankIssues,
  buildConflictGraph,
  nextIssue,
  nextSlot,
  renderQueueMarkdown,
  parseQueueMarkdown
} from './lib/queue.mjs'
import { FACTORY_LABELS, computeLabelTransition } from './lib/labels.mjs'

function readStdin() {
  return readFileSync(0, 'utf8')
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..', '..', '..')
const QUEUE_PATH = join(REPO_ROOT, '.claude', 'factory', 'queue.md')

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', cwd: REPO_ROOT })
}

const commands = {
  rank() {
    const { entries } = JSON.parse(readStdin())
    process.stdout.write(JSON.stringify(rankIssues(entries), null, 2) + '\n')
  },
  conflicts() {
    const { entries } = JSON.parse(readStdin())
    process.stdout.write(JSON.stringify(buildConflictGraph(entries), null, 2) + '\n')
  },
  'render-queue'() {
    const state = JSON.parse(readStdin())
    process.stdout.write(renderQueueMarkdown(state))
  },
  'parse-queue'() {
    const text = readStdin()
    process.stdout.write(JSON.stringify(parseQueueMarkdown(text), null, 2) + '\n')
  },
  'write-queue'() {
    const state = JSON.parse(readStdin())
    const ranked = rankIssues(state.entries)
    const toWrite = { ...state, entries: ranked }
    mkdirSync(dirname(QUEUE_PATH), { recursive: true })
    writeFileSync(QUEUE_PATH, renderQueueMarkdown(toWrite))
    process.stdout.write(`Wrote ${QUEUE_PATH}\n`)
  },
  'next-issue'() {
    const text = readFileSync(QUEUE_PATH, 'utf8')
    const state = parseQueueMarkdown(text)
    const ranked = rankIssues(state.entries)
    const queuedIssues = JSON.parse(
      gh(['issue', 'list', '--label', 'factory:queued', '--state', 'open', '--json', 'number', '--limit', '1000'])
    ).map((i) => i.number)
    const executingIssues = JSON.parse(
      gh(['issue', 'list', '--label', 'factory:executing', '--state', 'open', '--json', 'number', '--limit', '1000'])
    ).map((i) => i.number)
    const chosen = nextIssue(ranked, state.conflicts, { queuedIssues, executingIssues })
    process.stdout.write(chosen === null ? 'none\n' : `${chosen}\n`)
  },
  'next-slot'() {
    const state = parseQueueMarkdown(readFileSync(QUEUE_PATH, 'utf8'))
    const planReadyIssues = JSON.parse(
      gh(['issue', 'list', '--label', 'factory:plan-ready', '--state', 'open', '--json', 'number', '--limit', '1000'])
    ).map((i) => i.number)
    const executingIssues = JSON.parse(
      gh(['issue', 'list', '--label', 'factory:executing', '--state', 'open', '--json', 'number', '--limit', '1000'])
    ).map((i) => i.number)
    const chosen = nextSlot(planReadyIssues, state.conflicts, executingIssues, state.cap)
    process.stdout.write(chosen === null ? 'none\n' : `${chosen}\n`)
  },
  'setup-labels'() {
    for (const label of FACTORY_LABELS) {
      try {
        gh(['label', 'create', label, '--color', 'ededed', '--force'])
        process.stdout.write(`ensured label ${label}\n`)
      } catch (err) {
        process.stderr.write(`failed to create ${label}: ${err.message}\n`)
        process.exitCode = 1
      }
    }
  },
  'list-open-issues'() {
    const all = JSON.parse(
      gh(['issue', 'list', '--state', 'open', '--json', 'number,title,body,url,labels', '--limit', '1000'])
    )
    // Exclude issues that are past factory:queued in the pipeline, but still
    // include issues currently at factory:queued so re-running triage can
    // re-rank them alongside brand-new issues instead of stranding them.
    const excludeLabels = FACTORY_LABELS.filter((l) => l !== 'factory:queued')
    const untriaged = all.filter((i) => !i.labels.some((l) => excludeLabels.includes(l.name)))
    process.stdout.write(JSON.stringify(untriaged, null, 2) + '\n')
  },
  'set-label'() {
    const [issue, newLabel] = process.argv.slice(3)
    if (!issue || !newLabel) throw new Error('usage: set-label <issue> <label>')
    const current = JSON.parse(gh(['issue', 'view', issue, '--json', 'labels'])).labels.map((l) => l.name)
    const { toRemove, toAdd } = computeLabelTransition(current, newLabel)
    if (toRemove.length || toAdd.length) {
      const args = ['issue', 'edit', issue]
      for (const l of toRemove) args.push('--remove-label', l)
      for (const l of toAdd) args.push('--add-label', l)
      gh(args)
    }
    process.stdout.write(`#${issue}: -${toRemove.join(',')} +${toAdd.join(',')}\n`)
  },
  'create-worktree'() {
    const [issue, slug] = process.argv.slice(3)
    if (!issue || !slug) throw new Error('usage: create-worktree <issue> <slug>')
    const branch = `worktree-issue-${issue}-${slug}`
    const path = join('.claude', 'worktrees', `issue-${issue}-${slug}`)
    execFileSync('git', ['worktree', 'add', path, '-b', branch], { cwd: REPO_ROOT, stdio: 'inherit' })
    process.stdout.write(`${path}\n`)
  },
  'create-pr'() {
    const [issue, branch, title] = process.argv.slice(3)
    if (!issue || !branch || !title) throw new Error('usage: create-pr <issue> <branch> <title>')
    const existing = JSON.parse(gh(['pr', 'list', '--head', branch, '--state', 'open', '--json', 'url']))
    if (existing.length) {
      process.stdout.write(`${existing[0].url}\n`)
      return
    }
    const url = gh(['pr', 'create', '--head', branch, '--title', title, '--body', `Resolves #${issue}`]).trim()
    process.stdout.write(`${url}\n`)
  },
  'mark-review-round'() {
    const [issue] = process.argv.slice(3)
    if (!issue) throw new Error('usage: mark-review-round <issue>')
    gh(['issue', 'comment', issue, '--body', 'factory:review-round'])
    process.stdout.write('posted\n')
  },
  'count-review-rounds'() {
    const [issue] = process.argv.slice(3)
    if (!issue) throw new Error('usage: count-review-rounds <issue>')
    const data = JSON.parse(gh(['issue', 'view', issue, '--json', 'comments']))
    const count = data.comments.filter((c) => c.body === 'factory:review-round').length
    process.stdout.write(`${count}\n`)
  },
  status() {
    let executingCount = 0
    for (const label of FACTORY_LABELS) {
      const issues = JSON.parse(
        gh(['issue', 'list', '--label', label, '--state', 'open', '--json', 'number,title', '--limit', '1000'])
      )
      if (label === 'factory:executing') executingCount = issues.length
      process.stdout.write(`${label} (${issues.length}):\n`)
      for (const i of issues) process.stdout.write(`  #${i.number} ${i.title}\n`)
    }
    if (existsSync(QUEUE_PATH)) {
      const state = parseQueueMarkdown(readFileSync(QUEUE_PATH, 'utf8'))
      process.stdout.write(`executing ${executingCount}/${state.cap} slots\n`)
    }
  }
}

const [, , cmd] = process.argv
if (!cmd || !commands[cmd]) {
  process.stderr.write(`Usage: driver.mjs <${Object.keys(commands).join('|')}>\n`)
  process.exit(1)
}
commands[cmd]()
