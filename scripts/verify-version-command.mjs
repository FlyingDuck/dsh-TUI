/**
 * `/version` 回归（本 fork 的构建身份命令，实现见 src/buildInfo.ts 与
 * scripts/gen-build-info.mjs）：
 *
 *   A. 源码运行（tsx：pnpm tui / pnpm smoke）读不到 stamp → 单行降级且是
 *      「开发运行」文案，仍报出版本号；
 *   B. 编译产物 + 真 stamp → 三行齐全，含 describe、8 位短 commit 与本地
 *      时间（带 UTC 偏移），并且不会自称源码运行；
 *   C. 来源探测矩阵：`file:*.tgz` / `file:<目录>` / `link:<路径>` / 纯 semver
 *      各判定正确、路径解析成绝对路径，键缺失 / 坏 JSON / 没有 manifest
 *      一律「未知」且其余行照常（只有第 1 条那句「输出含 describe」是
 *      有 stamp 就成立的正向断言 —— C 才是喂错输入会红的那一半）；
 *   D. 默认 profile 目录确实取自 `$DSH_HOME/profiles/dsh-tui`；
 *   E. 命令面接线：声明、英文描述、zh 描述走 `cmd-desc-version`（且该键只写
 *      zh，en 回退声明原文）、归属 `any`；
 *   F. 屏幕分发接线（文本级）：Chat.tsx 分发的名字是 `version`，且调用的就是
 *      buildInfo 这一份真源，没有另起内联实现。
 *
 * 一个模块同时被导入两次是刻意的：`src/buildInfo.ts` 走的是源码运行分支
 * （无 stamp），`lib/types/buildInfo.js` 走的是装好的包那一支 —— 两者的差别
 * 本身就是「开发运行 / 官方构建」两种降级文案的判据。
 *
 * 运行：node --import tsx/esm scripts/verify-version-command.mjs（先 pnpm compile）
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGE_NAME = '@deepseek-harness-tui/dsh-tui'

// 隔离先于任何 src 导入：语言在 import 时解析，偏好目录也在 import 时求值。
const tmp = mkdtempSync(join(tmpdir(), 'dsh-version-'))
const home = join(tmp, 'home')
mkdirSync(home, { recursive: true })
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSH_TUI_LANG = 'zh'

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

const compiledPath = join(root, 'lib', 'types', 'buildInfo.js')
const stampPath = join(root, 'lib', 'build-info.json')
if (!existsSync(compiledPath) || !existsSync(stampPath)) {
  console.error('verify-version-command: 缺 lib/types/buildInfo.js 或 lib/build-info.json —— 先跑 pnpm compile')
  process.exit(1)
}

const source = await import('../src/buildInfo.js')
const compiled = await import('../lib/types/buildInfo.js')
const commands = await import('../src/commands.js')
const { i18nDict } = await import('../src/i18n.js')

let checks = 0
const failures = []
const check = (name, ok, detail = '') => {
  checks += 1
  if (!ok) failures.push(`${name}${detail ? `: ${detail}` : ''}`)
}

/** 一份固定的构建信息：文案断言不依赖这台机器真实的构建时间。 */
const fakeInfo = {
  version: '0.16.1',
  describe: '0.16.1+bean.1-dirty',
  branch: 'bean',
  commit: 'beef1234deadbeefdeadbeefdeadbeefdeadbeef',
  builtAt: '2026-10-19T02:45:26.356Z',
  node: 'v22.23.3',
}
const MISSING = Symbol('missing')
const BROKEN = Symbol('broken')

