import spawn from "cross-spawn";
import treeKill from "tree-kill";

/**
 * Cross-platform process runner built on cross-spawn (which resolves `.cmd`
 * shims and handles argument quoting correctly on Windows). This is the single
 * choke point for spawning child processes — adapters, gates, the dev-server
 * manager and git checkpointing all go through here, so we deliberately avoid
 * ESM-only deps like execa and keep the package CommonJS.
 */

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Text piped to the child's stdin (used to pass large prompts to agent CLIs). */
  input?: string;
  /** Kill the child (and its tree) after this many ms. 0/undefined = no timeout. */
  timeoutMs?: number;
  /** Max bytes to retain per stream before truncating (default 20 MiB). */
  maxBuffer?: number;
  /** Called with each stdout chunk as it arrives (for live streaming). */
  onStdout?: (chunk: string) => void;
  /** Called with each stderr chunk as it arrives. */
  onStderr?: (chunk: string) => void;
}

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** stdout + stderr interleaved is not tracked; this is stdout then stderr. */
  combined: string;
  timedOut: boolean;
  durationMs: number;
}

const DEFAULT_MAX_BUFFER = 20 * 1024 * 1024;

/**
 * Run a command with an explicit argv array (no shell). Preferred for invoking
 * known binaries (claude, codex, git) — safe against injection and arg-length
 * quirks. Pass big inputs via `opts.input` (stdin), not argv.
 */
export function run(command: string, args: string[] = [], opts: RunOptions = {}): Promise<RunResult> {
  return spawnInternal(command, args, opts, false);
}

/**
 * Run a full command line through the platform shell. Needed for user-configured
 * commands like "npm run dev" or "npx tsc --noEmit" that may rely on shell
 * features. Do not pass untrusted input here.
 */
export function runShell(commandLine: string, opts: RunOptions = {}): Promise<RunResult> {
  return spawnInternal(commandLine, [], opts, true);
}

function spawnInternal(
  command: string,
  args: string[],
  opts: RunOptions,
  shell: boolean,
): Promise<RunResult> {
  const start = Date.now();
  const maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_BUFFER;

  return new Promise<RunResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      shell,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let settled = false;

    const timer =
      opts.timeoutMs && opts.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            if (child.pid) treeKill(child.pid, "SIGKILL");
            else child.kill("SIGKILL");
          }, opts.timeoutMs)
        : null;

    child.stdout?.on("data", (d: Buffer) => {
      const s = d.toString();
      opts.onStdout?.(s);
      if (!stdoutTruncated) {
        stdout += s;
        if (stdout.length > maxBuffer) {
          stdout = stdout.slice(0, maxBuffer) + "\n…[stdout truncated]";
          stdoutTruncated = true;
        }
      }
    });

    child.stderr?.on("data", (d: Buffer) => {
      const s = d.toString();
      opts.onStderr?.(s);
      if (!stderrTruncated) {
        stderr += s;
        if (stderr.length > maxBuffer) {
          stderr = stderr.slice(0, maxBuffer) + "\n…[stderr truncated]";
          stderrTruncated = true;
        }
      }
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({
        code,
        signal,
        stdout,
        stderr,
        combined: stdout + (stderr ? (stdout ? "\n" : "") + stderr : ""),
        timedOut,
        durationMs: Date.now() - start,
      });
    });

    if (opts.input !== undefined) {
      child.stdin?.on("error", () => {
        /* ignore EPIPE if the child exits before consuming stdin */
      });
      child.stdin?.end(opts.input);
    } else {
      child.stdin?.end();
    }
  });
}

/**
 * Best-effort check that a command exists on PATH. Uses `where` on Windows and
 * `command -v` on POSIX. Returns false on any failure.
 */
export async function commandExists(command: string): Promise<boolean> {
  try {
    const finder = process.platform === "win32" ? "where" : "command";
    const args = process.platform === "win32" ? [command] : ["-v", command];
    const res =
      process.platform === "win32"
        ? await run(finder, args)
        : await runShell(`command -v ${command}`);
    return res.code === 0;
  } catch {
    return false;
  }
}

/** Kill a process tree by pid (cross-platform). Resolves once done. */
export function killTree(pid: number, signal: string = "SIGTERM"): Promise<void> {
  return new Promise((resolve) => {
    treeKill(pid, signal, () => resolve());
  });
}
