import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import workspaceWriteGuard from "../index.ts";


function registerHandler(agentDir = join(tmpdir(), `omp-write-guard-test-agent-${process.pid}`)) {
  let handler;
  const labels = [];

  workspaceWriteGuard({
    pi: { getAgentDir: () => agentDir },
    setLabel(label) {
      labels.push(label);
    },
    on(event, callback) {
      if (event === "tool_call") handler = callback;
    },
  });

  assert.equal(typeof handler, "function");
  assert.deepEqual(labels, ["Workspace write guard"]);
  return handler;
}
function registerLifecycleHandlers(agentDir = join(tmpdir(), `omp-write-guard-test-agent-${process.pid}`)) {
  let call;
  let result;

  workspaceWriteGuard({
    pi: { getAgentDir: () => agentDir },
    setLabel() {},
    on(event, callback) {
      if (event === "tool_call") call = callback;
      if (event === "tool_result") result = callback;
    },
  });

  assert.equal(typeof call, "function");
  assert.equal(typeof result, "function");
  return { call, result };
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "omp-write-guard-"));
  const workspace = join(root, "workspace");
  const outside = join(root, "outside");
  const agentDir = join(root, "agent");
  await mkdir(workspace);
  await mkdir(outside);
  await mkdir(agentDir);
  await symlink(outside, join(workspace, "external-link"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, workspace, outside, agentDir };
}

async function writeConfig(directory, values) {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "workspace-write-guard.json"), `${JSON.stringify(values, null, 2)}\n`);
}

function context(cwd, { hasUI = false, approve = false, prompts = [] } = {}) {
  return {
    cwd,
    hasUI,
    ui: {
      async confirm(title, body) {
        prompts.push({ title, body });
        return approve;
      },
    },
  };
}

test("allows direct writes inside the workspace", async (t) => {
  const { workspace } = await fixture(t);
  const handler = registerHandler();

  const result = await handler(
    { toolName: "write", input: { path: "src/file.ts", content: "ok" } },
    context(workspace),
  );

  assert.equal(result, undefined);
});

test("blocks direct writes outside the workspace without a UI", async (t) => {
  const { workspace, outside } = await fixture(t);
  const handler = registerHandler();
  const target = join(outside, "file.ts");

  const result = await handler(
    { toolName: "write", input: { path: target, content: "blocked" } },
    context(workspace),
  );

  assert.equal(result.block, true);
  assert.match(result.reason, /Write outside workspace blocked/);
  assert.match(result.reason, /outside\/file\.ts/);
});

test("remembers an approved external directory for the current process", async (t) => {
  const { workspace, outside } = await fixture(t);
  const other = join(outside, "..", "other");
  await mkdir(other);
  const handler = registerHandler();
  const prompts = [];

  const approved = await handler(
    { toolName: "write", input: { path: join(outside, "first.ts"), content: "ok" } },
    context(workspace, { hasUI: true, approve: true, prompts }),
  );
  const cached = await handler(
    { toolName: "write", input: { path: join(outside, "nested", "second.ts"), content: "ok" } },
    context(workspace),
  );
  const uncached = await handler(
    { toolName: "write", input: { path: join(other, "blocked.ts"), content: "blocked" } },
    context(workspace),
  );

  assert.equal(approved, undefined);
  assert.equal(cached, undefined);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0].body, /Remember for this OMP process/);
  assert.equal(uncached.block, true);
});

test("honors denial for an uncached external directory", async (t) => {
  const { workspace, outside } = await fixture(t);
  const handler = registerHandler();
  const prompts = [];

  const denied = await handler(
    { toolName: "write", input: { path: join(outside, "blocked.ts"), content: "blocked" } },
    context(workspace, { hasUI: true, approve: false, prompts }),
  );

  assert.equal(denied.block, true);
  assert.match(denied.reason, /User denied write outside workspace/);
  assert.equal(prompts.length, 1);
});

