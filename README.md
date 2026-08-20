# OMP Workspace Write Guard

[中文](README.zh-CN.md) | **English**

Adds low-prompt workspace write protection to Oh My Pi, similar to OpenCode's `external_directory` permission.

## Behavior

- Reads from any location are allowed by default.
- Direct file modifications inside the current workspace are allowed by default.
- Direct modifications outside the workspace follow the `externalWrites` policy and require interactive confirmation by default.
- After an external target is approved, the plugin remembers its real parent directory only for the current OMP process and workspace. Later writes to that directory or its descendants do not prompt again.
- Directory approvals reset when OMP restarts and are not shared across workspaces.
- External writes that require confirmation but have not been approved are denied when no interactive UI is available.
- Symbolic links are resolved before a directory is checked or remembered.
- New temporary namespaces can receive process-local ownership according to the `temporary` policy. By default, a new `/tmp/<name>` namespace can be created without confirmation. After the tool successfully creates it, the same OMP process and workspace can modify or delete that namespace.
- Existing temporary namespaces are never claimed automatically. Temporary ownership resets when OMP restarts and is not shared across workspaces.
- When Bash is configured for automatic approval, the plugin still checks explicit write targets that can be identified on the command line.
- `git push` has an independent policy and is denied by default.

## Configuration

The plugin loads `workspace-write-guard.json` in the following order. Later sources override earlier sources:

1. The default configuration bundled with the plugin.
2. The agent configuration directory for the active OMP profile. For the default profile, this is usually `~/.omp/agent/workspace-write-guard.json`.
3. `<workspace>/.omp/workspace-write-guard.json` in the active workspace.

Ordinary fields are overridden field by field. The `allowPaths` and `denyPaths` arrays are replaced as whole arrays. `temporary` is merged by nested field. Relative paths are resolved from the active workspace, and `~` expands to the user's home directory. Glob patterns are not supported. Configuration is loaded and cached when the current OMP process first performs a protected operation. Restart OMP after changing it.

Default configuration:

```json
{
  "externalWrites": "prompt",
  "allowPaths": [],
  "denyPaths": [],
  "temporary": {
    "root": "/tmp",
    "allowOwned": true
  },
  "gitPush": "deny"
}
```

Fields:

- `externalWrites`: `"prompt"`, `"deny"`, or `"allow"`. Controls external writes that do not match another rule.
- `allowPaths`: File or directory paths that can be written without confirmation. Each entry permits only that path and its descendants.
- `denyPaths`: File or directory paths that cannot be written. This takes precedence over the workspace, `allowPaths`, and session approvals. It protects the path itself, its descendants, and parent deletion or move operations that could contain it.
- `temporary.root`: The temporary root under which newly created namespaces can be claimed automatically.
- `temporary.allowOwned`: Enables automatic temporary namespace ownership.
- `gitPush`: `"deny"`, `"prompt"`, or `"allow"`. Even when set to `"allow"`, external repository paths supplied through `git -C` or `--git-dir` still undergo external path checks.

Example: deny writes to key directories, allow a shared build directory, disable automatic temporary ownership, and prompt for every `git push`:

```json
{
  "allowPaths": ["~/shared-build"],
  "denyPaths": ["~/.ssh", "./secrets"],
  "temporary": {
    "allowOwned": false
  },
  "gitPush": "prompt"
}
```

Project configuration loads last and can therefore weaken user configuration. Enable project configuration only in trusted repositories. For untrusted repositories, use user-level configuration and inspect `.omp/workspace-write-guard.json` in the project.

If configuration contains unknown fields, invalid enum values, empty paths, or glob patterns, the plugin fails closed for protected operations and reports the exact configuration error. Read-only tools are not affected by invalid write configuration.

## Recommended low-prompt setup

Keep OMP's normal `write` approval mode and auto-approve only Bash:

```bash
omp config set tools.approvalMode write
omp config set tools.approval '{"bash":"allow"}'
```

