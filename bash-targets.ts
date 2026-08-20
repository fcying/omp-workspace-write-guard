import { basename, isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";

export type BashTarget =
  | { kind: "path"; value: string; base: string }
  | { kind: "opaque"; value: string }
  | { kind: "deny"; reason: string };

type Token =
  | { kind: "word"; value: string }
  | { kind: "operator"; value: string };

const CONTROL_OPERATORS: Record<string, true> = {
  "&&": true,
  "||": true,
  ";": true,
  "|": true,
  "|&": true,
  "&": true,
  "\n": true,
};
const REDIRECT_OPERATORS: Record<string, true> = {
  ">": true,
  ">>": true,
  ">|": true,
  "<>": true,
  "&>": true,
  "&>>": true,
  ">&": true,
  "<&": true,
  "<": true,
  "<<": true,
  "<<<": true,
};
const WRITE_REDIRECTS: Record<string, true> = {
  ">": true,
  ">>": true,
  ">|": true,
  "<>": true,
  "&>": true,
  "&>>": true,
  ">&": true,
};
const OPERATORS = [
  "&>>",
  "<<<",
  ">>",
  ">|",
  "<>",
  ">&",
  "<&",
  "&&",
  "||",
  "|&",
  "<<",
  "&>",
  ">",
  "<",
  ";",
  "|",
  "&",
];
const DIRECT_MUTATORS: Record<string, true> = {
  rm: true,
  rmdir: true,
  mkdir: true,
  touch: true,
  truncate: true,
};
const METADATA_MUTATORS: Record<string, true> = { chmod: true, chown: true, chgrp: true };
const DESTINATION_MUTATORS: Record<string, true> = { cp: true, install: true, ln: true };
const COMMAND_WRAPPERS: Record<string, true> = {
  command: true,
  builtin: true,
  nohup: true,
  sudo: true,
  time: true,
};
const GIT_MUTATORS: Record<string, true> = {
  add: true,
  am: true,
  apply: true,
  checkout: true,
  "cherry-pick": true,
  clean: true,
  clone: true,
  commit: true,
  config: true,
  init: true,
  merge: true,
  mv: true,
  rebase: true,
  reset: true,
  restore: true,
  revert: true,
  rm: true,
  stash: true,
  switch: true,
  worktree: true,
};
const GIT_OPTIONS_WITH_VALUE: Record<string, true> = {
  "-c": true,
  "--config-env": true,
  "--exec-path": true,
  "--git-dir": true,
  "--namespace": true,
  "--super-prefix": true,
  "--work-tree": true,
};

function tokenize(command: string): Token[] {
  const tokens: Token[] = [];
  let word = "";
  let quote: "'" | '"' | undefined;

  const flush = (): void => {
    if (word !== "") tokens.push({ kind: "word", value: word });
    word = "";
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];

    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else if (char === "\\" && quote === '"' && index + 1 < command.length) {
        index += 1;
        word += command[index];
      } else {
        word += char;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "\\" && index + 1 < command.length) {
      index += 1;
      word += command[index];
      continue;
    }
    if (char === "#" && word === "") {
      while (index < command.length && command[index] !== "\n") index += 1;
      index -= 1;
      continue;
    }
    if (char === "\n") {
      flush();
      tokens.push({ kind: "operator", value: "\n" });
      continue;
    }
    if (/\s/.test(char)) {
      flush();
      continue;
    }

    const operator = OPERATORS.find((candidate) => command.startsWith(candidate, index));
    if (operator) {
      flush();
      tokens.push({ kind: "operator", value: operator });
      index += operator.length - 1;
      continue;
    }

    word += char;
  }

  flush();
  return tokens;
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return path;
}

