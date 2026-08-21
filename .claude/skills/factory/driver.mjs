#!/usr/bin/env node
// .claude/skills/factory/driver.mjs
import { readFileSync } from 'node:fs'
import {
  rankIssues,
  buildConflictGraph,
  renderQueueMarkdown,
  parseQueueMarkdown
} from './lib/queue.mjs'

function readStdin() {
  return readFileSync(0, 'utf8')
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
  }
}

const [, , cmd] = process.argv
if (!cmd || !commands[cmd]) {
  process.stderr.write(`Usage: driver.mjs <${Object.keys(commands).join('|')}>\n`)
  process.exit(1)
}
commands[cmd]()
