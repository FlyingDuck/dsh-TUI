#!/usr/bin/env node
/** Regression coverage for `@` completion in large generated trees (#278). */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createChannel, expandMentions } from '../lib/types/dsh-adapter/channel.js'

const fixture = await mkdtemp(join(tmpdir(), 'dsh-tui-file-completion-'))

function makeAgent() {
  return {
    id: 'file-completion-agent',
    ctx: { on: () => () => {} },
    status: 'idle',
    session: { id: 'file-completion-session', seq: 0, events: [] },
  }
}

const fsService = {
  async resolve(path) {
    return { displayPath: path }
  },
  async stat(target) {
    try {
      const info = await stat(target.displayPath)
      return { type: info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other' }
    } catch {
      return undefined
    }
  },
  async readText(target) {
    return readFile(target.displayPath, 'utf8')
  },
  async listDir(target) {
    const entries = await readdir(target.displayPath, { withFileTypes: true })
    return entries
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(entry => ({
        name: entry.name,
        type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
        target: { displayPath: join(target.displayPath, entry.name) },
      }))
  },
}

try {
  const cmakeFiles = join(fixture, 'build_u22', 'CMakeFiles')
  const cmakePresetFiles = join(fixture, 'cmake-build-debug', 'CMakeFiles')
  const sourceDir = join(fixture, 'src')
  const nestedDir = join(sourceDir, 'nested')
  await mkdir(cmakeFiles, { recursive: true })
  await mkdir(cmakePresetFiles, { recursive: true })
  await mkdir(sourceDir)
  await mkdir(nestedDir)
  const downloadsDir = join(fixture, 'Downloads')
  await mkdir(join(downloadsDir, 'Music'), { recursive: true })
  await mkdir(join(downloadsDir, 'Movies'), { recursive: true })
  await Promise.all([
    ...Array.from({ length: 120 }, (_, index) =>
      writeFile(join(cmakeFiles, `artifact-${String(index).padStart(3, '0')}.o`), ''),
    ),
    writeFile(join(cmakePresetFiles, 'compiler_depend.make'), ''),
    writeFile(join(sourceDir, 'main.cpp'), 'int main() {}\n'),
    writeFile(join(nestedDir, 'nested.cpp'), 'int nested() {}\n'),
    writeFile(join(downloadsDir, 'note.txt'), 'home note\n'),
  ])

  const ctx = {
    on: () => () => {},
    get(name) {
      return name === 'fs' ? fsService : undefined
    },
    logger: { warn() {} },
  }
  const channel = createChannel(ctx, makeAgent(), {
    model: 'test-model',
    provider: 'test-provider',
    cwd: fixture,
    activity: false,
  })

  const files = await channel.listFiles()
  const windowsStyleListing = await channel.listFileCandidates(`${fixture}\\src\\`)
  assert.ok(
    windowsStyleListing.some(entry => entry.path === `${fixture}\\src\\main.cpp`),
    `Windows file completion should preserve the typed separator:\n${windowsStyleListing.map(entry => entry.path).join('\n')}`,
  )
  console.log('PASS: Windows path completion preserves typed separators')
  const windowsStyleDirectoryListing = await channel.listFileCandidates(`${fixture}\\src\\`)
  assert.ok(
    windowsStyleDirectoryListing.some(entry => entry.path === `${fixture}\\src\\nested\\`),
    `directory completion should preserve the typed separator:\n${windowsStyleDirectoryListing.map(entry => entry.path).join('\n')}`,
  )
  console.log('PASS: Windows directory completion preserves the trailing separator')
  assert.ok(
    files.includes('src/main.cpp'),
    `source file was crowded out by generated files:\n${files.join('\n')}`,
  )
  assert.ok(files.every(file => !file.startsWith('build_u22/')))
  assert.ok(files.every(file => !file.startsWith('cmake-build-debug/')))
  console.log('PASS: CMake build output cannot crowd source files out of @ completion')

  const generatedDir = join(fixture, 'generated')
  await mkdir(generatedDir)
  await Promise.all(
    Array.from({ length: 120 }, (_, index) =>
      writeFile(join(generatedDir, `generated-${String(index).padStart(3, '0')}.ts`), ''),
    ),
  )

  const filesWithLargeSibling = await channel.listFiles()
  assert.ok(
    filesWithLargeSibling.includes('src/main.cpp'),
    `an earlier sibling directory consumed the global completion budget:\n${filesWithLargeSibling.join('\n')}`,
  )
  console.log('PASS: a large sibling directory cannot crowd source files out of @ completion')

  const nestedSourceDir = join(sourceDir, 'features', 'editor')
  await mkdir(nestedSourceDir, { recursive: true })
  await writeFile(join(nestedSourceDir, 'view.ts'), 'export const view = true\n')

  const filesWithNestedSource = await channel.listFiles()
  assert.ok(
    filesWithNestedSource.includes('src/features/editor/view.ts'),
    `ordinary nested source exceeded the completion depth limit:\n${filesWithNestedSource.join('\n')}`,
  )
  console.log('PASS: ordinary nested source remains reachable in @ completion')

  // `@~/` used to expand only the BARE home; accepting `Downloads/` and then
  // typing `M` resolved `~/Downloads/M` against the workspace and listed
  // nothing — the reported "no suggestions after picking a directory" bug.
  // Submitted mentions share resolveHomePath(), so they get the same check.
  const originalHome = process.env.HOME
  const originalUserProfile = process.env.USERPROFILE
  try {
    // os.homedir() reads HOME on POSIX and USERPROFILE on Windows.
    process.env.HOME = fixture
    process.env.USERPROFILE = fixture
    const homeListing = await channel.listFileCandidates('~/')
    assert.ok(
      homeListing.some(entry => entry.path === '~/Downloads/'),
      `~/ should list the home directories:\n${homeListing.map(entry => entry.path).join('\n')}`,
    )
    const downloadsListing = await channel.listFileCandidates('~/Downloads/')
    assert.ok(
      downloadsListing.some(entry => entry.path === '~/Downloads/Music/'),
      `~/Downloads/ should list its subdirectories:\n${downloadsListing.map(entry => entry.path).join('\n')}`,
    )
    const narrowed = await channel.listFileCandidates('~/Downloads/M')
    assert.ok(
      narrowed.some(entry => entry.path === '~/Downloads/Music/') &&
        narrowed.some(entry => entry.path === '~/Downloads/Movies/') &&
        narrowed.every(entry => entry.name.startsWith('M')),
      `~/Downloads/M should keep completing:\n${narrowed.map(entry => entry.path).join('\n')}`,
    )
    console.log('PASS: ~/ subdirectories keep completing after a directory is accepted')

    const expansion = await expandMentions(fsService, fixture, 'see @~/Downloads/note.txt')
    assert.deepEqual(
      expansion.missing,
      [],
      `a submitted ~/ mention must resolve like completion:\n${expansion.missing.join('\n')}`,
    )
    assert.ok(
      expansion.attached.includes('~/Downloads/note.txt') &&
        expansion.blocks.some(block => block.type === 'text' && block.text.includes('home note')),
      `a submitted ~/ mention should attach the file content:\n${JSON.stringify(expansion.blocks)}`,
    )
    console.log('PASS: submitted ~/ mentions resolve the same home path as completion')
  } finally {
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
    if (originalUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = originalUserProfile
  }
} finally {
  await rm(fixture, { recursive: true, force: true })
}
