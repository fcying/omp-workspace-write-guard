# OMP Workspace Write Guard

**中文** | [English](README.md)

为 Oh My Pi 提供低打扰的工作区写入保护, 行为类似 OpenCode 的 `external_directory` 权限。

## 行为

- 任意位置的读取默认允许, 但 `protectedPaths` 或 `protectedFiles` 匹配的显式访问除外。默认情况下, 直接读取或写入名为 `.env` 的文件需要确认。
- 当前工作区内的其他直接文件修改默认允许。
- 工作区外的直接修改按 `externalWrites` 策略处理, 默认要求交互确认。
- 外部目标通过确认后, 插件只在当前 OMP 进程和当前工作区内记住其真实父目录。后续写入该目录及其子目录不再提示。
- OMP 重启后清空目录授权; 不同工作区之间不共享授权。
- 没有交互 UI 时, 需要确认但尚未授权的外部写入会被拒绝。
- 检查和记录目录前会解析符号链接。
- 新建临时命名空间可按 `temporary` 规则自动获得当前进程的临时所有权。默认允许新建 `/tmp/<name>`; 工具成功创建后, 同一进程和工作区可以修改或删除该命名空间。`eval` 代码创建命名空间后, 成功结果报告新路径时也会自动认领。
- 既有临时命名空间不会被自动认领。临时所有权在 OMP 重启后清空, 也不会跨工作区共享。
- Bash 自动审批开启时, 插件仍检查命令行中可识别的显式写入目标。
- `git push` 使用独立策略, 默认直接拒绝。

## 自定义配置

插件按以下顺序加载 `workspace-write-guard.json`, 后加载的配置覆盖先加载的配置:

1. 插件包内默认配置。
2. 当前 OMP profile 的 agent 配置目录。默认 profile 通常是 `~/.omp/agent/workspace-write-guard.json`。
3. 当前工作区的 `<workspace>/.omp/workspace-write-guard.json`。

### 用户级配置

需要对所有工作区生效的规则写在用户级配置中。默认 OMP profile 可用以下命令直接创建一份完整配置。这个示例由用户主动启用 SSH 和 GnuPG 路径拒绝; 包内默认配置不保护这些路径。

安装或升级插件不会创建或覆盖此文件。配置必须由用户显式执行, 避免插件生命周期操作修改全局访问策略。

```bash
mkdir -p ~/.omp/agent
cat > ~/.omp/agent/workspace-write-guard.json <<'JSON'
{
  "externalWrites": "prompt",
  "allowPaths": [],
  "protectedPaths": {
    "paths": ["~/.ssh", "~/.gnupg"],
    "policy": "deny"
  },
  "protectedFiles": {
    "names": [".env"],
    "policy": "prompt"
  },
  "temporary": {
    "root": "/tmp",
    "allowOwned": true
  },
  "gitPush": "deny"
}
JSON
```

如果 OMP 使用其他 profile 或设置了 `PI_CODING_AGENT_DIR`, 应将文件放到对应 profile 的 agent 配置目录。

### 项目级配置

项目级配置只用于可信工作区。在工作区根目录执行:

```bash
mkdir -p .omp
cat > .omp/workspace-write-guard.json <<'JSON'
{
  "allowPaths": ["../shared-build"],
  "temporary": {
    "allowOwned": false
  }
}
JSON
```

配置文件只需填写需要修改的字段; 未填写字段继承前一层配置。

配置文件必须是严格 JSON, 不是 JSONC 或 YAML。属性名和字符串必须使用双引号; 不允许注释或尾随逗号。

普通字段逐字段覆盖; `allowPaths`、`protectedPaths.paths` 和 `protectedFiles.names` 数组整体替换; `temporary`、`protectedPaths` 和 `protectedFiles` 按子字段合并。相对路径以当前工作区为基准, `~` 会展开为用户主目录。路径字段 (`allowPaths`、`protectedPaths.paths` 和 `temporary.root`) 会从 OMP 进程环境展开 `$NAME` 和 `${NAME}`。只展开一次; 不支持 `${NAME:-default}` 等 shell 默认值、命令替换、`%NAME%` 或 glob。引用未定义或空值变量属于配置错误。配置在当前 OMP 进程首次执行受保护操作时加载并缓存; 修改配置或其引用的环境变量后需要重启 OMP。

默认配置:

```json
{
  "externalWrites": "prompt",
  "allowPaths": [],
  "protectedPaths": {
    "paths": [],
    "policy": "deny"
  },
  "protectedFiles": {
    "names": [".env"],
    "policy": "prompt"
  },
  "temporary": {
    "root": "/tmp",
    "allowOwned": true
  },
  "gitPush": "deny"
}
```

字段含义:

- `externalWrites`: `"prompt"`, `"deny"`, `"allow"`。控制未被其他规则匹配的外部写入。
- `allowPaths`: 自动允许写入的目录或文件路径。只允许该路径及其后代。
- `protectedPaths.paths`: 保护显式访问的文件或目录路径。读取匹配该路径及其后代; 写入还匹配可能包含受保护路径的父目录删除或移动操作。优先级高于工作区、`allowPaths` 和会话授权。设置为 `[]` 可关闭路径保护。
- `protectedPaths.policy`: `"prompt"` 或 `"deny"`。`"prompt"` 会为每次匹配的工具调用确认, 无交互 UI 时安全拒绝, 且不会记住批准; `"deny"` 直接拒绝且不打开确认框。
- `protectedFiles.names`: 在任意目录中保护显式读写的精确文件名。不允许 glob 或路径分隔符。设置为 `[]` 可关闭包内默认的 `.env` 规则。
- `protectedFiles.policy`: `"prompt"` 或 `"deny"`。`"prompt"` 会为每次匹配的工具调用确认, 无交互 UI 时安全拒绝, 且不会记住批准; `"deny"` 直接拒绝且不打开确认框。

- `temporary.root`: 可自动认领新命名空间的临时根目录。
- `temporary.allowOwned`: 是否启用临时命名空间自动认领。
- `gitPush`: `"deny"`, `"prompt"`, `"allow"`。即使设为 `"allow"`, `git -C` 或 `--git-dir` 指向外部仓库时仍会执行外部路径检查。

例如, 拒绝显式访问密钥及 XDG 配置路径, 交互确认 `.env` 和 `.env.local`, 自动允许一个共享构建目录, 禁用临时目录自动认领, 并让 `git push` 每次确认:

```json
{
  "allowPaths": ["~/shared-build"],
  "protectedPaths": {
    "paths": ["~/.ssh", "$XDG_CONFIG_HOME/shell/private", "./secrets"],
    "policy": "deny"
  },
  "protectedFiles": {
    "names": [".env", ".env.local"],
    "policy": "prompt"
  },
  "temporary": {
    "allowOwned": false
  },
  "gitPush": "prompt"
}
```

项目配置最后加载, 因此可以放宽用户配置。只对可信仓库启用项目级配置; 不可信仓库应使用用户级配置并检查项目中的 `.omp/workspace-write-guard.json`。

配置包含未知字段、非法枚举、空路径或文件名、未定义或空值环境变量、受保护文件名中的路径分隔符或 glob, 或路径字段中的 glob 时, 插件会安全拒绝其保护范围内的操作并返回具体配置错误。不在覆盖范围内的只读工具不受非法配置影响。

## 推荐的低打扰配置

保守配置继续使用 OMP 的普通 `write` 审批模式, 只自动批准 Bash:

```bash
omp config set tools.approvalMode write
omp config set tools.approval '{"bash":"allow"}'
```

这样不会为以下只读命令或项目 runner 额外提示:

```bash
git rev-parse HEAD
just test
npm test
cargo build
```

在可信的本地开发环境中, 常用的低打扰配置为:

```bash
omp config set tools.approvalMode write
omp config set tools.approval '{"bash":"allow","task":"allow","eval":"allow","hub":"allow","browser":"allow"}'
```

- `bash`: shell 命令和项目 runner。
- `task`: 委派给 worker agent 的任务。
- `eval`: 持久化 Python 和 JavaScript kernel。
- `hub`: agent 协调及后台进程控制。
- `browser`: Chromium 自动化。通过 `write(path="xd://browser")` 路由的调用继承此策略, 因此允许 `browser` 后不会再出现外层 `Allow tool: write` 提示。

这些都是可执行工具。`bash`、`eval`、`browser.run`、后台进程和委派 agent 都可能产生无法从显式文件目标中识别的文件系统副作用。只在可信仓库及命令中使用这组配置。与 `yolo` 不同, 未列出的其他可执行工具仍需确认。

OMP 自身的高风险破坏命令保护仍可能要求确认, 例如 `rm -r` 和 `rm -rf`。若要无额外提示地删除插件已认领的临时目录, 可先用非递归 `rm` 删除文件, 再用 `rmdir` 删除空目录。

不要使用 `yolo`, 除非你接受所有可执行工具都可能绕过路径检查。

