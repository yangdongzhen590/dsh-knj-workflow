// Guard: the repository must keep LF line endings pinned.
//
// This repo is a DSH plugin published onto npm. The
// host has `core.autocrlf=true`, so without a committed .gitattributes Git checks
// text files out as CRLF while npm packs them as LF 鈥?every worktree file then
// differed from the installed/published copy by one byte per line
// (lib/index.js: 8589 CRLF vs 8475 LF), which made worktree hashes impossible to
// compare against an installed package.
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
  const out = git(['ls-files', '--eol'])
  const offenders = []

  for (const line of out.split(/\r?\n/)) {
    if (!line.trim()) continue
    const [meta, ...rest] = line.split('\t')
    const file = rest.join('\t')
    if (!file) continue

    const wEol = meta.trim().split(/\s+/).find((c) => c.startsWith('w/'))
    // w/-text is git's own "this is binary" classification 鈥?not our concern.
    if (wEol && wEol !== 'w/lf' && wEol !== 'w/-text') {
      offenders.push(`${file} (${wEol})`)
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `tracked text files must be LF in the worktree, found CRLF in: ${offenders.join(', ')}`,
  )
})

test('no tracked text file is stored with CRLF in the index', () => {
  const out = git(['ls-files', '--eol'])
  const offenders = []

  for (const line of out.split(/\r?\n/)) {
    if (!line.trim()) continue
    const [meta, ...rest] = line.split('\t')
    const file = rest.join('\t')
    if (!file) continue

    const iEol = meta.trim().split(/\s+/).find((c) => c.startsWith('i/'))
    if (iEol && iEol !== 'i/lf' && iEol !== 'i/-text') {
      offenders.push(`${file} (${iEol})`)
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `tracked text files must be LF in the index, found CRLF in: ${offenders.join(', ')}`,
  )
})
