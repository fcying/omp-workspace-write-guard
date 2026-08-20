import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

export const CONFIG_FILE_NAME = "workspace-write-guard.json";

export type ExternalWritePolicy = "allow" | "deny" | "prompt";
export type GitPushPolicy = "allow" | "deny" | "prompt";

export interface GuardConfig {
  externalWrites: ExternalWritePolicy;
  allowPaths: string[];
  denyPaths: string[];
  temporary: {
    root: string;
    allowOwned: boolean;
  };
  gitPush: GitPushPolicy;
}

type PartialGuardConfig = {
  externalWrites?: ExternalWritePolicy;
  allowPaths?: string[];
  denyPaths?: string[];
  temporary?: {
    root?: string;
    allowOwned?: boolean;
  };
  gitPush?: GitPushPolicy;
};

const CONFIG_KEYS: Record<string, true> = {
  externalWrites: true,
  allowPaths: true,
  denyPaths: true,
  temporary: true,
  gitPush: true,
};
const TEMPORARY_KEYS: Record<string, true> = { root: true, allowOwned: true };

function policy(value: unknown, key: string, source: string): ExternalWritePolicy | undefined {
  if (value === undefined) return undefined;
  if (value === "allow" || value === "deny" || value === "prompt") return value;
  throw new Error(`${source}: ${key} must be allow, deny, or prompt`);
}

function pathList(value: unknown, key: string, source: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw new Error(`${source}: ${key} must be an array of non-empty paths`);
  }
  if (value.some((item) => /[?*[{]/.test(item))) {
    throw new Error(`${source}: ${key} does not support glob patterns`);
  }
  return value.map((item) => item.trim());
}

function parseConfig(value: unknown, source: string): PartialGuardConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${source}: config must be a JSON object`);
  }
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!Object.hasOwn(CONFIG_KEYS, key)) throw new Error(`${source}: unknown setting ${key}`);
  }

  let temporary: PartialGuardConfig["temporary"];
  if (raw.temporary !== undefined) {
    if (typeof raw.temporary !== "object" || raw.temporary === null || Array.isArray(raw.temporary)) {
      throw new Error(`${source}: temporary must be an object`);
    }
    const rawTemporary = raw.temporary as Record<string, unknown>;
    for (const key of Object.keys(rawTemporary)) {
      if (!Object.hasOwn(TEMPORARY_KEYS, key)) {
        throw new Error(`${source}: unknown temporary setting ${key}`);
      }
    }
    const root = rawTemporary.root;
    const allowOwned = rawTemporary.allowOwned;
    if (root !== undefined && (typeof root !== "string" || root.trim() === "")) {
      throw new Error(`${source}: temporary.root must be a non-empty path`);
    }
    if (allowOwned !== undefined && typeof allowOwned !== "boolean") {
      throw new Error(`${source}: temporary.allowOwned must be boolean`);
    }
    temporary = {
      ...(typeof root === "string" ? { root: root.trim() } : {}),
      ...(typeof allowOwned === "boolean" ? { allowOwned } : {}),
    };
  }

  const externalWrites = policy(raw.externalWrites, "externalWrites", source);
  const allowPaths = pathList(raw.allowPaths, "allowPaths", source);
  const denyPaths = pathList(raw.denyPaths, "denyPaths", source);
  const gitPush = policy(raw.gitPush, "gitPush", source);
  return {
    ...(externalWrites ? { externalWrites } : {}),
    ...(allowPaths ? { allowPaths } : {}),
    ...(denyPaths ? { denyPaths } : {}),
    ...(temporary ? { temporary } : {}),
    ...(gitPush ? { gitPush } : {}),
  };
}

async function readConfig(path: string, required: boolean): Promise<PartialGuardConfig | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (!required && error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }

  try {
    return parseConfig(JSON.parse(raw), path);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${path}: invalid JSON: ${error.message}`);
    throw error;
  }
}

function mergeConfig(base: GuardConfig, override: PartialGuardConfig): GuardConfig {
  return {
    externalWrites: override.externalWrites ?? base.externalWrites,
    allowPaths: override.allowPaths ?? base.allowPaths,
    denyPaths: override.denyPaths ?? base.denyPaths,
    temporary: {
      root: override.temporary?.root ?? base.temporary.root,
      allowOwned: override.temporary?.allowOwned ?? base.temporary.allowOwned,
    },
    gitPush: override.gitPush ?? base.gitPush,
  };
}

export async function loadGuardConfig(agentDir: string, workspace: string): Promise<GuardConfig> {
  const bundledPath = fileURLToPath(new URL(`./${CONFIG_FILE_NAME}`, import.meta.url));
  const bundled = await readConfig(bundledPath, true);
  let config = mergeConfig({
    externalWrites: "prompt",
    allowPaths: [],
    denyPaths: [],
    temporary: { root: "/tmp", allowOwned: true },
    gitPush: "deny",
  }, bundled ?? {});

  for (const path of [join(agentDir, CONFIG_FILE_NAME), join(workspace, ".omp", CONFIG_FILE_NAME)]) {
    const override = await readConfig(path, false);
    if (override) config = mergeConfig(config, override);
  }
  return config;
}
