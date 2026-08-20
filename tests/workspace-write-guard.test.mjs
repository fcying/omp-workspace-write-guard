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

test("prompts for outside writes and honors the decision", async (t) => {
  const { workspace, outside } = await fixture(t);
  const handler = registerHandler();
  const target = join(outside, "file.ts");
  const approvedPrompts = [];
  const deniedPrompts = [];

  const approved = await handler(
    { toolName: "write", input: { path: target, content: "ok" } },
    context(workspace, { hasUI: true, approve: true, prompts: approvedPrompts }),
  );
  const denied = await handler(
    { toolName: "write", input: { path: target, content: "blocked" } },
    context(workspace, { hasUI: true, approve: false, prompts: deniedPrompts }),
  );

  assert.equal(approved, undefined);
  assert.equal(approvedPrompts.length, 1);
  assert.equal(denied.block, true);
  assert.match(denied.reason, /User denied write outside workspace/);
  assert.equal(deniedPrompts.length, 1);
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

test("allows LSP reads and guards LSP mutations", async (t) => {
  const { workspace } = await fixture(t);
  const handler = registerHandler();

  const read = await handler(
    { toolName: "lsp", input: { action: "references", file: "src/file.ts" } },
    context(workspace),
  );
  const mutation = await handler(
    { toolName: "lsp", input: { action: "rename", file: "src/file.ts", new_name: "renamed" } },
    context(workspace),
  );

  assert.equal(read, undefined);
  assert.equal(mutation.block, true);
  assert.match(mutation.reason, /LSP rename/);
});
