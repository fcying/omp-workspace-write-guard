# OMP Workspace Write Guard

[中文](README.zh-CN.md) | **English**

Adds low-prompt workspace write protection to Oh My Pi, similar to OpenCode's `external_directory` permission.

## Behavior

- Reads from any location are allowed by default, except explicit access matched by configured `protectedPaths` or `protectedFiles` rules. No file names are protected by default.
- Direct file modifications inside the current workspace are otherwise allowed by default.
- Direct modifications outside the workspace follow the `externalWrites` policy and require interactive confirmation by default, except writes to strict descendants of `temporary.root` while `temporary.allowAll` is enabled.
- Writes to `/dev/null` are allowed without confirmation; all other device paths remain subject to the applicable policy.
- Writes to the standard OMP session directory for the current canonical workspace, `<agentDir>/sessions/<workspace-bucket>/`, are allowed without confirmation. Other workspace buckets remain external; explicit protection rules still take precedence.

- After an external target is approved, the plugin remembers its real parent directory only for the current OMP process and workspace. Later writes to that directory or its descendants do not prompt again.
- Directory approvals reset when OMP restarts and are not shared across workspaces.
- External writes that require confirmation but have not been approved are denied when no interactive UI is available.
- Symbolic links are resolved before a directory is checked or remembered.
- A Bash command can remove its own directory created with `name=$(mktemp -d)` without external-write confirmation when automatic temporary ownership is enabled, `mktemp` uses the configured temporary root, and the cleanup uses `rm` or `rmdir` with the exact variable; other variable expansions remain unapproved explicit targets.
- If this cleanup requires confirmation instead, approving it never remembers the temporary root or any of its descendants.

- New temporary namespaces can receive process-local ownership according to the `temporary` policy. By default, a new `/tmp/<name>` namespace can be created without confirmation. After the tool successfully creates it, the same OMP process and workspace can modify or delete that namespace. `mktemp` can claim a namespace when its successful result reports a new path matching the explicit template; `eval` can claim one created by its code when the successful result reports the new path.
- Existing temporary namespaces are never claimed automatically. Temporary ownership resets when OMP restarts and is not shared across workspaces.
- `temporary.allowAll` defaults to `true`, so direct writes to pre-existing and new strict descendants of `temporary.root` bypass `externalWrites`; the temporary root itself remains guarded. Explicit `protectedPaths` and `protectedFiles` rules still take precedence.
- When Bash is configured for automatic approval, the plugin still checks explicit write targets that can be identified on the command line.
- `git push` has an independent policy and is denied by default.

## Configuration

The plugin loads `workspace-write-guard.json` in the following order. Later sources override earlier sources:

1. The default configuration bundled with the plugin.
2. The agent configuration directory for the active OMP profile. For the default profile, this is usually `~/.omp/agent/workspace-write-guard.json`.
3. `<workspace>/.omp/workspace-write-guard.json` in the active workspace.

### User-level configuration

Use the user-level file for rules that should apply to every workspace. For the default OMP profile, the following command directly creates a complete configuration file. This example explicitly opts into denying access to SSH and GnuPG paths; those paths are not protected by the bundled default configuration.