test("blocks workspace symlinks that resolve outside", async (t) => {
  const { workspace } = await fixture(t);
  const handler = registerHandler();

  const result = await handler(
    { toolName: "write", input: { path: "external-link/new.ts", content: "blocked" } },
    context(workspace),
  );

  assert.equal(result.block, true);
  assert.match(result.reason, /outside\/new\.ts/);
});

test("extracts edit and move destinations", async (t) => {
  const { workspace, outside } = await fixture(t);
  const handler = registerHandler();
  const source = join(outside, "source.ts");
  const destination = join(outside, "moved.ts");

  const result = await handler(
    {
      toolName: "edit",
      input: {
        input: `[${source}#ABCD]\nPUT 1.=1:\n+changed\nMV "${destination}"`,
      },
    },
    context(workspace),
  );

  assert.equal(result.block, true);
  assert.match(result.reason, /outside\/source\.ts/);
  assert.match(result.reason, /outside\/moved\.ts/);
});

test("guards AST edit scopes but allows internal devices", async (t) => {
  const { workspace, outside } = await fixture(t);
  const handler = registerHandler();

  const inside = await handler(
    { toolName: "ast_edit", input: { paths: ["src/**/*.ts"], ops: [] } },
    context(workspace),
  );
  const external = await handler(
    { toolName: "ast_edit", input: { paths: [join(outside, "**/*.ts")], ops: [] } },
    context(workspace),
  );
  const internal = await handler(
    { toolName: "write", input: { path: "xd://resolve", content: "apply proposal" } },
    context(workspace),
  );

  assert.equal(inside, undefined);
  assert.equal(external.block, true);
  assert.equal(internal, undefined);
});

test("allows workspace LSP changes and guards external destinations", async (t) => {
  const { workspace, outside } = await fixture(t);
  const handler = registerHandler();

  const read = await handler(
    { toolName: "lsp", input: { action: "references", file: "src/file.ts" } },
    context(workspace),
  );
  const workspaceMutation = await handler(
    { toolName: "lsp", input: { action: "rename", file: "src/file.ts", new_name: "renamed" } },
    context(workspace),
  );
  const externalMutation = await handler(
    {
      toolName: "lsp",
      input: {
        action: "rename_file",
        file: "src/file.ts",
        new_name: join(outside, "file.ts"),
      },
    },
    context(workspace),
  );

  assert.equal(read, undefined);
  assert.equal(workspaceMutation, undefined);
  assert.equal(externalMutation.block, true);
  assert.match(externalMutation.reason, /outside\/file\.ts/);
});

test("allows common Bash reads, project runners, and workspace writes", async (t) => {
  const { workspace } = await fixture(t);
  const handler = registerHandler();
  const commands = [
    "git rev-parse HEAD",
    "just test",
    "git add .",
    "touch generated.txt",
    "printf ok > generated.txt",
    "run-tests 2>&1",
    "git init -b main nested-repo",
    "git init --initial-branch=main nested-repo-long",
  ];

  for (const command of commands) {
    const result = await handler({ toolName: "bash", input: { command } }, context(workspace));
    assert.equal(result, undefined, command);
  }
});

test("applies allowPaths, denyPaths, and externalWrites precedence", async (t) => {
  const { root, workspace, outside, agentDir } = await fixture(t);
  const other = join(root, "other");
  const protectedExternal = join(outside, "protected");
  const protectedWorkspace = join(workspace, "protected");
  await mkdir(other);
  await writeConfig(join(workspace, ".omp"), {
    externalWrites: "deny",
    allowPaths: [outside],
    denyPaths: [protectedExternal, protectedWorkspace],
  });
  const handler = registerHandler(agentDir);

  const allowed = await handler(
    { toolName: "write", input: { path: join(outside, "allowed.txt"), content: "ok" } },
    context(workspace),
  );
  const deniedExternal = await handler(
    { toolName: "write", input: { path: join(protectedExternal, "blocked.txt"), content: "no" } },
    context(workspace, { hasUI: true, approve: true }),
  );
  const deniedWorkspace = await handler(
    { toolName: "write", input: { path: join(protectedWorkspace, "blocked.txt"), content: "no" } },
    context(workspace, { hasUI: true, approve: true }),
  );
  const deniedUnlisted = await handler(
    { toolName: "write", input: { path: join(other, "blocked.txt"), content: "no" } },
    context(workspace, { hasUI: true, approve: true }),
  );

  assert.equal(allowed, undefined);
  assert.match(deniedExternal.reason, /denied by workspace write guard configuration/);
  assert.match(deniedWorkspace.reason, /denied by workspace write guard configuration/);
  assert.match(deniedUnlisted.reason, /denied by configuration/);
});