/** 写一个 profile manifest；MISSING 省略依赖键，BROKEN 写坏 JSON。 */
function writeProfile(dir, spec) {
  mkdirSync(dir, { recursive: true })
  if (spec === BROKEN) {
    writeFileSync(join(dir, 'package.json'), '{ not json')
    return
  }
  const dependencies = spec === MISSING ? { 'left-pad': '^1.0.0' } : { [PACKAGE_NAME]: spec }
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: 'dsh-tui-profile', private: true, dependencies }, null, 2)}\n`)
}

// ── A. 源码运行：没有 stamp 也不崩 ─────────────────────────────────────────
{
  process.env.DSH_HOME = join(tmp, 'empty-dsh-home')
  const info = source.readBuildInfo()
  check('A 源码运行：runningFromSource() 为真', source.runningFromSource() === true)
  check('A 源码运行：读不到构建信息', info === null, JSON.stringify(info))
  const lines = source.versionReportLines()
  check('A 源码运行：单行降级', lines.length === 1, lines.join(' | '))
  check('A 源码运行：走「开发运行（无构建信息）」文案',
    lines.length === 1 && lines[0].includes('开发运行（无构建信息）'), lines.join(' | '))
  check('A 源码运行：降级行仍报出版本号',
    lines.some(line => line.includes(`dsh-tui ${pkg.version}`)), lines.join(' | '))
}

// ── B. 编译产物 + 真 stamp：本仓真构建的身份 ──────────────────────────────
{
  const info = compiled.readBuildInfo()
  check('B 编译产物：runningFromSource() 为假', compiled.runningFromSource() === false)
  check('B 编译产物：读到构建信息', info !== null, JSON.stringify(info))
  check('B 编译产物：describe 与完整 commit 都在',
    typeof info?.describe === 'string' && info.describe !== '' && /^[0-9a-f]{40}$/u.test(info.commit ?? ''),
    JSON.stringify(info))
  check('B 编译产物：version 取自 package.json',
    info?.version === pkg.version, `${info?.version} vs ${pkg.version}`)
  const dir = join(tmp, 'profile-compiled')
  const tarball = join(tmp, 'builds', 'deepseek-harness-tui-dsh-tui-0.16.1.tgz')
  writeProfile(dir, `file:${tarball}`)
  const lines = compiled.versionReportLines({ profileDir: dir })
  check('B 编译产物：三行齐全', lines.length === 3, lines.join(' | '))
  check('B 编译产物：输出含 describe',
    lines[0]?.includes(info?.describe ?? '\u0000') === true, lines[0] ?? '(none)')
  check('B 编译产物：输出含 8 位短 commit',
    lines[1]?.includes(info?.commit?.slice(0, 8) ?? '\u0000') === true, lines[1] ?? '(none)')
  check('B 编译产物：构建时间是本地时间加 UTC 偏移',
    / \d{4}-\d{2}-\d{2} \d{2}:\d{2} \([+-]\d{4}\)$/u.test(lines[1] ?? ''), lines[1] ?? '(none)')
}

// ── C. 来源探测：喂错输入必须红 ───────────────────────────────────────────
{
  const profileDir = join(tmp, 'profile-cases')
  const tarball = join(tmp, 'builds', 'deepseek-harness-tui-dsh-tui-0.16.1+bean.1.tgz')
  const cases = [
    { label: 'file:*.tgz', spec: `file:${tarball}`, kind: 'tarball', text: '本地 tarball' },
    { label: 'file:<目录>', spec: 'file:../local-build', kind: 'directory', text: '本地目录' },
    { label: 'link:<路径>', spec: 'link:../../dsh-TUI', kind: 'link', text: '源码链接' },
    { label: '纯 semver', spec: '^0.16.1', kind: 'registry', text: 'registry 官方' },
    { label: '键缺失', spec: MISSING, kind: 'unknown', text: '未知' },
    { label: '坏 JSON', spec: BROKEN, kind: 'unknown', text: '未知' },
  ]
  for (const [index, { label, spec, kind, text }] of cases.entries()) {
    const dir = join(profileDir, `${index}-${kind}`)
    writeProfile(dir, spec)
    const detected = source.detectInstallSource(dir)
    check(`C ${label}：判定为 ${kind}`, detected.kind === kind, JSON.stringify(detected))
    if (kind === 'tarball' || kind === 'directory' || kind === 'link') {
      const target = spec.slice(spec.indexOf(':') + 1)
      const expected = resolve(dir, target)
      check(`C ${label}：路径解析为相对 profile 的绝对路径`, detected.path === expected, `${detected.path} vs ${expected}`)
    } else {
      check(`C ${label}：不附路径`, detected.path === null, String(detected.path))
    }
    // 「其余行照常」：来源读不出来时，前两行（身份）必须一字不少。
    const lines = source.versionReportLines({ info: fakeInfo, profileDir: dir })
    check(`C ${label}：三行齐全`, lines.length === 3, lines.join(' | '))
    check(`C ${label}：身份行照常`,
      lines[0]?.includes(fakeInfo.describe) === true && lines[1]?.includes('beef1234') === true,
      `${lines[0] ?? ''} | ${lines[1] ?? ''}`)
    check(`C ${label}：来源行文案含「${text}」`, lines[2]?.includes(text) === true, lines[2] ?? '(none)')
    if (detected.path !== null) {
      check(`C ${label}：来源行含解析后的路径`, lines[2]?.includes(detected.path) === true, lines[2] ?? '(none)')
    }
  }
  // 连 manifest 文件都没有：同样「未知」，不崩。
  const noManifest = join(profileDir, 'no-manifest')
  mkdirSync(noManifest, { recursive: true })
  check('C 没有 manifest：判定为未知', source.detectInstallSource(noManifest).kind === 'unknown',
    JSON.stringify(source.detectInstallSource(noManifest)))
  const noManifestLines = source.versionReportLines({ info: fakeInfo, profileDir: noManifest })
  check('C 没有 manifest：其余行照常', noManifestLines.length === 3 && noManifestLines[2]?.includes('未知') === true,
    noManifestLines.join(' | '))
}

// ── D. 默认 profile 目录来自 $DSH_HOME ───────────────────────────────────
{
  const dshHome = join(tmp, 'dsh-home')
  const tarball = join(tmp, 'builds', 'from-dsh-home.tgz')
  process.env.DSH_HOME = dshHome
  writeProfile(join(dshHome, 'profiles', 'dsh-tui'), `file:${tarball}`)
  const lines = source.versionReportLines({ info: fakeInfo })
  check('D 默认目录：读 $DSH_HOME/profiles/dsh-tui/package.json',
    lines[2]?.includes('本地 tarball') === true && lines[2]?.includes(tarball) === true, lines[2] ?? '(none)')
  process.env.DSH_HOME = join(tmp, 'empty-dsh-home')
}

// ── E. 命令面接线 ────────────────────────────────────────────────────────
{
  const declared = commands.LOCAL_COMMANDS.filter(command => command.name === 'version')
  check('E 声明唯一一条 /version', declared.length === 1, JSON.stringify(declared))
  const entry = declared[0]
  check('E 英文描述即注册表原文', entry?.description === 'Show the build this copy was made from', entry?.description)
  check('E zh 描述走 cmd-desc-version',
    entry !== undefined && commands.localizedDescription(entry) === '显示当前构建的身份与来源',
    entry === undefined ? '(missing)' : commands.localizedDescription(entry))
  check('E cmd-desc-version 只写 zh（en 回退声明原文）', i18nDict['cmd-desc-version']?.en === undefined,
    JSON.stringify(i18nDict['cmd-desc-version']))
  check('E 命令名可解析为本地命令', commands.isLocalCommandName('version'))
  check('E 归属 any：不依赖后端会话能力', commands.localCommandRequirement('version') === 'any',
    commands.localCommandRequirement('version'))
  check('E 不是隐藏命令', !commands.isHiddenCommandName('version'))
}

// ── F. 屏幕分发接线（文本级）─────────────────────────────────────────────
// Chat.tsx 是 React 组件，驱动真屏要一整份 channel 夹具（见
// verify-rollover-screen.tsx），收益不抵成本。这里只钉「声明了就必须分发、
// 分发到的必须是 buildInfo 这一份真源」——能红的形态是漏分发、把名字写错
// （`case 'verison'` 这类 tsc 看不出来的手误）、或另起一份内联实现。
{
  const chat = readFileSync(join(root, 'src', 'screens', 'Chat.tsx'), 'utf8')
  const at = chat.indexOf("case 'version':")
  check('F Chat.tsx 有 case \'version\' 分发', at >= 0)
  const next = at < 0 ? -1 : chat.indexOf("\n      case '", at + 1)
  const block = at < 0 ? '' : chat.slice(at, next < 0 ? at + 400 : next)
  check('F 分发行调用 versionReportLines()', block.includes('versionReportLines()'), block.slice(0, 200))
  check('F 分发行把行交给 channel.pushLocal(\'/version\')', block.includes("pushLocal('/version'"), block.slice(0, 200))
}

rmSync(tmp, { recursive: true, force: true })
if (failures.length > 0) {
  console.error(`version-command FAILED (${failures.length}/${checks}):`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(`version-command OK (${checks} checks: 源码运行降级、编译产物 stamp、来源矩阵 file/link/semver/坏输入、$DSH_HOME 默认目录、命令声明与 Chat 分发接线)`)
process.exit(0)