Installing or upgrading the plugin does not create or overwrite this file. Configuration remains an explicit user action so plugin lifecycle operations never change global access policy.

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
    "names": [],
    "policy": "prompt"
  },
  "temporary": {
    "root": "/tmp",
    "allowOwned": true,
    "allowAll": true
  },
  "sessionDirectory": {
    "allow": true
  },
  "gitPush": "deny"
}
JSON
```

When OMP uses another profile or `PI_CODING_AGENT_DIR`, place the file in that profile's agent configuration directory instead.

### Project-level configuration

Use a project-level file only for a trusted workspace. From the workspace root:

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

The file may contain only the fields that need to change. Unspecified fields inherit from earlier configuration layers.

Configuration files are strict JSON, not JSONC or YAML. Use double-quoted property names and strings; comments and trailing commas are invalid.

Ordinary fields are overridden field by field. The `allowPaths`, `protectedPaths.paths`, and `protectedFiles.names` arrays are replaced as whole arrays. `temporary`, `sessionDirectory`, `protectedPaths`, and `protectedFiles` are merged by nested field. Relative paths are resolved from the active workspace, and `~` expands to the user's home directory. Path fields (`allowPaths`, `protectedPaths.paths`, and `temporary.root`) expand `$NAME` and `${NAME}` from the OMP process environment. Expansion occurs once; shell defaults such as `${NAME:-default}`, command substitution, `%NAME%`, and glob patterns are not supported. An undefined or empty referenced variable is a configuration error. Configuration is loaded and cached when the current OMP process first performs a protected operation. Restart OMP after changing the configuration or its referenced environment variables.

Default configuration:

```json
{
  "externalWrites": "prompt",
  "allowPaths": [],
  "protectedPaths": {
    "paths": [],
    "policy": "deny"
  },
  "protectedFiles": {
    "names": [],
    "policy": "prompt"
  },
  "temporary": {
    "root": "/tmp",
    "allowOwned": true,
    "allowAll": true
  },
  "sessionDirectory": {
    "allow": true
  },
  "gitPush": "deny"
}
```

Fields:

- `externalWrites`: `"prompt"`, `"deny"`, or `"allow"`. Controls external writes that do not match another rule.
- `allowPaths`: File or directory paths that can be written without confirmation. Each entry permits only that path and its descendants.
- `protectedPaths.paths`: File or directory paths whose explicit access is protected. Reads match the path and its descendants. Writes also match parent deletion or move operations that could contain a protected path. This takes precedence over the workspace, `allowPaths`, and session approvals. Set this to `[]` to disable path protection.
- `protectedPaths.policy`: `"prompt"` or `"deny"`. `"prompt"` confirms every matching tool call and fails closed without an interactive UI; approval is not remembered. `"deny"` blocks immediately without opening a confirmation dialog.
- `protectedFiles.names`: Exact file names whose explicit reads and writes are protected in any directory. Glob patterns and path separators are rejected. The default list is empty.
- `protectedFiles.policy`: `"prompt"` or `"deny"`. `"prompt"` confirms every matching tool call and fails closed without an interactive UI; approval is not remembered. `"deny"` blocks immediately without opening a confirmation dialog.

- `temporary.root`: The temporary root under which newly created namespaces can be claimed automatically.
- `temporary.allowOwned`: Enables automatic temporary namespace ownership.
- `temporary.allowAll`: Allows direct writes below `temporary.root`. Defaults to `true`; explicit protected rules still take precedence.
- `sessionDirectory.allow`: Allows writes to the standard OMP session directory for the current workspace. Defaults to `true`; set it to `false` to apply `externalWrites` instead. Explicit protected rules still take precedence.

- `gitPush`: `"deny"`, `"prompt"`, or `"allow"`. Even when set to `"allow"`, external repository paths supplied through `git -C` or `--git-dir` still undergo external path checks.

Example: deny explicit access to key and XDG configuration paths, protect `.env` and `.env.local` with an interactive prompt, allow a shared build directory, disable automatic temporary ownership, and prompt for every `git push`:

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

Project configuration loads last and can therefore weaken user configuration. Enable project configuration only in trusted repositories. For untrusted repositories, use user-level configuration and inspect `.omp/workspace-write-guard.json` in the project.

If configuration contains unknown fields, invalid enum values, empty paths or file names, undefined or empty environment variables, path separators or glob patterns in protected file names, or glob patterns in path fields, the plugin fails closed for operations it protects and reports the exact configuration error. Uncovered read-only tools are not affected by invalid configuration.

## Recommended low-prompt setup

For the conservative setup, keep OMP's normal `write` approval mode and auto-approve only Bash:

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

For a trusted local development environment, the commonly used low-prompt set is:

```bash
omp config set tools.approvalMode write
omp config set tools.approval '{"bash":"allow","task":"allow","eval":"allow","hub":"allow","browser":"allow"}'
```

- `bash`: shell commands and project runners.
- `task`: delegated worker agents.
- `eval`: persistent Python and JavaScript kernels.
- `hub`: agent coordination and background process control.
- `browser`: Chromium automation. Calls routed through `write(path="xd://browser")` inherit this policy, so allowing `browser` removes the outer `Allow tool: write` prompt.

These are executable tools. `bash`, `eval`, `browser.run`, background processes, and delegated agents can cause filesystem side effects that are not visible as explicit file targets. Use this set only for trusted repositories and commands. Unlike `yolo`, executable tools not listed here still require approval.

### Yolo with workspace protection

For a trusted workspace that prioritizes low prompt volume, enable OMP's `yolo` mode and retain this plugin's policies:

```bash
omp config set tools.approvalMode yolo
```

OMP then skips its own tool and critical-command approval prompts, while this plugin still blocks or prompts for explicit targets it recognizes: `protectedPaths`, `protectedFiles`, external writes, and `git push` according to their configured policies. This permits cleanup of configured temporary-root descendants without OMP's `rm` critical prompt.

This is not a sandbox. The plugin cannot prove filesystem effects hidden in scripts, project runners, `eval` subprocesses, command substitution, dynamic expansion, aliases, functions, or unknown programs. Use `yolo` only when that boundary is acceptable.

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

## Covered protected access

`protectedPaths` checks explicit file paths supplied to `read`, non-glob `grep` roots, and the modification tools listed below. Reads match protected paths and their descendants; writes also match parent deletion and move operations that could contain a protected path. `protectedFiles` applies exact file-name matching to the same explicit targets. Symbolic links are resolved before matching, and the confirmation displays both the requested and real paths when they differ. Directory or glob searches are not expanded to discover protected descendants.

## Covered modification paths

The plugin intercepts:

- `write`
- `edit` / `apply_patch`
- `ast_edit`
- `delete`
- `move`
- LSP modification operations
- Common Bash commands with explicit write targets

Bash checks cover shell output redirection, `rm`, `rmdir`, `mkdir`, `mktemp`, `touch`, `truncate`, `cp`, `mv`, `install`, `ln`, `chmod`, `chown`, `chgrp`, `tee`, `dd of=`, in-place `sed` and `perl`, and mutating Git commands. Structured Bash `cwd`, `cd`, Git `-C`, glob paths, home paths, and symbolic links are resolved before comparison. A new temporary namespace receives process-local ownership only after the tool result confirms that it was created. For `mktemp`, the plugin claims only a newly added top-level namespace whose exact reported path matches the explicit trailing-`X` template. For `eval`, it claims only a newly added top-level namespace whose exact path appears in the successful result.

`git push` detection covers direct calls, wrappers, `git -C`, Git global options, and compound commands. `gitPush: "deny"` rejects immediately without opening a confirmation dialog. `"prompt"` requests separate confirmation. `"allow"` still preserves repository path checks.

Regular files, archive entries, and SQLite row writes are evaluated using their underlying file paths. `local://`, `xd://`, and `agent://` are OMP internal resources and are not treated as external files. `conflict://` writes are evaluated using the underlying conflict files registered by the current session.