test("merges user and project configuration with project settings last", async (t) => {
  const { workspace, outside, agentDir } = await fixture(t);
  await writeConfig(agentDir, {
    externalWrites: "deny",
    temporary: { allowOwned: false },
  });
  await writeConfig(join(workspace, ".omp"), {
    externalWrites: "allow",
    temporary: { allowOwned: true },
  });
  const handler = registerHandler(agentDir);

  const result = await handler(
    { toolName: "write", input: { path: join(outside, "allowed.txt"), content: "ok" } },
    context(workspace),
  );

  assert.equal(result, undefined);
});

test("fails closed on invalid configuration without blocking read-only tools", async (t) => {
  const { workspace, agentDir } = await fixture(t);
  await writeConfig(join(workspace, ".omp"), { externalWrites: "sometimes" });
  const handler = registerHandler(agentDir);

  const read = await handler(
    { toolName: "lsp", input: { action: "references", file: "src/file.ts" } },
    context(workspace),
  );
  const write = await handler(
    { toolName: "write", input: { path: "src/file.ts", content: "no" } },
    context(workspace),
  );

  assert.equal(read, undefined);
  assert.equal(write.block, true);
  assert.match(write.reason, /configuration error/);
  assert.match(write.reason, /externalWrites must be allow, deny, or prompt/);
});

test("prompts for git push when configured", async (t) => {
  const { workspace, agentDir } = await fixture(t);
  await writeConfig(join(workspace, ".omp"), { gitPush: "prompt" });
  const handler = registerHandler(agentDir);
  const prompts = [];

  const headless = await handler(
    { toolName: "bash", input: { command: "git push" } },
    context(workspace),
  );
  const approved = await handler(
    { toolName: "bash", input: { command: "git push" } },
    context(workspace, { hasUI: true, approve: true, prompts }),
  );

  assert.equal(headless.block, true);
  assert.match(headless.reason, /blocked without interactive approval: git push/);
  assert.equal(approved, undefined);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0].body, /git push/);
});

test("allows configured git push but still guards its external repository", async (t) => {
  const { workspace, outside, agentDir } = await fixture(t);
  await writeConfig(join(workspace, ".omp"), { gitPush: "allow" });
  const handler = registerHandler(agentDir);

  const local = await handler(
    { toolName: "bash", input: { command: "git push" } },
    context(workspace),
  );
  const external = await handler(
    { toolName: "bash", input: { command: `git -C ${outside} push` } },
    context(workspace),
  );

  assert.equal(local, undefined);
  assert.equal(external.block, true);
  assert.match(external.reason, /outside/);
});

test("disables automatic temporary ownership when configured", async (t) => {
  const { workspace, agentDir } = await fixture(t);
  const temporary = await mkdtemp(join(tmpdir(), "omp-configured-temp-"));
  await rm(temporary, { recursive: true });
  t.after(() => rm(temporary, { recursive: true, force: true }));
  await writeConfig(join(workspace, ".omp"), { temporary: { allowOwned: false } });
  const handler = registerHandler(agentDir);

  const result = await handler(
    { toolName: "write", input: { path: join(temporary, "file.txt"), content: "no" } },
    context(workspace),
  );

  assert.equal(result.block, true);
  assert.match(result.reason, /Write outside workspace blocked/);
});

