import { ClaudeAdapter } from "./claude";
import { CodexAdapter } from "./codex";
import { AiderAdapter } from "./aider";
import type { RunnerAdapter } from "./types";

/**
 * Adapter registry. Built-in providers ("claude", "codex") are constructed
 * fresh on demand; additional providers can be registered at runtime (tests
 * register "mock"; a future phase can add "aider"). Registered factories take
 * precedence over built-ins so a test can override behavior by name.
 */

type AdapterFactory = () => RunnerAdapter;

const registry = new Map<string, AdapterFactory>();

/** Register (or override) an adapter factory by name. */
export function registerAdapter(name: string, factory: AdapterFactory): void {
  registry.set(name, factory);
}

/** Resolve a fresh adapter instance by name. Throws for unknown names. */
export function getAdapter(name: string): RunnerAdapter {
  const factory = registry.get(name);
  if (factory) return factory();

  switch (name) {
    case "claude":
      return new ClaudeAdapter();
    case "codex":
      return new CodexAdapter();
    case "aider":
      return new AiderAdapter();
    default:
      throw new Error("Unknown adapter: " + name);
  }
}

/**
 * Probe availability of multiple adapters in parallel. Unknown names (and any
 * adapter whose isAvailable throws) resolve to false rather than rejecting.
 */
export async function probeAvailability(names: string[]): Promise<Record<string, boolean>> {
  const entries = await Promise.all(
    names.map(async (name) => {
      try {
        const available = await getAdapter(name).isAvailable();
        return [name, available] as const;
      } catch {
        return [name, false] as const;
      }
    }),
  );
  const result: Record<string, boolean> = {};
  for (const [name, available] of entries) {
    result[name] = available;
  }
  return result;
}