Arbitrary LSP `request` calls remain separately confirmed because a protocol request can trigger server-initiated workspace edits whose complete targets are unavailable before execution.

## Security boundary

This plugin guards against accidental writes. It is not an operating-system sandbox. A shell parser cannot prove the actual side effects of an arbitrary command.

Auto-approved Bash trusts project runners and scripts such as `just`, `make`, `npm`, `cargo`, Python, and project binaries. They can read protected paths or files, or write outside the workspace, when the final path is not visible in the tool arguments. When `temporary.allowAll` is enabled, explicit writes to strict descendants of `temporary.root` also intentionally bypass `externalWrites`; the root itself does not. Command substitution, dynamic shell expansion, sourced scripts, aliases, functions, unknown commands, directory searches, and glob searches have the same limitation. Temporary-root snapshots only identify reported new namespaces; they do not audit other code side effects.

Use Bubblewrap, a container, or a virtual machine when an enforceable filesystem boundary is required.

## Tests

Requires Node.js 22.18 or later:

```bash
npm test
```

Tests cover protected path and file prompts and denials, workspace and external writes, configuration precedence, allowlist and protected-path priority, temporary namespace ownership, remembered directory approval, symbolic-link escapes, AST and LSP edits, Bash redirection, Git commands, `cwd` and `cd`, and common file modification commands.
