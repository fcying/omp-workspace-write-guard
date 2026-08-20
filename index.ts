import { bashWriteTargets } from "./bash-targets.ts";
import { lstat, readlink, realpath } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const EDIT_SECTION = /^\[([^\]\r\n]+)#[0-9A-F]{4}\]\s*$/gm;
const PATCH_FILE = /^\*\*\* (Add|Update|Delete) File:\s*(.+)\s*$/gm;
const PATCH_MOVE = /^\*\*\* Move to:\s*(.+)\s*$/gm;
const EDIT_MOVE = /^MV\s+(.+?)\s*$/gm;
const ARCHIVE_OR_DB = /^(.*\.(?:tar\.gz|tgz|tar|zip|jar|war|ear|apk|sqlite|sqlite3|db|db3)):/i;
const MUTATING_LSP_ACTIONS: Record<string, true> = {
  rename: true,
  rename_file: true,
  code_actions: true,
  request: true,
};
const approvedDirectoriesByWorkspace = new Map<string, Set<string>>();
const ownedTemporaryPathsByWorkspace = new Map<string, Set<string>>();
const pendingTemporaryChecks = new Map<string, { workspace: string; candidates: string[] }>();

type ToolInput = Record<string, unknown>;

type Target =
  | { kind: "path"; value: string; base?: string; creates?: true }
  | { kind: "opaque"; value: string }
  | { kind: "deny"; reason: string };

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  return [];
}
function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}


function patchTargets(value: unknown): Target[] {
  if (typeof value !== "string") return [];

  const targets: Target[] = [];
  EDIT_SECTION.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = EDIT_SECTION.exec(value)) !== null) {
    targets.push({ kind: "path", value: match[1].trim() });
  }

  PATCH_FILE.lastIndex = 0;
  while ((match = PATCH_FILE.exec(value)) !== null) {
    const target = { kind: "path" as const, value: match[2].trim() };
    targets.push(match[1] === "Add" ? { ...target, creates: true } : target);
  }

  for (const pattern of [PATCH_MOVE, EDIT_MOVE]) {
    pattern.lastIndex = 0;
    while ((match = pattern.exec(value)) !== null) {
      targets.push({ kind: "path", value: match[1].trim(), creates: true });
    }
  }
  return targets;
}

function cleanPath(raw: string): string {
  const value = raw.trim();
  const quote = value[0];
  if ((quote === '"' || quote === "'") && value.at(-1) === quote) return value.slice(1, -1);
  return value;
}

