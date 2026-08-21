import { loadGuardConfig, type GuardConfig } from "./config.ts";
import { bashWriteTargets } from "./bash-targets.ts";
import { lstat, readdir, readlink, realpath } from "node:fs/promises";
import { homedir } from "node:os";
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
const pendingTemporaryChecks = new Map<string, {
  workspace: string;
  candidates: string[];
  temporaryRoot?: string;
  existingNamespaces?: Set<string>;
  temporaryTemplates?: Array<{ template: string; base: string }>;
  acceptReportedNamespaces?: true;
}>();
const resolvedConfigs = new Map<string, Promise<ResolvedGuardConfig>>();

type ToolInput = Record<string, unknown>;

type Target =
  | { kind: "path"; value: string; base?: string; creates?: true; access?: "read"; temporaryTemplate?: true }
  | { kind: "opaque"; value: string }
  | { kind: "git-push" };

interface ResolvedGuardConfig {
  values: GuardConfig;
  allowPaths: string[];
  protectedPaths: string[];
  protectedFileNames: Set<string>;
  temporaryRoot: string;
}

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

function bulkConflictIds(content: unknown): number[] | undefined {
  if (typeof content !== "string") return undefined;
  const lines = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return undefined;

  const ids = new Set<number>();
  for (const line of lines) {
    const match = line.match(/^#?([1-9][0-9]*)\s*[:=]\s*@(ours|theirs|base|both)$/);
    if (!match) return undefined;
    ids.add(Number(match[1]));
  }
  return [...ids];
}

function conflictTargets(raw: string, content: unknown, conflictPaths: ReadonlyMap<number, string>): Target[] | undefined {
  const value = cleanPath(raw);
  const match = value.match(/^(?:(.+):)?conflict:\/\/(.+)$/);
  if (!match) return undefined;

  const id = match[2];
  if (id === "*") {
    const selected = bulkConflictIds(content);
    if (selected) {
      return selected.map((selectedId) => {
        const path = conflictPaths.get(selectedId);
        return path ? { kind: "path", value: path } : { kind: "opaque", value: `conflict://${selectedId}` };
      });
    }
    const paths = [...new Set(conflictPaths.values())];
    return paths.length > 0
      ? paths.map((path) => ({ kind: "path", value: path }))
      : [{ kind: "opaque", value }];
  }
  if (!/^[1-9][0-9]*$/.test(id)) return [{ kind: "opaque", value }];

  const path = conflictPaths.get(Number(id));
  return path ? [{ kind: "path", value: path }] : [{ kind: "opaque", value }];
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

function readTarget(raw: string): Target | undefined {
  const selector = /:(?:raw(?::\d+(?:-\d*|\+\d+)?(?:,\d+(?:-\d*|\+\d+)?)*)?|\d+(?:-\d*|\+\d+)?(?:,\d+(?:-\d*|\+\d+)?)*(?::raw)?|conflicts)$/;
  const value = cleanPath(raw).replace(selector, "");
  const target = writeTarget(value);
  return target?.kind === "path" ? { ...target, access: "read" } : undefined;
}

function targetsFor(toolName: string, input: ToolInput, cwd: string, conflictPaths: ReadonlyMap<number, string>): Target[] {
  if (toolName === "write") {
    return strings(input.path).flatMap((value) => {
      const conflicts = conflictTargets(value, input.content, conflictPaths);
      if (conflicts) return conflicts;
      const target = writeTarget(value, true);
      return target ? [target] : [];
    });
  }

  if (toolName === "read") {
    return strings(input.path).flatMap((value) => {
      const target = readTarget(value);
      return target ? [target] : [];
    });
  }

  if (toolName === "grep") {
    return strings(input.path).flatMap((paths) => paths.split(";").flatMap((value) => {
      if (/[?*[{]/.test(value)) return [];
      const target = readTarget(value);
      return target ? [target] : [];
    }));
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

function normalizedPath(path: string, cwd: string): string {
  const expanded = expandHome(cleanPath(path));
  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

async function canonicalPath(path: string, cwd: string, depth = 0): Promise<string> {
  if (depth > 32) throw new Error(`Too many symbolic links: ${path}`);

  const absolute = normalizedPath(path, cwd);
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

async function temporaryNamespaces(temporaryRoot: string): Promise<Set<string> | undefined> {
  try {
    return new Set((await readdir(temporaryRoot)).map((name) => join(temporaryRoot, name)));
  } catch (error) {
    if (errorCode(error) === "ENOENT") return new Set();
    return undefined;
  }
}

function matchesTemporaryTemplate(template: string, candidate: string): boolean {
  if (dirname(template) !== dirname(candidate)) return false;
  const templateName = basename(template);
  const placeholder = /X{3,}$/.exec(templateName);
  if (!placeholder) return false;
  const candidateName = basename(candidate);
  const prefix = templateName.slice(0, placeholder.index);
  const random = candidateName.slice(prefix.length);
  return candidateName.startsWith(prefix) && random.length === placeholder[0].length && /^[A-Za-z0-9]+$/.test(random);
}



function unique(values: string[]): string[] {
  return [...new Set(values)];
}

async function resolveGuardConfig(agentDir: string, workspace: string): Promise<ResolvedGuardConfig> {
  const values = await loadGuardConfig(agentDir, workspace);
  const allowPaths = await Promise.all(values.allowPaths.map((path) => canonicalPath(path, workspace)));
  const protectedPaths = await Promise.all(values.protectedPaths.paths.map((path) => canonicalPath(path, workspace)));
  const protectedFileNames = new Set(values.protectedFiles.names);
  const temporaryRoot = await canonicalPath(values.temporary.root, workspace);
  return { values, allowPaths, protectedPaths, protectedFileNames, temporaryRoot };
}

function overlapsConfiguredPath(target: string, configuredPaths: string[]): boolean {
  return configuredPaths.some((path) => isWithin(path, target) || isWithin(target, path));
}


function isAllowedByConfig(target: string, allowPaths: string[]): boolean {
  return allowPaths.some((path) => isWithin(path, target));
}

export default function workspaceWriteGuard(pi: ExtensionAPI): void {
  pi.setLabel("Workspace write guard");
  const agentDir = pi.pi.getAgentDir();
  const conflictPaths = new Map<number, string>();

  pi.on("tool_call", async (event, ctx) => {
    const input = event.input;
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return { block: true, reason: `Invalid input for ${event.toolName}` };
    }

    const targets = targetsFor(event.toolName, input, ctx.cwd, conflictPaths);
    const observesTemporary = event.toolName === "eval" || targets.some((target) =>
      target.kind === "path" && target.temporaryTemplate === true
    );
    if (targets.length === 0 && !observesTemporary) return;

    let root: string;
    let config: ResolvedGuardConfig;
    try {
      root = await realpath(ctx.cwd);
      const key = `${agentDir}\0${root}`;
      let pending = resolvedConfigs.get(key);
      if (!pending) {
        pending = resolveGuardConfig(agentDir, root);
        resolvedConfigs.set(key, pending);
      }
      config = await pending;
    } catch (error) {
      return {
        block: true,
        reason: `Workspace write guard configuration error: ${error instanceof Error ? error.message : String(error)}`,
      };
    }


    const gitPush = targets.some((target) => target.kind === "git-push");
    if (gitPush && config.values.gitPush === "deny") {
      return { block: true, reason: "git push is blocked by workspace write guard configuration" };
    }

    const approvedDirectories = approvedDirectorySet(root);
    const ownedTemporaryPaths = ownedTemporaryPathSet(root);
    const existingTemporaryNamespaces = observesTemporary && config.values.temporary.allowOwned
      ? await temporaryNamespaces(config.temporaryRoot)
      : undefined;
    if (targets.length === 0) {
      if (existingTemporaryNamespaces && typeof event.toolCallId === "string") {
        pendingTemporaryChecks.set(event.toolCallId, {
          workspace: root,
          candidates: [],
          temporaryRoot: config.temporaryRoot,
          existingNamespaces: existingTemporaryNamespaces,
          acceptReportedNamespaces: true,
        });
      }
      return;
    }
    const provisionalTemporaryPaths = new Set<string>();
    const temporaryCandidates = new Set<string>();
    const temporaryTemplates: Array<{ template: string; base: string }> = [];
    const external: Array<{ display: string; directory?: string }> = [];
    const protectedTargets: Array<{ display: string; access: "read" | "write" }> = [];
    const commandRequests = gitPush && config.values.gitPush === "prompt" ? ["git push"] : [];

    for (const target of targets) {
      if (target.kind === "git-push") continue;
      if (target.kind === "opaque") {
        if (config.values.externalWrites !== "allow") external.push({ display: target.value });
        continue;
      }

      const base = target.base ?? ctx.cwd;
      const requested = normalizedPath(target.value, base);
      try {
        const resolved = await canonicalPath(target.value, base);
        const fileProtected = config.protectedFileNames.has(basename(requested)) || config.protectedFileNames.has(basename(resolved));
        const pathProtected = target.access === "read"
          ? config.protectedPaths.some((path) => isWithin(path, resolved))
          : overlapsConfiguredPath(resolved, config.protectedPaths);
        const protectedDisplay = requested === resolved ? requested : `${requested} -> ${resolved}`;
        if (fileProtected && config.values.protectedFiles.policy === "deny") {
          return { block: true, reason: `Protected file access denied by configuration: ${protectedDisplay}` };
        }
        if (pathProtected && config.values.protectedPaths.policy === "deny") {
          return { block: true, reason: `Protected path access denied by configuration: ${protectedDisplay}` };
        }
        if (fileProtected || pathProtected) {
          protectedTargets.push({ display: protectedDisplay, access: target.access ?? "write" });
        }
        if (target.access === "read") continue;
        if (
          isAllowedByConfig(resolved, config.allowPaths) ||
          isWithin(root, resolved) ||
          isApproved(resolved, approvedDirectories) ||
          isApproved(resolved, ownedTemporaryPaths) ||
          isApproved(resolved, provisionalTemporaryPaths)
        ) {
          continue;
        }

        if (target.temporaryTemplate && existingTemporaryNamespaces) {
          const namespaceTemplate = temporaryNamespace(config.temporaryRoot, resolved);
          if (namespaceTemplate === resolved) {
            temporaryTemplates.push({ template: resolved, base });
            continue;
          }
        }
        const namespace = config.values.temporary.allowOwned && target.creates
          ? temporaryNamespace(config.temporaryRoot, resolved)
          : undefined;
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

        if (config.values.externalWrites !== "allow") {
          external.push({ display: resolved, directory: await approvalDirectory(resolved) });
        }
      } catch (error) {
        const fileProtected = config.protectedFileNames.has(basename(requested));
        if (fileProtected && config.values.protectedFiles.policy === "deny") {
          return { block: true, reason: `Protected file access denied by configuration: ${requested}` };
        }
        if (config.protectedPaths.length > 0 && config.values.protectedPaths.policy === "deny") {
          return { block: true, reason: `Cannot verify path against workspace write guard protectedPaths: ${target.value}` };
        }
        if (fileProtected || config.protectedPaths.length > 0) {
          protectedTargets.push({ display: `${requested} (unresolved)`, access: target.access ?? "write" });
        }
        if (target.access === "read") continue;
        if (config.values.externalWrites !== "allow") {
          external.push({
            display: error instanceof Error ? `${target.value} (${error.message})` : `${target.value} (unresolved)`,
          });
        }
      }
    }

    const protectedRequests = unique(
      protectedTargets.map(({ display, access }) => `${access}: ${display}`),
    );

    const requested = unique([
      ...commandRequests,
      ...external.map(({ display }) => display),
    ]);
    if (protectedRequests.length === 0 && requested.length === 0) {
      if (
        typeof event.toolCallId === "string" &&
        (temporaryCandidates.size > 0 || existingTemporaryNamespaces || temporaryTemplates.length > 0)
      ) {
        pendingTemporaryChecks.set(event.toolCallId, {
          workspace: root,
          candidates: [...temporaryCandidates],
          temporaryRoot: existingTemporaryNamespaces ? config.temporaryRoot : undefined,
          existingNamespaces: existingTemporaryNamespaces,
          temporaryTemplates,
          ...(event.toolName === "eval" ? { acceptReportedNamespaces: true as const } : {}),
        });
      }
      return;
    }

    if (external.length > 0 && config.values.externalWrites === "deny") {
      return { block: true, reason: `Write outside workspace denied by configuration: ${requested.join(", ")}` };
    }
    if (!ctx.hasUI) {
      const subject = protectedRequests.length > 0
        ? "Protected access"
        : commandRequests.length > 0 ? "Operation outside workspace" : "Write outside workspace";
      return { block: true, reason: `${subject} blocked without interactive approval: ${[...protectedRequests, ...requested].join(", ")}` };
    }

    const rememberedDirectories = unique(
      external.flatMap(({ directory }) => (directory ? [directory] : [])),
    );
    const rememberNotice = rememberedDirectories.length > 0
      ? `\n\nRemember for this OMP process:\n${rememberedDirectories.map((path) => `- ${path}`).join("\n")}`
      : "";
    const protectedOnly = protectedRequests.length > 0 && requested.length === 0;
    const outsideOnly = protectedRequests.length === 0;
    const title = protectedOnly
      ? "Allow protected access?"
      : outsideOnly
        ? commandRequests.length > 0 ? "Allow operation outside workspace?" : "Allow write outside workspace?"
        : "Allow protected access outside workspace?";
    const protectedNotice = protectedRequests.length > 0
      ? `\n\nProtected targets:\n${protectedRequests.map((path) => `- ${path}`).join("\n")}`
      : "";
    const outsideNotice = requested.length > 0
      ? `\n\nTargets:\n${requested.map((path) => `- ${path}`).join("\n")}`
      : "";
    const approved = await ctx.ui.confirm(
      title,
      `Workspace: ${root}${protectedNotice}${outsideNotice}${rememberNotice}`,
    );
    if (!approved) {
      const subject = protectedRequests.length > 0
        ? "protected access"
        : commandRequests.length > 0 ? "operation outside workspace" : "write outside workspace";
      return {
        block: true,
        reason: `User denied ${subject}: ${[...protectedRequests, ...requested].join(", ")}`,
      };
    }

    for (const directory of rememberedDirectories) approvedDirectories.add(directory);
    if (
      typeof event.toolCallId === "string" &&
      (temporaryCandidates.size > 0 || existingTemporaryNamespaces || temporaryTemplates.length > 0)
    ) {
      pendingTemporaryChecks.set(event.toolCallId, {
        workspace: root,
        candidates: [...temporaryCandidates],
        temporaryRoot: existingTemporaryNamespaces ? config.temporaryRoot : undefined,
        existingNamespaces: existingTemporaryNamespaces,
        temporaryTemplates,
        ...(event.toolName === "eval" ? { acceptReportedNamespaces: true as const } : {}),
      });
    }
  });

  pi.on("tool_result", async (event) => {
    if (event.toolName === "read" && !event.isError) {
      const details = event.details;
      if (
        details && typeof details === "object" &&
        "resolvedPath" in details && typeof details.resolvedPath === "string" &&
        "conflictCount" in details && typeof details.conflictCount === "number" && details.conflictCount > 0
      ) {
        const text = event.content
          .filter((item): item is { type: "text"; text: string } => item.type === "text")
          .map((item) => item.text)
          .join("\n");
        const ids = [...text.matchAll(/(?:^|\n)(?:────\s+)?#\s*([1-9][0-9]*)\s+L[0-9]+(?:-[0-9]+)?(?:\s|$)/g)]
          .slice(-details.conflictCount);
        for (const match of ids) conflictPaths.set(Number(match[1]), details.resolvedPath);
      }
    }

    if (event.toolName === "write" && !event.isError && typeof event.input.path === "string") {
      const conflict = cleanPath(event.input.path).match(/^(?:(.+):)?conflict:\/\/(.+)$/);
      if (conflict?.[2] === "*") {
        const directives = String(event.input.content ?? "")
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => line.match(/^#?([1-9][0-9]*)\s*[:=]\s*@(ours|theirs|base|both)$/));
        if (directives.length > 0 && directives.every(Boolean)) {
          for (const directive of directives) conflictPaths.delete(Number(directive?.[1]));
        } else {
          conflictPaths.clear();
        }
      } else if (conflict && /^[1-9][0-9]*$/.test(conflict[2])) {
        conflictPaths.delete(Number(conflict[2]));
      }
    }

    const pending = pendingTemporaryChecks.get(event.toolCallId);
    if (!pending) return;
    pendingTemporaryChecks.delete(event.toolCallId);

    const ownedTemporaryPaths = ownedTemporaryPathSet(pending.workspace);
    if (!event.isError) {
      const candidates = new Set(pending.candidates);
      if (pending.temporaryRoot && pending.existingNamespaces) {
        const currentNamespaces = await temporaryNamespaces(pending.temporaryRoot);
        const reportedLines = event.content
          .filter((item): item is { type: "text"; text: string } => item.type === "text")
          .flatMap((item) => item.text.split(/\r?\n/).map((line) => line.trim()))
          .filter(Boolean);
        const reportedPaths = new Set(reportedLines);
        if (currentNamespaces) {
          for (const namespace of currentNamespaces) {
            if (pending.existingNamespaces.has(namespace)) continue;
            const templateReported = pending.temporaryTemplates?.some(({ template, base }) =>
              matchesTemporaryTemplate(template, namespace) &&
              reportedLines.some((line) => normalizedPath(line, base) === namespace)
            ) === true;
            if (
              templateReported ||
              (pending.acceptReportedNamespaces && reportedPaths.has(namespace))
            ) {
              candidates.add(namespace);
            }
          }
        }
      }

      for (const candidate of candidates) {
        try {
          await lstat(candidate);
          ownedTemporaryPaths.add(candidate);
        } catch {
          // A self-cleaning operation owns no persistent path.
        }
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
