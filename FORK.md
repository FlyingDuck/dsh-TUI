# FORK.md

本文件只存在于 `bean` 分支，说明这个 fork（`FlyingDuck/dsh-TUI`）的维护约定。上游
（`ccch1mneyyy/dsh-TUI`）没有这个文件，合并上游时不会冲突。功能清单与已知限制见
[.github/release-notes/self-use.md](.github/release-notes/self-use.md)，此处不重复。

## 用途

自用构建：跟随上游发版，在其上叠加自有特性与修复，打包后装进本机 DSH profile 日常使用。
不以向上游提 PR 为主要目的。

## 分支

| 分支 | 角色 |
| --- | --- |
| `main` | 上游 `upstream/main` 的镜像，不放自有提交 |
| `bean` | 自用主线：上游版本 + 自有提交 |
| `backup/<分支>-before-<事件>-<YYYYMMDD>` | 大合并前的快照，例如 `backup/main-before-v0.17.0-20261026` |

## 合并上游

- 用 merge 把上游 release 合进 `bean`，**不 rebase、不重写**自有提交。
- 合并提交说明写清：保留了哪些自有特性、为适配上游改了什么、验证范围、未修的已知问题。
- 合完更新 `self-use.md` 的基线版本与条目。
- 验证按 `AGENTS.md` / `docs/contributing.md`：`pnpm build` 全部门禁 + 四个 CI 组全量，
  受影响的终端可见改动在 inline / fullscreen 与窄宽度下实测。

## 版本与标签

- `package.json` 的 `version` 保持与上游一致，不改。
- 经用户授权发布后，自用里程碑打带注释的标签 `<上游版本>+bean.<N>`（如 `0.16.1+bean.5`），推到 `origin`。
- **不要打 `v*` 标签**：`.github/workflows/publish.yml` 由 `v*` 触发 npm 发布。
- 构建身份由 `git describe --tags --dirty` 写入 `lib/build-info.json`，`/version` 显示；
  未提交的工作区会带 `-dirty`。

## 安装到本机

profile `~/.dsh/profiles/dsh-tui` 以 `file:` 依赖本地打包的 tarball，构建产物放在
`~/.local/share/dsh-tui/builds/<git describe>[-local-<hash>]/`。

统一发布目标与安装流程以 `~/oh-my-work/macbase/docs/dsh-tui-management.md` 为准，管理入口是
`~/oh-my-work/macbase/config/dsh/manage-dsh-tui.py`。源码合并不等于发布：经用户授权后走
新 tag 推送 → `pin` → 专用工具 `sync` / `check` → 重开后的 `/version` 验收 → 提交传播清单。
构建与 profile 安装使用管理器各自的专用工具环境；不要用主 checkout 手工打包加
`dsh plugin add` 代替受管 `sync`，也不要把临时试装冒称多 Mac 统一发布。
