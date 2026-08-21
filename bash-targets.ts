import { basename, isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";

export type BashTarget =
  | { kind: "path"; value: string; base: string; creates?: true; temporaryTemplate?: true }
  | { kind: "opaque"; value: string }
  | { kind: "git-push" };

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
const GIT_INIT_OPTIONS_WITH_VALUE: Record<string, true> = {
  "-b": true,
  "--initial-branch": true,
  "--object-format": true,
  "--ref-format": true,
  "--separate-git-dir": true,
  "--template": true,
};
const GIT_CLONE_OPTIONS_WITH_VALUE: Record<string, true> = {
  "-b": true,
  "--branch": true,
  "-c": true,
  "--config": true,
  "--depth": true,
  "--filter": true,
  "-j": true,
  "--jobs": true,
  "-o": true,
  "--origin": true,
  "--reference": true,
  "--reference-if-able": true,
  "--revision": true,
  "--separate-git-dir": true,
  "--server-option": true,
  "--shallow-exclude": true,
  "--shallow-since": true,
  "--template": true,
  "-u": true,
  "--upload-pack": true,
};
const GIT_WORKTREE_ADD_OPTIONS_WITH_VALUE: Record<string, true> = {
  "-b": true,
  "-B": true,
  "--reason": true,
};
const GIT_CONFIG_OPTIONS_WITH_VALUE: Record<string, true> = {
  "-f": true,
  "--file": true,
  "--blob": true,
  "--comment": true,
  "--default": true,
  "--type": true,
};

const MKTEMP_OPTIONS_WITH_VALUE: Record<string, true> = {
  "--suffix": true,
  "-p": true,
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

function pathTarget(
  value: string,
  base: string | undefined,
  label: string,
  creates = false,
): BashTarget {
  if (!base || hasDynamicExpansion(value)) {
    return { kind: "opaque", value: `${label}: ${value}` };
  }
  return creates ? { kind: "path", value, base, creates: true } : { kind: "path", value, base };
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
function positionalArguments(words: string[], optionsWithValue: Record<string, true>): string[] {
  const result: string[] = [];
  let options = true;

  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if (options && word === "--") {
      options = false;
      continue;
    }
    if (!options || !word.startsWith("-") || word === "-") {
      result.push(word);
      continue;
    }

    const option = word.includes("=") ? word.slice(0, word.indexOf("=")) : word;
    if (Object.hasOwn(optionsWithValue, option) && option === word) {
      index += 1;
      continue;
    }
    if (word.length > 2 && Object.hasOwn(optionsWithValue, word.slice(0, 2))) continue;
  }

  return result;
}

function optionArgument(
  words: string[],
  shortName: string | undefined,
  longName: string,
): string | undefined {
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if (word === longName || (shortName && word === shortName)) return words[index + 1];
    if (word.startsWith(`${longName}=`)) return word.slice(longName.length + 1);
    if (shortName && word.startsWith(shortName) && word.length > shortName.length) {
      return word.slice(shortName.length);
    }
  }
  return undefined;
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
  const scopeTargets: BashTarget[] = [];
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

    const optionName = word.includes("=") ? word.slice(0, word.indexOf("=")) : word;
    if (Object.hasOwn(GIT_OPTIONS_WITH_VALUE, optionName)) {
      const optionValue = optionName === word
        ? args[index + 1]
        : word.slice(optionName.length + 1);
      if ((optionName === "--git-dir" || optionName === "--work-tree") && optionValue) {
        scopeTargets.push(pathTarget(optionValue, gitBase, `git ${optionName}`));
      }
      index += optionName === word ? 2 : 1;
      continue;
    }
    if (word.length > 2 && Object.hasOwn(GIT_OPTIONS_WITH_VALUE, word.slice(0, 2))) {
      index += 1;
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
    return [...scopeTargets, pathTarget(".", gitBase, "git push working directory"), { kind: "git-push" }];
  }
  if (!subcommand || !Object.hasOwn(GIT_MUTATORS, subcommand)) return [];
  const subcommandArgs = args.slice(index + 1);

  if (subcommand === "clone") {
    const values = positionalArguments(subcommandArgs, GIT_CLONE_OPTIONS_WITH_VALUE);
    if (values.length === 0) return scopeTargets;
    const separateGitDir = optionArgument(subcommandArgs, undefined, "--separate-git-dir");
    const destination = values[1] ?? ".";
    const targets = separateGitDir
      ? [pathTarget(separateGitDir, gitBase, "git clone separate git directory", true)]
      : [];
    return [...scopeTargets, ...targets, pathTarget(destination, gitBase, "git clone destination", true)];
  }
  if (subcommand === "init") {
    const separateGitDir = optionArgument(subcommandArgs, undefined, "--separate-git-dir");
    const destination = positionalArguments(subcommandArgs, GIT_INIT_OPTIONS_WITH_VALUE)[0] ?? ".";
    const targets = separateGitDir
      ? [pathTarget(separateGitDir, gitBase, "git init separate git directory", true)]
      : [];
    const scopedTargets = scopeTargets.map((target) =>
      target.kind === "path" ? { ...target, creates: true as const } : target
    );
    return [...scopedTargets, ...targets, pathTarget(destination, gitBase, "git init destination", true)];
  }
  if (subcommand === "worktree") {
    const actionIndex = subcommandArgs.findIndex((value) => /^(?:add|move|remove)$/.test(value));
    if (actionIndex >= 0) {
      const action = subcommandArgs[actionIndex];
      const actionArgs = subcommandArgs.slice(actionIndex + 1);
      const values = action === "add"
        ? positionalArguments(actionArgs, GIT_WORKTREE_ADD_OPTIONS_WITH_VALUE)
        : positionalArguments(actionArgs, {});
      const targetCount = action === "move" ? 2 : 1;
      return [
        ...scopeTargets,
        ...values
          .slice(0, targetCount)
          .map((value, valueIndex) => pathTarget(
            value,
            gitBase,
            `git worktree ${action}`,
            action === "add" || (action === "move" && valueIndex === 1),
          )),
      ];
    }
  }
  if (subcommand === "config") {
    const values = positionalArguments(subcommandArgs, GIT_CONFIG_OPTIONS_WITH_VALUE);
    const mutatingFlag = subcommandArgs.some((value) =>
      /^(?:--add|--replace-all|--unset|--unset-all|--rename-section|--remove-section)$/.test(value),
    );
    if (!mutatingFlag && values.length < 2) return [];

    const configFile = optionArgument(subcommandArgs, "-f", "--file");
    if (configFile) return [...scopeTargets, pathTarget(configFile, gitBase, "git config file", true)];
    if (subcommandArgs.includes("--global")) {
      return [...scopeTargets, pathTarget(resolve(homedir(), ".gitconfig"), gitBase, "git config global")];
    }
    if (subcommandArgs.includes("--system")) {
      return [...scopeTargets, pathTarget("/etc/gitconfig", gitBase, "git config system")];
    }
  }


  return [...scopeTargets, pathTarget(".", gitBase, `git ${subcommand} working directory`)];
}

function commandTargets(words: string[], base: string | undefined): BashTarget[] {
  const commandWords = unwrapCommand(words);
  if (commandWords.length === 0) return [];

  const command = basename(commandWords[0]);
  const args = commandWords.slice(1);
  const argsWithoutOptions = operands(args);

  if (Object.hasOwn(DIRECT_MUTATORS, command)) {
    const creates = command === "mkdir" || command === "touch" || command === "truncate";
    return argsWithoutOptions.map((value) => pathTarget(value, base, command, creates));
  }
  if (command === "mktemp") {
    const locationIsImplicit = args.some((value) =>
      value === "--tmpdir" || value.startsWith("--tmpdir=") || /^-[^-]*[pt]/.test(value)
    );
    if (locationIsImplicit) return [{ kind: "opaque", value: "mktemp output directory" }];
    const template = positionalArguments(args, MKTEMP_OPTIONS_WITH_VALUE).at(-1);
    if (!template) return [{ kind: "opaque", value: "mktemp output path" }];
    const target = pathTarget(template, base, command, true);
    if (target.kind !== "path" || !/X{3,}$/.test(basename(target.value))) return [target];
    return [{ ...target, temporaryTemplate: true }];
  }
  if (Object.hasOwn(METADATA_MUTATORS, command)) {
    return argsWithoutOptions.slice(1).map((value) => pathTarget(value, base, command));
  }
  if (command === "mv") {
    return argsWithoutOptions.map((value, index) =>
      pathTarget(value, base, command, index === argsWithoutOptions.length - 1)
    );
  }
  if (Object.hasOwn(DESTINATION_MUTATORS, command)) {
    const destination = destinationOperand(args);
    return destination ? [pathTarget(destination, base, `${command} destination`, true)] : [];
  }
  if (command === "tee") {
    return argsWithoutOptions.map((value) => pathTarget(value, base, command, true));
  }
  if (command === "dd") {
    return args
      .filter((value) => value.startsWith("of="))
      .map((value) => pathTarget(value.slice(3), base, "dd output", true));
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
          targets.push(pathTarget(target.value, base, "shell redirection", true));
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
