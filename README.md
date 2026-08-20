# OMP Workspace Write Guard

Adds write-confirmation behavior to Oh My Pi similar to OpenCode's `external_directory` permission:

- Reads and file modifications within the current workspace are allowed automatically.
- Reads outside the workspace are allowed automatically.
- Direct file modifications outside the workspace require interactive confirmation.
- Direct file modifications outside the workspace are denied when no interactive UI is available.
- Symbolic links inside the workspace that point to external directories are treated as paths outside the workspace.
- Arbitrary code-execution tools such as `bash`, `eval`, `task`, and `browser` continue to use OMP's own approval system.

## Requirements

- OMP 17.3.8 or later.
- `tools.approvalMode` must be set to `write`.

```bash
omp config set tools.approvalMode write
```

Do not use `yolo` or explicitly set `bash`, `eval`, `task`, or `browser` to `allow`. These tools can write to arbitrary paths indirectly, and their final write targets cannot be determined reliably from tool arguments alone.

## Install from GitHub

After publishing the repository, run the following commands on another machine:

```bash
omp plugin install https://github.com/<github-user>/omp-workspace-write-guard
omp config set tools.approvalMode write
```

Then restart OMP. The plugin is also loaded when a new process restores an existing session, unless `--no-extensions`, a different profile, or a different `PI_CODING_AGENT_DIR` is used.

## Link Locally

```bash
omp plugin link /path/to/omp-workspace-write-guard
omp config set tools.approvalMode write
```

If this repository is located directly under `~/.omp/agent/extensions/`, OMP discovers it automatically and no additional link is required.

## Coverage

The plugin intercepts the following direct modification entry points:

- `write`
- `edit` / `apply_patch`
- `ast_edit`
- `delete`
- `move`
- LSP modification operations

Paths are normalized and symbolic links are resolved. Regular files, archive entries, and SQLite row writes are evaluated using their underlying file paths. `local://` and `xd://` are internal OMP session resources and are not treated as external files.

LSP rename and code-action operations may return workspace edits that affect multiple files. Because the complete target list cannot be known before invocation, LSP modification operations always require separate confirmation.

## Security Boundary

This plugin is not an operating-system sandbox. It prevents models from accidentally modifying files outside the current workspace through OMP file tools, but it cannot analyze the runtime side effects of arbitrary programs.

OMP's native execution approval remains the security boundary for:

- Shell commands and project scripts.
- Python and JavaScript evaluation.
- Browser scripts.
- Subagents and external tools.
- In-process code from third-party plugins.

Use Bubblewrap, a container, or a virtual machine when an enforceable filesystem boundary is required.

## Tests

Node.js 22.18 or later:

```bash
npm test
```

The tests cover writes inside the workspace, denial outside the workspace, interactive approval and denial, symbolic-link escapes, AST edits, and LSP modification behavior.