function writeTarget(raw: string, creates = false): Target | undefined {
  const wrapped = raw.match(/^\[(.*)#[0-9A-F]{4}\]$/);
  const value = cleanPath(wrapped?.[1] ?? raw);

  if (value.startsWith("xd://") || value.startsWith("local://")) return undefined;
  if (value.startsWith("file://")) {
    try {
      const target = { kind: "path" as const, value: fileURLToPath(value) };
      return creates ? { ...target, creates: true } : target;
    } catch {
      return { kind: "opaque", value };
    }
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    return { kind: "opaque", value };
  }

  const container = value.match(ARCHIVE_OR_DB)?.[1];
  const target = { kind: "path" as const, value: container ?? value };
  return creates ? { ...target, creates: true } : target;
}

function targetsFor(toolName: string, input: ToolInput, cwd: string): Target[] {
  if (toolName === "write") {
    return strings(input.path).map((value) => writeTarget(value, true)).filter((target): target is Target => target !== undefined);
  }

  if (toolName === "bash") {
    const command = typeof input.command === "string" ? input.command : "";
    const requestedCwd = typeof input.cwd === "string" ? input.cwd : undefined;
    return bashWriteTargets(command, cwd, requestedCwd);
  }

  if (toolName === "edit" || toolName === "apply_patch") {
    const explicit = [
      ...strings(input.path),
      ...strings(input.file),
    ].map((value) => ({ kind: "path" as const, value }));
    return [
      ...explicit,
      ...patchTargets(input.input),
      ...patchTargets(input.patch),
    ];
  }
  if (toolName === "ast_edit") {
    return strings(input.paths).map((value) => ({ kind: "path", value }));
  }

  if (toolName === "lsp") {
    const action = String(input.action ?? "");
    if (!Object.hasOwn(MUTATING_LSP_ACTIONS, action)) return [];
    if (action === "code_actions" && input.apply !== true) return [];
    if ((action === "rename" || action === "rename_file") && input.apply === false) return [];
    if (action === "request") return [{ kind: "opaque", value: "LSP request" }];

    const paths = strings(input.file).map((value) => ({ kind: "path" as const, value }));
    if (action === "rename_file") {
      paths.push(...strings(input.new_name).map((value) => ({ kind: "path" as const, value, creates: true as const })));
    }
    return paths;
  }

  if (toolName === "delete") {
    return [...strings(input.path), ...strings(input.file)].map((value) => ({ kind: "path", value }));
  }

  if (toolName === "move") {
    const sources = [
      ...strings(input.path),
      ...strings(input.source),
    ].map((value) => ({ kind: "path" as const, value }));
    const destinations = [
      ...strings(input.destination),
      ...strings(input.to),
    ].map((value) => ({ kind: "path" as const, value, creates: true as const }));
    return [...sources, ...destinations];
  }

  return [];
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith(`~${sep}`)) return join(homedir(), path.slice(2));
  return path;
}

async function canonicalPath(path: string, cwd: string, depth = 0): Promise<string> {
  if (depth > 32) throw new Error(`Too many symbolic links: ${path}`);

  const expanded = expandHome(cleanPath(path));
  const absolute = isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
  const missing: string[] = [];
  let cursor = absolute;

  for (;;) {
    try {
      const existing = await realpath(cursor);
      return missing.length === 0 ? existing : join(existing, ...missing.reverse());
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;

      try {
        const stat = await lstat(cursor);
        if (stat.isSymbolicLink()) {
          const link = await readlink(cursor);
          const destination = isAbsolute(link) ? link : resolve(dirname(cursor), link);
          return canonicalPath(join(destination, ...missing.reverse()), cwd, depth + 1);
        }
      } catch (linkError) {
        if (errorCode(linkError) !== "ENOENT") throw linkError;
      }

      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      missing.push(basename(cursor));
      cursor = parent;
    }
  }
}

function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
async function approvalDirectory(target: string): Promise<string> {
  let staticPath = target;
  while (/[?*[{]/.test(basename(staticPath))) staticPath = dirname(staticPath);

  try {
    const stat = await lstat(staticPath);
    return stat.isDirectory() ? staticPath : dirname(staticPath);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    return dirname(staticPath);
  }
}

function approvedDirectorySet(workspace: string): Set<string> {
  const existing = approvedDirectoriesByWorkspace.get(workspace);
  if (existing) return existing;

  const created = new Set<string>();
  approvedDirectoriesByWorkspace.set(workspace, created);
  return created;
}

function isApproved(target: string, approvedDirectories: Set<string>): boolean {
  for (const directory of approvedDirectories) {
    if (isWithin(directory, target)) return true;
  }
  return false;
}
function ownedTemporaryPathSet(workspace: string): Set<string> {
  const existing = ownedTemporaryPathsByWorkspace.get(workspace);
  if (existing) return existing;

  const created = new Set<string>();
  ownedTemporaryPathsByWorkspace.set(workspace, created);
  return created;
}

function temporaryNamespace(temporaryRoot: string, target: string): string | undefined {
  const rel = relative(temporaryRoot, target);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
  return join(temporaryRoot, rel.split(sep)[0]);
}


function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export default function workspaceWriteGuard(pi: ExtensionAPI): void {
  pi.setLabel("Workspace write guard");

  pi.on("tool_call", async (event, ctx) => {
    const input = event.input;
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return { block: true, reason: `Invalid input for ${event.toolName}` };
    }
    const targets = targetsFor(event.toolName, input, ctx.cwd);
    const denied = targets.find((target): target is Extract<Target, { kind: "deny" }> => target.kind === "deny");
    if (denied) return { block: true, reason: denied.reason };

    const root = await realpath(ctx.cwd);
    const temporaryRoot = await realpath(tmpdir());
    const approvedDirectories = approvedDirectorySet(root);
    const ownedTemporaryPaths = ownedTemporaryPathSet(root);
    const provisionalTemporaryPaths = new Set<string>();
    const temporaryCandidates = new Set<string>();
    const external: Array<{ display: string; directory?: string }> = [];

    for (const target of targets) {
      if (target.kind === "opaque") {
        external.push({ display: target.value });
        continue;
      }

      try {
        const resolved = await canonicalPath(target.value, target.base ?? ctx.cwd);
        if (
          isWithin(root, resolved) ||
          isApproved(resolved, approvedDirectories) ||
          isApproved(resolved, ownedTemporaryPaths) ||
          isApproved(resolved, provisionalTemporaryPaths)
        ) {
          continue;
        }

        const namespace = target.creates ? temporaryNamespace(temporaryRoot, resolved) : undefined;
        if (namespace) {
          try {
            await lstat(namespace);
          } catch (error) {
            if (errorCode(error) === "ENOENT") {
              provisionalTemporaryPaths.add(namespace);
              temporaryCandidates.add(namespace);
              continue;
            }
            throw error;
          }
        }

        external.push({ display: resolved, directory: await approvalDirectory(resolved) });
      } catch {
        external.push({ display: `${target.value} (unresolved)` });
      }
    }

    const requested = unique(external.map(({ display }) => display));
    if (requested.length === 0) {
      if (typeof event.toolCallId === "string" && targets.length > 0) {
        pendingTemporaryChecks.set(event.toolCallId, {
          workspace: root,
          candidates: [...temporaryCandidates],
        });
      }
      return;
    }

    if (!ctx.hasUI) {
      return {
        block: true,
        reason: `Write outside workspace blocked without interactive approval: ${requested.join(", ")}`,
      };
    }

    const rememberedDirectories = unique(
      external.flatMap(({ directory }) => (directory ? [directory] : [])),
    );
    const rememberNotice = rememberedDirectories.length > 0
      ? `\n\nRemember for this OMP process:\n${rememberedDirectories.map((path) => `- ${path}`).join("\n")}`
      : "";
    const approved = await ctx.ui.confirm(
      "Allow write outside workspace?",
      `Workspace: ${root}\n\nTargets:\n${requested.map((path) => `- ${path}`).join("\n")}${rememberNotice}`,
    );
    if (!approved) {
      return {
        block: true,
        reason: `User denied write outside workspace: ${requested.join(", ")}`,
      };
    }

    for (const directory of rememberedDirectories) approvedDirectories.add(directory);
    if (typeof event.toolCallId === "string" && targets.length > 0) {
      pendingTemporaryChecks.set(event.toolCallId, {
        workspace: root,
        candidates: [...temporaryCandidates],
      });
    }
  });

  pi.on("tool_result", async (event) => {
    const pending = pendingTemporaryChecks.get(event.toolCallId);
    if (!pending) return;
    pendingTemporaryChecks.delete(event.toolCallId);

    const ownedTemporaryPaths = ownedTemporaryPathSet(pending.workspace);
    for (const candidate of pending.candidates) {
      try {
        await lstat(candidate);
        ownedTemporaryPaths.add(candidate);
      } catch {
        // A failed or self-cleaning operation owns no persistent path.
      }
    }

    for (const owned of ownedTemporaryPaths) {
      try {
        await lstat(owned);
      } catch (error) {
        if (errorCode(error) === "ENOENT") ownedTemporaryPaths.delete(owned);
      }
    }
  });
}