This avoids extra prompts for read-only commands and project runners such as:

```bash
git rev-parse HEAD
just test
npm test
cargo build
```

OMP's own critical destructive-command guard can still require confirmation for operations such as `rm -r` and `rm -rf`. To remove a temporary tree already owned by the plugin without an additional prompt, remove files with non-recursive `rm` calls and then remove empty directories with `rmdir`.

Do not use `yolo` unless you accept that arbitrary executable tools can bypass path checks.

## Marketplace installation

Register the marketplace and install the plugin:

```bash
omp plugin marketplace add fcying/omp-workspace-write-guard
omp plugin install omp-workspace-write-guard@fcying-omp-plugins
omp config set tools.approvalMode write
omp config set tools.approval '{"bash":"allow"}'
```

Refresh all marketplace catalogs and upgrade all installed marketplace plugins:

```bash
omp plugin marketplace update
omp plugin upgrade
```

`marketplace update` refreshes only the catalogs. `plugin upgrade` performs plugin reinstallation according to catalog versions. Restart OMP after installing or upgrading an extension.

Uninstall the plugin:

```bash
omp plugin uninstall omp-workspace-write-guard@fcying-omp-plugins
```

The marketplace remains registered so its other plugins can still be discovered. Remove the marketplace registration separately when it is no longer needed:

```bash
omp plugin marketplace remove fcying-omp-plugins
```

For local development, register the repository as a local marketplace:

```bash
omp plugin marketplace add /path/to/workspace-write-guard
omp plugin install omp-workspace-write-guard@fcying-omp-plugins
```

This repository is both the `fcying-omp-plugins` marketplace and the plugin source. Remote users refresh its catalog from GitHub, while a local marketplace reads directly from the working tree.

## Covered modification paths

The plugin intercepts:

- `write`
- `edit` / `apply_patch`
- `ast_edit`
- `delete`
- `move`
- LSP modification operations
- Common Bash commands with explicit write targets

Bash checks cover shell output redirection, `rm`, `rmdir`, `mkdir`, `touch`, `truncate`, `cp`, `mv`, `install`, `ln`, `chmod`, `chown`, `chgrp`, `tee`, `dd of=`, in-place `sed` and `perl`, and mutating Git commands. Structured Bash `cwd`, `cd`, Git `-C`, glob paths, home paths, and symbolic links are resolved before comparison. A new temporary namespace receives process-local ownership only after the tool result confirms that it was created.

`git push` detection covers direct calls, wrappers, `git -C`, Git global options, and compound commands. `gitPush: "deny"` rejects immediately without opening a confirmation dialog. `"prompt"` requests separate confirmation. `"allow"` still preserves repository path checks.

Regular files, archive entries, and SQLite row writes are evaluated using their underlying file paths. `local://` and `xd://` are OMP session resources and are not treated as external files.

Arbitrary LSP `request` calls remain separately confirmed because a protocol request can trigger server-initiated workspace edits whose complete targets are unavailable before execution.

## Security boundary

This plugin guards against accidental writes. It is not an operating-system sandbox. A shell parser cannot prove the actual side effects of an arbitrary command.

Auto-approved Bash trusts project runners and scripts such as `just`, `make`, `npm`, `cargo`, Python, and project binaries. They can write outside the workspace when the final target is not visible in the Bash tool arguments. Command substitution, dynamic shell expansion, sourced scripts, aliases, functions, and unknown commands have the same limitation.

Use Bubblewrap, a container, or a virtual machine when an enforceable filesystem boundary is required.

## Tests

Requires Node.js 22.18 or later:

```bash
npm test
```

Tests cover workspace and external writes, configuration precedence, allowlist and denylist priority, temporary namespace ownership, remembered directory approval, symbolic-link escapes, AST and LSP edits, Bash redirection, Git commands, `cwd` and `cd`, and common file modification commands.
