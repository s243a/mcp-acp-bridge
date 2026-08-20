/**
 * File access offered as MCP tools, so it can be gated.
 *
 * Same argument as execution: a built-in file tool acts before anything here
 * sees it, and the agent decides for itself whether to ask. Routed through MCP,
 * the call is held with the path — and, for a write, the content — in hand, so
 * what gets reviewed is the change rather than the fact that a change is coming.
 *
 * Paths are confined to the workspace. That is a second control and not a
 * substitute for the gate: an approved write should still be unable to land
 * outside the directory the session was given, whoever approved it and however
 * the path was spelled. `..`, an absolute path elsewhere, and a symlink whose
 * target escapes are all the same mistake wearing different clothes.
 *
 * Offering these does not stop an agent using its own file tools instead. A
 * deny rule does that; this is the path left open once the other is closed.
 *
 * @module fileTools
 */
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

/** Enough to work with; past this an agent should be narrowing its read. */
const MAX_READ = 200_000;

/**
 * Resolve a caller's path inside the workspace, or explain why it cannot be.
 *
 * Symlinks are resolved before the check, since a link inside the workspace
 * pointing outside it would otherwise pass. For a file that does not exist yet
 * the nearest existing parent is checked instead, which is what a write needs.
 */
function confine(root, requested) {
  if (typeof requested !== "string" || requested.trim().length === 0) {
    return { error: "a path is required" };
  }
  const target = isAbsolute(requested) ? requested : resolve(root, requested);

  let realRoot;
  try {
    realRoot = realpathSync(root);
  } catch {
    realRoot = resolve(root);
  }

  // Walk up to something that exists, so a new file is judged by its directory.
  let probe = target;
  let existing = null;
  while (existing === null) {
    try {
      existing = realpathSync(probe);
    } catch {
      const parent = dirname(probe);
      if (parent === probe) {
        existing = resolve(probe);
        break;
      }
      probe = parent;
    }
  }

  const suffix = relative(probe, target);
  const resolved = suffix ? resolve(existing, suffix) : existing;
  const within = resolved === realRoot || resolved.startsWith(`${realRoot}${sep}`);
  return within
    ? { path: resolved }
    : { error: `path is outside the workspace: ${requested}` };
}

/**
 * File tools bound to a session's workspace.
 *
 * `resolveCwd` is asked per call, since the tool list is built once and
 * sessions arrive later with workspaces of their own.
 */
export function createFileTools({ resolveCwd } = {}) {
  const rootFor = (context) => resolveCwd?.(context?.sessionId) ?? process.cwd();

  return [
    {
      name: "read_file",
      description:
        "Read a UTF-8 text file from the workspace. Use this instead of any built-in file-reading tool. Paths may be relative to the workspace root.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "File to read, relative to the workspace root." },
        },
        required: ["path"],
      },
      handler: async (args, context) => {
        const { path, error } = confine(rootFor(context), args?.path);
        if (error) return `Error: ${error}`;
        try {
          if (statSync(path).isDirectory()) return `Error: ${args.path} is a directory`;
          const text = readFileSync(path, "utf8");
          return text.length > MAX_READ
            ? `${text.slice(0, MAX_READ)}\n…[truncated at ${MAX_READ} characters]`
            : text || "[the file is empty]";
        } catch (cause) {
          return `Error: could not read ${args.path}: ${cause?.message ?? cause}`;
        }
      },
    },
    {
      name: "write_file",
      description:
        "Write a UTF-8 text file in the workspace, creating or replacing it. Use this instead of any built-in file-writing tool. The full content is reviewed before it is written, so send the file as it should end up.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "File to write, relative to the workspace root." },
          content: { type: "string", description: "The complete contents of the file." },
        },
        required: ["path", "content"],
      },
      handler: async (args, context) => {
        const { path, error } = confine(rootFor(context), args?.path);
        if (error) return `Error: ${error}`;
        if (typeof args?.content !== "string") return "Error: content is required";
        try {
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, args.content, "utf8");
          return `Wrote ${args.content.length} characters to ${args.path}.`;
        } catch (cause) {
          return `Error: could not write ${args.path}: ${cause?.message ?? cause}`;
        }
      },
    },
  ];
}

export { confine as confineToWorkspace };
