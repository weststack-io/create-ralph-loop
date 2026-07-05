import { currentSha, isClean, commitAll, rollbackTo } from "../util/git";

/**
 * Git checkpoint/rollback used by the iteration state machine. Every iteration
 * runs against a known-good commit; a failed gate or verifier reverts hard to
 * it (hermes-agent checkpoint pattern).
 */

/** Ensure a clean checkpoint commit exists and return its SHA. */
export async function ensureCheckpoint(cwd: string, label: string): Promise<string> {
  if (!(await isClean(cwd))) {
    return commitAll(cwd, `ralph: checkpoint ${label}`);
  }
  return currentSha(cwd);
}

/** Hard-revert the working tree to a checkpoint SHA (discards all changes). */
export async function rollback(cwd: string, sha: string): Promise<void> {
  await rollbackTo(cwd, sha);
}

/** Stage everything and commit with a message; returns the new SHA. */
export async function acceptCommit(cwd: string, message: string): Promise<string> {
  return commitAll(cwd, message);
}