## Marketplace 安装

注册 marketplace 并安装插件:

```bash
omp plugin marketplace add fcying/omp-workspace-write-guard
omp plugin install omp-workspace-write-guard@fcying-omp-plugins
omp config set tools.approvalMode write
omp config set tools.approval '{"bash":"allow"}'
```

统一刷新 marketplace catalog 并升级所有已安装的 marketplace 插件:

```bash
omp plugin marketplace update
omp plugin upgrade
```

`marketplace update` 只刷新 catalog; `plugin upgrade` 才会根据 catalog 中的版本重新安装插件。安装或升级 extension 后需要重启 OMP。

卸载插件:

```bash
omp plugin uninstall omp-workspace-write-guard@fcying-omp-plugins
```

卸载插件后 marketplace 仍保持注册, 其中的其他插件仍可被发现。不再需要该 marketplace 时可以单独移除注册:

```bash
omp plugin marketplace remove fcying-omp-plugins
```

本地开发可以将仓库作为本地 marketplace 注册:

```bash
omp plugin marketplace add /path/to/workspace-write-guard
omp plugin install omp-workspace-write-guard@fcying-omp-plugins
```

当前仓库同时是 `fcying-omp-plugins` marketplace 和插件源码。远程用户通过 GitHub 仓库更新 catalog; 本地 marketplace 直接读取工作树。

## 覆盖的受保护访问

`protectedPaths` 检查传给 `read` 的显式文件路径、`grep` 的非 glob 根路径, 以及下列修改工具。读取匹配受保护路径及其后代; 写入还匹配可能包含受保护路径的父目录删除和移动操作。`protectedFiles` 对相同的显式目标执行精确文件名匹配。匹配前会解析符号链接; 请求路径与真实路径不同时, 确认框会同时显示两者。目录搜索或 glob 搜索不会被展开以发现受保护的后代文件。

## 覆盖的修改路径

插件拦截:

- `write`
- `edit` / `apply_patch`
- `ast_edit`
- `delete`
- `move`
- LSP 修改操作
- 带显式写入目标的常见 Bash 命令

Bash 检查覆盖 shell 输出重定向, `rm`, `rmdir`, `mkdir`, `touch`, `truncate`, `cp`, `mv`, `install`, `ln`, `chmod`, `chown`, `chgrp`, `tee`, `dd of=`, 原地修改的 `sed` / `perl`, 以及会修改仓库的 Git 命令。比较前会解析结构化 Bash `cwd`, `cd`, Git `-C`, glob, home 路径和符号链接。只有工具结果确认目录已经创建后, 插件才会授予新临时命名空间当前进程的所有权。对于 `eval`, 插件会比较配置的临时根目录快照, 仅认领成功结果中报告了完整路径的新增一级命名空间。

`git push` 检测覆盖直接调用、wrapper、`git -C`、Git 全局选项和复合命令。`gitPush: "deny"` 时立即拒绝且不打开确认框; `"prompt"` 时独立确认; `"allow"` 时仍保留仓库路径检查。

普通文件、归档条目和 SQLite 行写入按其底层文件路径判断。`local://` 和 `xd://` 是 OMP 会话资源, 不作为外部文件处理。`conflict://` 写入按当前会话登记的底层冲突文件路径判断。

任意 LSP `request` 仍单独确认, 因为协议请求可能触发服务端工作区编辑, 而执行前无法获得完整目标列表。

## 安全边界

本插件用于防止误写, 不是操作系统沙箱。shell 解析器无法证明任意命令的实际副作用。

自动批准 Bash 会信任 `just`, `make`, `npm`, `cargo`, Python 和项目二进制等 runner 或脚本。最终路径没有出现在工具参数中时, 它们可以读取受保护路径或文件, 或写入工作区外。命令替换、动态 shell 展开、被 source 的脚本、alias、函数、未知命令、目录搜索和 glob 搜索也有同样限制。临时根目录快照只能识别结果中报告的新命名空间, 不能审计代码的其他副作用。

需要强制文件系统边界时, 使用 Bubblewrap、容器或虚拟机。

## 测试

要求 Node.js 22.18 或更高版本:

```bash
npm test
```

测试覆盖受保护路径和文件的提示与拒绝、工作区内外写入、配置覆盖、白名单和受保护路径优先级、临时命名空间所有权、目录授权缓存、符号链接逃逸、AST 和 LSP 修改、Bash 重定向、Git 命令、`cwd` / `cd`, 以及常见文件修改命令。
