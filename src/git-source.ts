import * as fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

import {
  getGitSparseClone,
  maskHomePath,
  sanitizeGitUrl,
  skillsRootFromRepoRoot,
  sparsePathsForGitSource,
  validateGitSource,
} from "./config";
import type { GitSkillSource } from "./types";

const execFileAsync = promisify(execFile);

const LARGE_BUFFER = 10 * 1024 * 1024; // clone / pull — may produce verbose output
const SMALL_BUFFER = 1 * 1024 * 1024;  // fetch / checkout / sparse-checkout

export type GitResult = {
  repoRoot: string;
  skillsRoot: string;
};

export async function ensureGitSource(
  source: GitSkillSource,
  pull: boolean,
  log: (message: string) => void
): Promise<GitResult> {
  const validation = validateGitSource(source);
  if (validation) {
    throw new Error(validation);
  }

  const clonePath = source.clonePath!;
  const branch = source.branch ?? "main";
  const sparsePaths = sparsePathsForGitSource(source);
  const useSparse = getGitSparseClone();
  // Sanitize URL (strips embedded credentials) and mask home path before logging.
  const safeUrl = sanitizeGitUrl(source.url);
  const safeClonePath = maskHomePath(clonePath);

  const exists = await directoryExists(clonePath);

  if (!exists) {
    if (useSparse) {
      log(
        `Sparse-cloning ${safeUrl} (branch ${branch}, paths: ${sparsePaths.join(", ")}) → ${safeClonePath}`
      );
      await fs.mkdir(path.dirname(clonePath), { recursive: true });
      await runGit(
        [
          "clone",
          "--branch",
          branch,
          "--single-branch",
          "--filter=blob:none",
          "--sparse",
          source.url,
          clonePath,
        ],
        path.dirname(clonePath),
        log,
        { maxBuffer: LARGE_BUFFER }
      );
      await applySparseCheckout(clonePath, sparsePaths, log);
    } else {
      log(`Cloning ${safeUrl} (branch ${branch}) → ${safeClonePath}`);
      await fs.mkdir(path.dirname(clonePath), { recursive: true });
      await runGit(
        ["clone", "--branch", branch, "--single-branch", source.url, clonePath],
        path.dirname(clonePath),
        log,
        { maxBuffer: LARGE_BUFFER }
      );
    }
  } else {
    if (useSparse) {
      await applySparseCheckout(clonePath, sparsePaths, log);
    }
    if (pull) {
      log(`Pulling ${safeClonePath} (branch ${branch})`);
      await runGit(["fetch", "origin", branch], clonePath, log, { maxBuffer: SMALL_BUFFER });
      await runGit(["checkout", branch], clonePath, log, { maxBuffer: SMALL_BUFFER });
      await runGit(["pull", "origin", branch], clonePath, log, { maxBuffer: LARGE_BUFFER });
      if (useSparse) {
        await runGit(["sparse-checkout", "reapply"], clonePath, log, {
          allowFailure: true,
          maxBuffer: SMALL_BUFFER,
        });
      }
    }
  }

  // Verify commit SHA if the source pins to a specific commit.
  if (source.commitSha) {
    const head = await runGit(["rev-parse", "HEAD"], clonePath, log, {
      capture: true,
      maxBuffer: SMALL_BUFFER,
    });
    if (head.trim() !== source.commitSha.trim()) {
      throw new Error(
        `Commit SHA mismatch for ${safeUrl}: expected ${source.commitSha}, got ${head.trim()}`
      );
    }
    log(`Commit SHA verified: ${source.commitSha}`);
  }

  const skillsRoot = skillsRootFromRepoRoot(clonePath);
  if (!(await directoryExists(skillsRoot))) {
    throw new Error(
      `Missing .cursor/skills in cloned repo: ${maskHomePath(skillsRoot)}. ` +
        `Ensure the remote has .cursor/skills or adjust sparsePaths / gitSparseCheckoutPaths.`
    );
  }

  if (useSparse) {
    log(
      `Git cache uses sparse checkout (${sparsePaths.join(", ")}). ` +
        `Delete ${safeClonePath} to reclaim space from an older full clone.`
    );
  }

  return { repoRoot: clonePath, skillsRoot };
}

async function applySparseCheckout(
  clonePath: string,
  sparsePaths: string[],
  log: (message: string) => void
): Promise<void> {
  const listed = await runGit(["sparse-checkout", "list"], clonePath, log, {
    capture: true,
    allowFailure: true,
    maxBuffer: SMALL_BUFFER,
  });

  const normalizedListed = normalizeSparseList(listed);
  const normalizedWanted = sparsePaths.map(normalizeSparsePath).sort();

  const alreadyMatches =
    normalizedListed.length === normalizedWanted.length &&
    normalizedListed.every((p, i) => p === normalizedWanted[i]);

  if (alreadyMatches) {
    return;
  }

  log(`Configuring sparse-checkout: ${sparsePaths.join(", ")}`);
  await runGit(["sparse-checkout", "init", "--cone"], clonePath, log, { maxBuffer: SMALL_BUFFER });
  await runGit(["sparse-checkout", "set", ...sparsePaths], clonePath, log, { maxBuffer: SMALL_BUFFER });
  await runGit(["sparse-checkout", "reapply"], clonePath, log, { allowFailure: true, maxBuffer: SMALL_BUFFER });
}

function normalizeSparsePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

function normalizeSparseList(output: string): string[] {
  if (!output.trim()) return [];
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(normalizeSparsePath)
    .sort();
}

async function directoryExists(dirPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function runGit(
  args: string[],
  cwd: string,
  log: (message: string) => void,
  options?: { capture?: boolean; allowFailure?: boolean; maxBuffer?: number }
): Promise<string> {
  log(`> git ${args.join(" ")}`);
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      maxBuffer: options?.maxBuffer ?? LARGE_BUFFER,
    });
    const out = stdout?.trim() ?? "";
    if (!options?.capture && out) log(out);
    if (stderr?.trim() && !options?.capture) log(stderr.trim());
    return out;
  } catch (err: unknown) {
    const message =
      err && typeof err === "object" && "stderr" in err
        ? String((err as { stderr?: string }).stderr ?? err)
        : String(err);
    if (options?.allowFailure) {
      log(message);
      return "";
    }
    throw new Error(message);
  }
}
