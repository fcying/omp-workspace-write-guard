import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import workspaceWriteGuard from "../index.ts";

function registerHandler() {
  let handler;
  const labels = [];

  workspaceWriteGuard({
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

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "omp-write-guard-"));
  const workspace = join(root, "workspace");
  const outside = join(root, "outside");
  await mkdir(workspace);
  await mkdir(outside);
  await symlink(outside, join(workspace, "external-link"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { workspace, outside };
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
  ];

  for (const command of commands) {
    const result = await handler({ toolName: "bash", input: { command } }, context(workspace));
    assert.equal(result, undefined, command);
  }
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
    assert.equal(result.reason, "git push is blocked by workspace write guard", command);
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
