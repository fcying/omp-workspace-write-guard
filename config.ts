import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

export const CONFIG_FILE_NAME = "workspace-write-guard.json";

export type ExternalWritePolicy = "allow" | "deny" | "prompt";
export type GitPushPolicy = "allow" | "deny" | "prompt";
export type ProtectedAccessPolicy = "deny" | "prompt";

export interface GuardConfig {
  externalWrites: ExternalWritePolicy;
  allowPaths: string[];
  protectedPaths: {
    paths: string[];
    policy: ProtectedAccessPolicy;
  };
  protectedFiles: {
    names: string[];
    policy: ProtectedAccessPolicy;
  };
  temporary: {
    root: string;
    allowOwned: boolean;
  };
  gitPush: GitPushPolicy;
}

type PartialGuardConfig = {
  externalWrites?: ExternalWritePolicy;
  allowPaths?: string[];
  protectedPaths?: {
    paths?: string[];
    policy?: ProtectedAccessPolicy;
  };
  protectedFiles?: {
    names?: string[];
    policy?: ProtectedAccessPolicy;
  };
  temporary?: {
    root?: string;
    allowOwned?: boolean;
  };
  gitPush?: GitPushPolicy;
};

const CONFIG_KEYS: Record<string, true> = {
  externalWrites: true,
  allowPaths: true,
  protectedPaths: true,
  protectedFiles: true,
  temporary: true,
  gitPush: true,
};
const TEMPORARY_KEYS: Record<string, true> = { root: true, allowOwned: true };
const PROTECTED_PATH_KEYS: Record<string, true> = { paths: true, policy: true };
const PROTECTED_FILE_KEYS: Record<string, true> = { names: true, policy: true };

function policy(value: unknown, key: string, source: string): ExternalWritePolicy | undefined {
  if (value === undefined) return undefined;
  if (value === "allow" || value === "deny" || value === "prompt") return value;
  throw new Error(`${source}: ${key} must be allow, deny, or prompt`);
}

function protectedAccessPolicy(value: unknown, key: string, source: string): ProtectedAccessPolicy | undefined {
  if (value === undefined) return undefined;
  if (value === "deny" || value === "prompt") return value;
  throw new Error(`${source}: ${key} must be deny or prompt`);
}

const ENVIRONMENT_VARIABLE = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g;

function configuredPath(value: string, key: string, source: string): string {
  const expanded = value.trim().replace(ENVIRONMENT_VARIABLE, (_match, braced: string | undefined, bare: string | undefined) => {
    const name = braced ?? bare!;
    const environmentValue = process.env[name];
    if (environmentValue === undefined || environmentValue.length === 0) {
      throw new Error(`${source}: ${key} references undefined or empty environment variable ${name}`);
    }
    return environmentValue;
  });
  if (expanded.trim() === "") throw new Error(`${source}: ${key} must resolve to a non-empty path`);
  if (/[?*[{]/.test(expanded)) throw new Error(`${source}: ${key} does not support glob patterns`);
  return expanded;
}

function pathList(value: unknown, key: string, source: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw new Error(`${source}: ${key} must be an array of non-empty paths`);
  }
  return value.map((item, index) => configuredPath(item, `${key}[${index}]`, source));
}

function fileNameList(value: unknown, key: string, source: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw new Error(`${source}: ${key} must be an array of non-empty file names`);
  }
  return value.map((item, index) => {
    const name = item.trim();
    if (
      name === "." || name === ".." || name.includes("/") || name.includes("\\") ||
      name.includes("\0") || /[?*[{]/.test(name)
    ) {
      throw new Error(`${source}: ${key}[${index}] must be an exact file name, not a path or glob`);
    }
    return name;
  });
}

function parseConfig(value: unknown, source: string): PartialGuardConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${source}: config must be a JSON object`);
  }
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!Object.hasOwn(CONFIG_KEYS, key)) throw new Error(`${source}: unknown setting ${key}`);
  }

  let protectedPaths: PartialGuardConfig["protectedPaths"];
  if (raw.protectedPaths !== undefined) {
    if (typeof raw.protectedPaths !== "object" || raw.protectedPaths === null || Array.isArray(raw.protectedPaths)) {
      throw new Error(`${source}: protectedPaths must be an object`);
    }
    const rawProtectedPaths = raw.protectedPaths as Record<string, unknown>;
    for (const key of Object.keys(rawProtectedPaths)) {
      if (!Object.hasOwn(PROTECTED_PATH_KEYS, key)) {
        throw new Error(`${source}: unknown protectedPaths setting ${key}`);
      }
    }
    const paths = pathList(rawProtectedPaths.paths, "protectedPaths.paths", source);
    const pathPolicy = protectedAccessPolicy(rawProtectedPaths.policy, "protectedPaths.policy", source);
    protectedPaths = {
      ...(paths ? { paths } : {}),
      ...(pathPolicy ? { policy: pathPolicy } : {}),
    };
  }

  let protectedFiles: PartialGuardConfig["protectedFiles"];
  if (raw.protectedFiles !== undefined) {
    if (typeof raw.protectedFiles !== "object" || raw.protectedFiles === null || Array.isArray(raw.protectedFiles)) {
      throw new Error(`${source}: protectedFiles must be an object`);
    }
    const rawProtectedFiles = raw.protectedFiles as Record<string, unknown>;
    for (const key of Object.keys(rawProtectedFiles)) {
      if (!Object.hasOwn(PROTECTED_FILE_KEYS, key)) {
        throw new Error(`${source}: unknown protectedFiles setting ${key}`);
      }
    }
    const names = fileNameList(rawProtectedFiles.names, "protectedFiles.names", source);
    const filePolicy = protectedAccessPolicy(rawProtectedFiles.policy, "protectedFiles.policy", source);
    protectedFiles = {
      ...(names ? { names } : {}),
      ...(filePolicy ? { policy: filePolicy } : {}),
    };
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
      ...(typeof root === "string" ? { root: configuredPath(root, "temporary.root", source) } : {}),
      ...(typeof allowOwned === "boolean" ? { allowOwned } : {}),
    };
  }

  const externalWrites = policy(raw.externalWrites, "externalWrites", source);
  const allowPaths = pathList(raw.allowPaths, "allowPaths", source);
  const gitPush = policy(raw.gitPush, "gitPush", source);
  return {
    ...(externalWrites ? { externalWrites } : {}),
    ...(allowPaths ? { allowPaths } : {}),
    ...(protectedPaths ? { protectedPaths } : {}),
    ...(protectedFiles ? { protectedFiles } : {}),
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
    protectedPaths: {
      paths: override.protectedPaths?.paths ?? base.protectedPaths.paths,
      policy: override.protectedPaths?.policy ?? base.protectedPaths.policy,
    },
    protectedFiles: {
      names: override.protectedFiles?.names ?? base.protectedFiles.names,
      policy: override.protectedFiles?.policy ?? base.protectedFiles.policy,
    },
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
    protectedPaths: { paths: [], policy: "deny" },
    protectedFiles: { names: [], policy: "prompt" },
    temporary: { root: "/tmp", allowOwned: true },
    gitPush: "deny",
  }, bundled ?? {});

  for (const path of [join(agentDir, CONFIG_FILE_NAME), join(workspace, ".omp", CONFIG_FILE_NAME)]) {
    const override = await readConfig(path, false);
    if (override) config = mergeConfig(config, override);
  }
  return config;
}