test("hard-blocks git push without prompting", async (t) => {
  const { workspace } = await fixture(t);
  const handler = registerHandler();
  const prompts = [];
  const commands = [
    "git push",
    "git push origin main",
    "git -C . push --force",
    "git -c advice.detachedHead=false push",
    "git --git-dir .git push",
    "sudo git push",
    "git status && git push",
  ];

  for (const command of commands) {
    const result = await handler(
      { toolName: "bash", input: { command } },
      context(workspace, { hasUI: true, approve: true, prompts }),
    );
    assert.equal(result.block, true, command);
    assert.equal(result.reason, "git push is blocked by workspace write guard configuration", command);
  }
  assert.equal(prompts.length, 0);
});

test("blocks explicit Bash writes outside the workspace", async (t) => {
  const { workspace, outside } = await fixture(t);
  const handler = registerHandler();
  const commands = [
    `touch ${join(outside, "touch.txt")}`,
    `printf ok > ${join(outside, "redirect.txt")}`,
    `cd ${outside} && mkdir nested`,
    "git -C ../outside add .",
    `git init -b main ${join(outside, "init-short")}`,
    `git init --initial-branch=main ${join(outside, "init-long")}`,
    `git init --separate-git-dir ${join(outside, "git-data")} local-worktree`,
    `git clone --depth 1 https://example.invalid/repo ${join(outside, "clone")}`,
    `git --git-dir ${join(outside, "repo.git")} add .`,
    `git --git-dir=${join(outside, "repo-inline.git")} add .`,
    `cp source.txt ${join(outside, "copy.txt")}`,
  ];

  for (const command of commands) {
    const result = await handler({ toolName: "bash", input: { command } }, context(workspace));
    assert.equal(result.block, true, command);
    assert.match(result.reason, /Write outside workspace blocked/, command);
  }
});

test("reuses an approved directory for Bash targets", async (t) => {
  const { workspace, outside } = await fixture(t);
  const handler = registerHandler();
  const prompts = [];

  const approved = await handler(
    { toolName: "bash", input: { command: `touch ${join(outside, "first.txt")}` } },
    context(workspace, { hasUI: true, approve: true, prompts }),
  );
  const cached = await handler(
    { toolName: "bash", input: { command: `printf ok > ${join(outside, "nested", "second.txt")}` } },
    context(workspace),
  );

  assert.equal(approved, undefined);
  assert.equal(cached, undefined);
  assert.equal(prompts.length, 1);
});

test("owns a newly created temporary namespace for its lifecycle", async (t) => {
  const { workspace } = await fixture(t);
  const { call, result } = registerLifecycleHandlers();
  const temporary = await mkdtemp(join(tmpdir(), "omp-owned-probe-"));
  await rm(temporary, { recursive: true });
  t.after(() => rm(temporary, { recursive: true, force: true }));

  const creation = await call(
    { toolCallId: "create-temp", toolName: "bash", input: { command: `mkdir ${temporary}` } },
    context(workspace),
  );
  await mkdir(temporary);
  await result({ toolCallId: "create-temp", toolName: "bash", isError: false, content: [] });

  const update = await call(
    { toolCallId: "update-temp", toolName: "write", input: { path: join(temporary, "file.txt"), content: "ok" } },
    context(workspace),
  );
  const deletion = await call(
    { toolCallId: "delete-temp", toolName: "bash", input: { command: `rm -rf ${temporary}` } },
    context(workspace),
  );

  assert.equal(creation, undefined);
  assert.equal(update, undefined);
  assert.equal(deletion, undefined);
});

