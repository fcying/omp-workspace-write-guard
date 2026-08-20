# OMP Workspace Write Guard Development Rules

## Scope

This file applies to the entire repository.

## Project Goal

This plugin provides low-prompt workspace write protection for OMP:

- Reads from any location are allowed.
- Direct file modifications inside the current workspace are allowed.
- Direct modifications outside the workspace follow the configured `externalWrites` policy.
- After interactive approval, the real parent directory is remembered only for the current OMP process and workspace.
- An unapproved external modification is denied when no interactive UI is available.
- `git push` follows its independent configured policy and defaults to denial.

This plugin is an accidental-write guard, not an operating-system sandbox. Never claim that it can statically prove the filesystem side effects of arbitrary scripts, task runners, or programs.

## Repository Structure

- `.omp-plugin/marketplace.json`: OMP marketplace catalog for repository-based discovery, installation, and upgrades.
- `index.ts`: OMP extension entry point, path normalization, symbolic-link resolution, configured policy enforcement, directory approval cache, and confirmation flow.
- `bash-targets.ts`: explicit Bash write-target and `git push` detection.
- `config.ts` and `workspace-write-guard.json`: layered configuration loading, validation, and defaults.
- `README.md` and `README.zh-CN.md`: synchronized English-default and Chinese installation, configuration, supported behavior, and security boundaries.
- `package.json`: OMP plugin manifest and package version.

## Implementation Rules

- Use TypeScript ESM and Node.js built-in modules. Do not add runtime dependencies without a demonstrated need.
- Use English for identifiers and code comments.
- Base boundary decisions on normalized real paths. Workspace-local symbolic links must not allow writes to escape into external directories.
- Resolve missing targets through their nearest existing parent. A target must not bypass checks merely because the file or child directory does not exist yet.
- Keep external directory approvals in memory only and isolate them by workspace. Do not persist or share them across OMP restarts.
- Approving a directory allows only that directory and its descendants. Never broaden approval to its parent or sibling directories.
- Fail closed for explicit write targets that cannot be resolved reliably: request confirmation when a UI exists and deny without a UI.
- Treat `local://` and `xd://` as OMP internal resources rather than ordinary external filesystem paths.
- Continue to confirm arbitrary LSP `request` calls. Known rename and code-action operations wholly inside the workspace should not create extra prompts.
- Bash parsing protects only explicit write targets visible in the command line. Any coverage change must preserve an accurate security-boundary section in `README.md`.
- Detect direct, wrapped, `git -C`, Git-global-option, and compound-command forms of `git push`; apply the configured policy without bypassing external repository checks.
- Do not add compatibility aliases, deprecated entry points, speculative features, or unnecessary abstractions. Keep the implementation conservative and auditable.

## Verification

Run these commands after every behavioral change:

```bash
npm test
node --check index.ts
node --check bash-targets.ts
node --check config.ts
node --check tests/workspace-write-guard.test.mjs
npm pack --dry-run
omp plugin discover fcying-omp-plugins --json
```

New or changed permission rules require behavioral tests that fail under a plausible incorrect implementation. Keep coverage for:

- Writes inside the workspace being allowed.
- Writes to unapproved external directories being denied.
- Reuse of an approved directory and its descendants without approving sibling directories.
- Symbolic-link escapes being denied.
- Fail-closed behavior without a UI.
- Common read-only Bash commands and project runners not being falsely blocked.
- Explicit Bash writes outside the workspace being denied.
- Every supported `git push` form following the configured policy without prompts under the default denial policy.

Tests must not contact real remotes, perform a real push, or modify persistent files outside the repository. Use temporary directories and Git repositories without remotes.

## Release and Git Rules

- Update `README.md` and the `package.json` version for user-visible behavior changes.
- Ensure `package.json#files` contains every runtime source file.
- Agents may inspect status, diffs, and history, but must never run `git push`.
- Do not create commits unless the user explicitly requests one. The user reviews, commits, and pushes changes.
