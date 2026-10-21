# 自用构建的版本说明：构建时嵌入 lib/build-info.json，/version 原样显示。
# 每行一条，保持简短；空行和以 # 开头的行会被忽略，最多取 8 行。

- 输入键位调整：Ctrl+A / Ctrl+E 归输入框行首 / 行尾；子代理面板与 show-all 移到 Alt+A / Alt+E。
- 底栏 git 段：显示当前分支的 ahead/behind 与改动数。
- 插件中继消息：在转录里按插件声明显示，长正文折叠。
- /rollover：把当前会话结转到带日期的日志，并新开一段。
- /version：显示构建身份、安装来源，以及当前 DSH 内核版本。