test("owns a temporary namespace reported by eval", async (t) => {
  const { workspace, agentDir } = await fixture(t);
  const created = await mkdtemp(join(tmpdir(), "set-omp-test-"));
  await rm(created, { recursive: true });
  t.after(() => rm(created, { recursive: true, force: true }));
  const { call, result } = registerLifecycleHandlers(agentDir);

  const execution = await call(
    { toolCallId: "eval-create-temp", toolName: "eval", input: { language: "python", code: "tempfile.mkdtemp()" } },
    context(workspace),
  );
  await mkdir(created);
  await result({
    toolCallId: "eval-create-temp",
    toolName: "eval",
    input: {},
    isError: false,
    content: [{ type: "text", text: created }],
  });

  const update = await call(
    { toolCallId: "update-eval-temp", toolName: "write", input: { path: join(created, "file.txt"), content: "ok" } },
    context(workspace),
  );
  const deletion = await call(
    { toolCallId: "delete-eval-temp", toolName: "bash", input: { command: `rm -rf ${created}` } },
    context(workspace),
  );

  assert.equal(execution, undefined);
  assert.equal(update, undefined);
  assert.equal(deletion, undefined);
});

test("does not claim pre-existing, failed, or unreported eval temporary namespaces", async (t) => {
  const { root, workspace, agentDir } = await fixture(t);
  const temporaryRoot = join(root, "temporary");
  const existing = join(temporaryRoot, "existing");
  const failed = join(temporaryRoot, "failed");
  const unreported = join(temporaryRoot, "unreported");
  await mkdir(existing, { recursive: true });
  await writeConfig(join(workspace, ".omp"), { temporary: { root: temporaryRoot } });
  const { call, result } = registerLifecycleHandlers(agentDir);

  await call(
    { toolCallId: "eval-failed-temp", toolName: "eval", input: { language: "python", code: "raise RuntimeError()" } },
    context(workspace),
  );
  await mkdir(failed);
  await result({
    toolCallId: "eval-failed-temp",
    toolName: "eval",
    input: {},
    isError: true,
    content: [],
  });

  await call(
    { toolCallId: "eval-unreported-temp", toolName: "eval", input: { language: "python", code: "print('done')" } },
    context(workspace),
  );
  await mkdir(unreported);
  await result({
    toolCallId: "eval-unreported-temp",
    toolName: "eval",
    input: {},
    isError: false,
    content: [{ type: "text", text: "done" }],
  });

  const existingDeletion = await call(
    { toolCallId: "delete-existing-temp", toolName: "bash", input: { command: `rm -rf ${existing}` } },
    context(workspace),
  );
  const failedDeletion = await call(
    { toolCallId: "delete-failed-eval-temp", toolName: "bash", input: { command: `rm -rf ${failed}` } },
    context(workspace),
  );
  const unreportedDeletion = await call(
    { toolCallId: "delete-unreported-eval-temp", toolName: "bash", input: { command: `rm -rf ${unreported}` } },
    context(workspace),
  );

  assert.equal(existingDeletion.block, true);
  assert.equal(failedDeletion.block, true);
  assert.equal(unreportedDeletion.block, true);
});

test("does not claim existing or unsuccessfully created temporary namespaces", async (t) => {
  const { workspace, outside } = await fixture(t);
  const { call, result } = registerLifecycleHandlers();
  const failed = await mkdtemp(join(tmpdir(), "omp-failed-probe-"));
  await rm(failed, { recursive: true });

  const existingWrite = await call(
    { toolCallId: "existing-temp", toolName: "bash", input: { command: `touch ${join(outside, "file.txt")}` } },
    context(workspace),
  );
  const failedCreation = await call(
    { toolCallId: "failed-temp", toolName: "write", input: { path: join(failed, "file.txt"), content: "no" } },
    context(workspace),
  );
  await result({ toolCallId: "failed-temp", toolName: "write", isError: true, content: [] });
  const deleteFailed = await call(
    { toolCallId: "delete-failed", toolName: "bash", input: { command: `rm -rf ${failed}` } },
    context(workspace),
  );

  assert.equal(existingWrite.block, true);
  assert.equal(failedCreation, undefined);
  assert.equal(deleteFailed.block, true);
});
