// Guard: the repository must keep LF line endings pinned.
//
// This repo is a DSH plugin published onto npm. The host has
// `core.autocrlf=true`, so without a committed .gitattributes Git checks text
// files out as CRLF while npm packs them as LF, and every worktree file then
// differs from the installed/published copy by one byte per line, which made
// worktree hashes impossible to compare against an installed package.
//
// These assertions fail if that drift is reintroduced (e.g. .gitattributes is
// deleted, or a file is committed with CRLF).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' })
}

// Allowed eol states for git-classified files:
//   lf    - all-LF text (the pinned state)
//   -text - git says binary (protected by .gitattributes `binary`)
//   none  - single-line file with no line terminator at all (e.g. *.map);
//           nothing to normalize, CRLF drift is impossible
const OK_WORKTREE = new Set(['w/lf', 'w/-text', 'w/none'])
const OK_INDEX = new Set(['i/lf', 'i/-text', 'i/none'])

function eolOffenders(prefix, allowed) {
  const out = git(['ls-files', '--eol'])
  const offenders = []
  for (const line of out.split(/\r?\n/)) {
    if (!line.trim()) continue
    const [meta, ...rest] = line.split('\t')
    const file = rest.join('\t')
    if (!file) continue
    const eol = meta.trim().split(/\s+/).find((c) => c.startsWith(prefix))
    if (eol && !allowed.has(eol)) offenders.push(`${file} (${eol})`)
  }
  return offenders
}

test('.gitattributes pins LF for all text files', () => {
  const attrs = readFileSync(join(root, '.gitattributes'), 'utf8')

  assert.match(
    attrs,
    /^\*[ \t]+text=auto[ \t]+eol=lf[ \t]*$/m,
    '.gitattributes must contain a "* text=auto eol=lf" rule',
  )
  assert.doesNotMatch(attrs, /^\uFEFF/, '.gitattributes must not start with a BOM')
})

test('.gitattributes itself is stored with LF endings', () => {
  const raw = readFileSync(join(root, '.gitattributes'))
  assert.equal(raw.includes(0x0d), false, '.gitattributes must not contain CR bytes')
})

test('no tracked text file is checked out with CRLF', () => {
  const offenders = eolOffenders('w/', OK_WORKTREE)
  assert.deepEqual(
    offenders,
    [],
    `tracked files must not be CRLF in the worktree, found: ${offenders.join(', ')}`,
  )
})

test('no tracked text file is stored with CRLF in the index', () => {
  const offenders = eolOffenders('i/', OK_INDEX)
  assert.deepEqual(
    offenders,
    [],
    `tracked files must not be CRLF in the index, found: ${offenders.join(', ')}`,
  )
})
