# OMP Workspace Write Guard

Adds low-prompt workspace write protection to Oh My Pi, similar to OpenCode's `external_directory` permission.

## Behavior

- Reads anywhere are allowed automatically.
- Direct file modifications inside the current workspace are allowed automatically.
- Direct file modifications outside the workspace require interactive confirmation.
- Approving an external target remembers its real parent directory for the current OMP process and workspace. Later writes in that directory or its descendants do not prompt again.
- Approvals reset when OMP restarts and are not shared across different workspaces.
- External writes are denied when no interactive UI is available and the directory has not already been approved.
- Symbolic links are resolved before checking or remembering a directory.
- Common explicit Bash writes are checked when Bash is configured for automatic approval.

## Recommended low-prompt configuration

Keep the normal `write` approval mode, but auto-approve Bash:

```bash
omp config set tools.approvalMode write
omp config set tools.approval '{"bash":"allow"}'
```

This removes approval prompts for commands such as:

```bash
git rev-parse HEAD
just test
npm test
cargo build
```

OMP's critical destructive-command guard may still force a prompt. Other executable tools such as `eval`, `task`, and `browser` retain OMP's normal approval behavior.

Do not use `yolo` unless you accept that arbitrary executable tools can bypass path checks.

## Install

```bash
omp plugin install https://github.com/fcying/omp-workspace-write-guard
omp config set tools.approvalMode write
omp config set tools.approval '{"bash":"allow"}'
```

Restart OMP after installing or updating. A new process also loads the plugin when restoring an old session, unless it uses `--no-extensions`, another profile, or another `PI_CODING_AGENT_DIR`.

For local development:

```bash
omp plugin link /path/to/workspace-write-guard
```

## Covered modification paths

The plugin intercepts:

- `write`
- `edit` / `apply_patch`
- `ast_edit`
- `delete`
- `move`
- LSP modification operations
- Common Bash commands with explicit write targets

Bash checks cover shell output redirection, `rm`, `rmdir`, `mkdir`, `touch`, `truncate`, `cp`, `mv`, `install`, `ln`, `chmod`, `chown`, `chgrp`, `tee`, `dd of=`, in-place `sed`/`perl`, and mutating Git commands. Structured Bash `cwd`, `cd`, Git `-C`, globs, home paths, and symbolic links are resolved before comparison.

`git push` is always blocked immediately, including wrapped, `git -C`, and compound-command forms. It never opens an approval dialog and cannot be remembered or allowed for the process.

Regular files, archive entries, and SQLite row writes are evaluated using their underlying file paths. `local://` and `xd://` are OMP session resources and are not treated as external files.

LSP `request` remains separately confirmed because an arbitrary protocol request can cause server-initiated workspace edits whose targets are not available before execution.

## Security boundary

This plugin is a guard against accidental writes, not an operating-system sandbox. A shell parser cannot prove the runtime side effects of arbitrary commands.

In particular, auto-approved Bash trusts project runners and scripts such as `just`, `make`, `npm`, `cargo`, Python, and project binaries. A recipe or script can write outside the workspace without showing the final target in the Bash tool arguments. Command substitution, dynamic shell expansion, sourced scripts, aliases, functions, and unknown commands have the same limitation.

Use Bubblewrap, a container, or a virtual machine when an enforceable filesystem boundary is required.

## Tests

Node.js 22.18 or later:

```bash
npm test
```

Tests cover workspace and external writes, remembered directory approval, symbolic-link escapes, AST and LSP edits, Bash redirection, Git commands, `cwd`/`cd`, and common file mutation commands.
