#!/usr/bin/env node
/**
 * Local `!`-command output regression (compiled lib): the transcript shows one
 * row per output line, with terminal structure (leading spaces and column
 * runs) preserved, ANSI stripped, tabs expanded, width capped in CELLS, and
 * overflow counted instead of silently flattened into a single row.
 *
 * Why this exists: `runLocal` used to feed the WHOLE output to preview(),
 * whose whitespace fold (`\s+` → ' ') turned `ls -al` into one giant line and
 * then cut it at the 240-character preview budget — the reported symptom.
 *
 * Run after build: `node scripts/verify-local-output.mjs`
 */
import { readFileSync } from 'node:fs'
import {
  LOCAL_OUTPUT_LIMIT,
  localOutputLines,
  MAX_LOCAL_OUTPUT_LINES,
  preview,
} from '../lib/types/channel/transcript.js'
import { previewLocalLine } from '../lib/types/channel/sanitize.js'

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

// ── A. one row per line, columns survive ────────────────────────────────────
const ls = [
  'total 8',
  'drwxr-xr-x@  3 me  staff   96 Oct 22 16:26 .',
  '-rw-r--r--@  1 me  staff  100 Oct 22 16:26 a.txt',
].join('\n')
const listing = localOutputLines(ls)
check('A1 ls -al keeps its three lines', listing.lines.length === 3, `${listing.lines.length}`)
check(
  'A2 column runs survive (no whitespace fold)',
  listing.lines[1] === 'drwxr-xr-x@  3 me  staff   96 Oct 22 16:26 .',
  JSON.stringify(listing.lines[1]),
)
check('A3 short output omits nothing', listing.omitted === 0)

// ── B. per-line sanitation ─────────────────────────────────────────────────
const dirty = '\u001b[31m  red\u001b[0m\tcell   '
check(
  'B1 ANSI stripped, tab expanded, trailing blanks trimmed, leading spaces kept',
  previewLocalLine(dirty, 80) === '  red        cell',
  JSON.stringify(previewLocalLine(dirty, 80)),
)
check(
  'B2 OSC title strip',
  previewLocalLine('\u001b]0;title\u0007text', 80) === 'text',
  JSON.stringify(previewLocalLine('\u001b]0;title\u0007text', 80)),
)

// ── C. cell budget, not string length ──────────────────────────────────────
check(
  'C1 CJK truncates on a cell boundary',
  previewLocalLine('世'.repeat(10), 10) === '世世世世…',
  JSON.stringify(previewLocalLine('世'.repeat(10), 10)),
)
check(
  'C2 ASCII cap fills the budget with the ellipsis',
  previewLocalLine('x'.repeat(300), 240) === `${'x'.repeat(239)}…`,
  `${previewLocalLine('x'.repeat(300), 240).length} chars`,
)

// ── D. line budget + blank-line structure ──────────────────────────────────
const many = Array.from({ length: 5 }, (_, i) => `line ${i}`).join('\n')
const capped = localOutputLines(many, LOCAL_OUTPUT_LIMIT, 3)
check('D1 line cap keeps the first N', capped.lines.length === 3, `${capped.lines.length}`)
check('D2 omitted counts the rest', capped.omitted === 2, `${capped.omitted}`)
const blank = localOutputLines('a\n\nb')
check(
  'D3 internal blank line stays a row',
  blank.lines.length === 3 && blank.lines[1] === '',
  JSON.stringify(blank.lines),
)
check('D4 CRLF splits without a stray carriage return', localOutputLines('a\r\nb').lines.join('|') === 'a|b')

// ── E. the tool-preview contract is untouched ──────────────────────────────
check('E1 preview() still folds to one line', preview('a\nb', 40) === 'a b')
check('E2 exported line budget is a positive number', MAX_LOCAL_OUTPUT_LINES > 0)

// ── F. wiring: runLocal uses the row splitter, not the flat preview ────────
const localActions = readFileSync(
  new URL('../src/dsh-adapter/channel/core/local-actions.ts', import.meta.url),
  'utf8',
)
check(
  'F1 runLocal routes output through localOutputLines()',
  localActions.includes('localOutputLines(output)') && !localActions.includes('preview(output'),
)

if (failed > 0) {
  console.error(`local-output FAILED: ${failed} check(s)`)
  process.exit(1)
}
console.log('local-output: all checks passed')
