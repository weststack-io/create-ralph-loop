import { run } from "./proc";

/**
 * Thin git helpers over the proc runner. Shared by the checkpoint logic and the
 * diff/integrity gates so there is one source of truth for git invocations.
 * All functions take an absolute repo cwd.
 */

async function git(args: string[], cwd: string) {
  return run("git", args, { cwd });
}

export async function isRepo(cwd: string): Promise<boolean> {
  const r = await git(["rev-parse", "--is-inside-work-tree"], cwd);
  return r.code === 0 && r.stdout.trim() === "true";
}

export async function hasCommits(cwd: string): Promise<boolean> {
  const r = await git(["rev-parse", "--verify", "HEAD"], cwd);
  return r.code === 0;
}

export async function currentSha(cwd: string): Promise<string> {
  const r = await git(["rev-parse", "HEAD"], cwd);
  return r.stdout.trim();
}

export async function isClean(cwd: string): Promise<boolean> {
  const r = await git(["status", "--porcelain"], cwd);
  return r.stdout.trim() === "";
}

export async function stageAll(cwd: string): Promise<void> {
  await git(["add", "-A"], cwd);
}

/** Stage everything and commit (skipping hooks). Returns the new commit SHA. */
export async function commitAll(cwd: string, message: string): Promise<string> {
  await git(["add", "-A"], cwd);
  await git(["commit", "--no-verify", "-m", message], cwd);
  return currentSha(cwd);
}

/** Hard reset + remove untracked files/dirs — full rollback to a checkpoint. */
export async function rollbackTo(cwd: string, sha: string): Promise<void> {
  await git(["reset", "--hard", sha], cwd);
  await git(["clean", "-fd"], cwd);
}

/** Staged file paths (relative). Call after stageAll to include new files. */
export async function stagedFiles(cwd: string): Promise<string[]> {
  const r = await git(["diff", "--cached", "--name-only"], cwd);
  return r.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}

export interface DiffStat {
  files: number;
  insertions: number;
  deletions: number;
}

/** Parse `git diff --cached --shortstat` into numbers (staged vs HEAD). */
export async function stagedDiffStat(cwd: string): Promise<DiffStat> {
  const r = await git(["diff", "--cached", "--shortstat"], cwd);
  return parseShortstat(r.stdout);
}

export function parseShortstat(text: string): DiffStat {
  const files = /(\d+) files? changed/.exec(text)?.[1];
  const ins = /(\d+) insertions?\(\+\)/.exec(text)?.[1];
  const del = /(\d+) deletions?\(-\)/.exec(text)?.[1];
  return {
    files: files ? Number(files) : 0,
    insertions: ins ? Number(ins) : 0,
    deletions: del ? Number(del) : 0,
  };
}