function hasDynamicExpansion(value: string): boolean {
  return /[$`]/.test(value);
}

function pathTarget(value: string, base: string | undefined, label: string): BashTarget {
  if (!base || hasDynamicExpansion(value)) {
    return { kind: "opaque", value: `${label}: ${value}` };
  }
  return { kind: "path", value, base };
}

function operands(words: string[]): string[] {
  const result: string[] = [];
  let options = true;

  for (const word of words) {
    if (options && word === "--") {
      options = false;
      continue;
    }
    if (options && word.startsWith("-")) continue;
    result.push(word);
  }
  return result;
}

function destinationOperand(words: string[]): string | undefined {
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if (word === "-t" || word === "--target-directory") return words[index + 1];
    if (word.startsWith("--target-directory=")) return word.slice("--target-directory=".length);
  }
  return operands(words).at(-1);
}

function unwrapCommand(words: string[]): string[] {
  let index = 0;
  while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index])) index += 1;

  while (index < words.length) {
    const command = basename(words[index]);
    if (!Object.hasOwn(COMMAND_WRAPPERS, command)) break;
    index += 1;
    while (index < words.length && words[index].startsWith("-")) index += 1;
  }

  if (basename(words[index] ?? "") === "env") {
    index += 1;
    while (
      index < words.length &&
      (words[index].startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]))
    ) {
      index += 1;
    }
  }

  return words.slice(index);
}

function gitTargets(args: string[], base: string | undefined): BashTarget[] {
  let gitBase = base;
  let index = 0;

  while (index < args.length) {
    const word = args[index];
    if (word === "-C") {
      const directory = args[index + 1];
      if (!directory || !gitBase || hasDynamicExpansion(directory)) {
        gitBase = undefined;
      } else {
        const expanded = expandHome(directory);
        gitBase = isAbsolute(expanded) ? resolve(expanded) : resolve(gitBase, expanded);
      }
      index += 2;
      continue;
    }
    if (word.startsWith("-C") && word.length > 2) {
      const directory = word.slice(2);
      if (!gitBase || hasDynamicExpansion(directory)) {
        gitBase = undefined;
      } else {
        const expanded = expandHome(directory);
        gitBase = isAbsolute(expanded) ? resolve(expanded) : resolve(gitBase, expanded);
      }
      index += 1;
      continue;
    }
    if (Object.hasOwn(GIT_OPTIONS_WITH_VALUE, word)) {
      index += 2;
      continue;
    }
    if (word.startsWith("-")) {
      index += 1;
      continue;
    }
    break;
  }


  const subcommand = args[index];
  if (subcommand === "push") {
    return [{ kind: "deny", reason: "git push is blocked by workspace write guard" }];
  }
  if (!subcommand || !Object.hasOwn(GIT_MUTATORS, subcommand)) return [];
  const subcommandArgs = args.slice(index + 1);

  if (subcommand === "clone") {
    const values = operands(subcommandArgs);
    const destination = values.length >= 2 ? values.at(-1) : ".";
    return destination ? [pathTarget(destination, gitBase, "git clone destination")] : [];
  }
  if (subcommand === "init") {
    const destination = operands(subcommandArgs)[0] ?? ".";
    return [pathTarget(destination, gitBase, "git init destination")];
  }
  if (subcommand === "worktree") {
    const [action, ...values] = operands(subcommandArgs);
    const targetCount = action === "move" ? 2 : action === "add" || action === "remove" ? 1 : 0;
    if (targetCount > 0) {
      return values
        .slice(0, targetCount)
        .map((value) => pathTarget(value, gitBase, `git worktree ${action}`));
    }
  }
  if (subcommand === "config") {
    const values = operands(subcommandArgs);
    const mutatingFlag = subcommandArgs.some((value) =>
      /^(?:--add|--replace-all|--unset|--unset-all|--rename-section|--remove-section)$/.test(value),
    );
    if (!mutatingFlag && values.length < 2) return [];

    const fileIndex = subcommandArgs.findIndex((value) => value === "--file" || value === "-f");
    const fileArgument = fileIndex >= 0 ? subcommandArgs[fileIndex + 1] : undefined;
    const inlineFile = subcommandArgs.find((value) => value.startsWith("--file="))?.slice("--file=".length);
    if (fileArgument || inlineFile) {
      return [pathTarget(fileArgument ?? inlineFile ?? "", gitBase, "git config file")];
    }
    if (subcommandArgs.includes("--global")) {
      return [pathTarget(resolve(homedir(), ".gitconfig"), gitBase, "git config global")];
    }
    if (subcommandArgs.includes("--system")) {
      return [pathTarget("/etc/gitconfig", gitBase, "git config system")];
    }
  }

  return [pathTarget(".", gitBase, `git ${subcommand} working directory`)];
}

function commandTargets(words: string[], base: string | undefined): BashTarget[] {
  const commandWords = unwrapCommand(words);
  if (commandWords.length === 0) return [];

  const command = basename(commandWords[0]);
  const args = commandWords.slice(1);
  const argsWithoutOptions = operands(args);

  if (Object.hasOwn(DIRECT_MUTATORS, command)) {
    return argsWithoutOptions.map((value) => pathTarget(value, base, command));
  }
  if (Object.hasOwn(METADATA_MUTATORS, command)) {
    return argsWithoutOptions.slice(1).map((value) => pathTarget(value, base, command));
  }
  if (command === "mv") {
    return argsWithoutOptions.map((value) => pathTarget(value, base, command));
  }
  if (Object.hasOwn(DESTINATION_MUTATORS, command)) {
    const destination = destinationOperand(args);
    return destination ? [pathTarget(destination, base, `${command} destination`)] : [];
  }
  if (command === "tee") {
    return argsWithoutOptions.map((value) => pathTarget(value, base, command));
  }
  if (command === "dd") {
    return args
      .filter((value) => value.startsWith("of="))
      .map((value) => pathTarget(value.slice(3), base, "dd output"));
  }
  if ((command === "sed" || command === "perl") && args.some((value) => /^-.*i/.test(value))) {
    const files = argsWithoutOptions.slice(1);
    return files.map((value) => pathTarget(value, base, `${command} in-place`));
  }
  if (command === "git") return gitTargets(args, base);

  return [];
}

function processSegment(tokens: Token[], base: string | undefined): { targets: BashTarget[]; nextBase?: string } {
  const words: string[] = [];
  const targets: BashTarget[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.kind === "operator") {
      if (Object.hasOwn(REDIRECT_OPERATORS, token.value)) {
        const target = tokens[index + 1];
        if (target?.kind !== "word") {
          targets.push({ kind: "opaque", value: `shell redirection after ${token.value}` });
          continue;
        }
        const duplicatesDescriptor = token.value === ">&" && /^(?:[0-9]+|-)$/.test(target.value);
        if (Object.hasOwn(WRITE_REDIRECTS, token.value) && !duplicatesDescriptor) {
          targets.push(pathTarget(target.value, base, "shell redirection"));
        }
        index += 1;
      }
      continue;
    }
    words.push(token.value);
  }


  const commandWords = unwrapCommand(words);
  if (basename(commandWords[0] ?? "") === "cd") {
    const destination = operands(commandWords.slice(1))[0] ?? homedir();
    if (!base || hasDynamicExpansion(destination)) return { targets, nextBase: undefined };
    const expanded = expandHome(destination);
    return {
      targets,
      nextBase: isAbsolute(expanded) ? resolve(expanded) : resolve(base, expanded),
    };
  }

  targets.push(...commandTargets(words, base));
  return { targets, nextBase: base };
}

export function bashWriteTargets(command: string, sessionCwd: string, requestedCwd?: string): BashTarget[] {
  const expandedCwd = requestedCwd ? expandHome(requestedCwd) : sessionCwd;
  let base = requestedCwd
    ? isAbsolute(expandedCwd)
      ? resolve(expandedCwd)
      : resolve(sessionCwd, expandedCwd)
    : sessionCwd;
  const targets: BashTarget[] = [];
  let segment: Token[] = [];

  const flush = (): void => {
    if (segment.length === 0) return;
    const result = processSegment(segment, base);
    targets.push(...result.targets);
    base = result.nextBase;
    segment = [];
  };

  for (const token of tokenize(command)) {
    if (token.kind === "operator" && Object.hasOwn(CONTROL_OPERATORS, token.value)) {
      flush();
    } else {
      segment.push(token);
    }
  }
  flush();

  return targets;
}
