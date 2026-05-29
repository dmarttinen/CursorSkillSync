import * as fs from "node:fs/promises";
import path from "node:path";

import type { GitSkillSource, LocalSkillSource, ResolvedSource, SkillSource } from "./types";
import {
  getGitPullOnUpdate,
  skillsRootFromRepoRoot,
  validateGitSource,
  validateLocalSource,
} from "./config";
import { ensureGitSource } from "./git-source";

export async function resolveSource(
  source: SkillSource,
  options: { pull: boolean; log: (message: string) => void }
): Promise<ResolvedSource> {
  if (source.type === "local") {
    return resolveLocalSource(source);
  }
  return resolveGitSourceResolved(source, options.pull, options.log);
}

async function resolveLocalSource(source: LocalSkillSource): Promise<ResolvedSource> {
  const validation = validateLocalSource(source);
  if (validation) {
    return { source, skillsRoot: "", repoRoot: source.path ?? "", error: validation };
  }

  const repoRoot = source.path;
  const skillsRoot = skillsRootFromRepoRoot(repoRoot);

  try {
    const stat = await fs.stat(skillsRoot);
    if (!stat.isDirectory()) {
      return {
        source,
        skillsRoot,
        repoRoot,
        error: `Missing .cursor/skills at ${skillsRoot}`,
      };
    }
  } catch {
    return {
      source,
      skillsRoot,
      repoRoot,
      error: `Missing .cursor/skills at ${skillsRoot}`,
    };
  }

  return { source, skillsRoot, repoRoot };
}

async function resolveGitSourceResolved(
  source: GitSkillSource,
  pull: boolean,
  log: (message: string) => void
): Promise<ResolvedSource> {
  const validation = validateGitSource(source);
  if (validation) {
    return { source, skillsRoot: "", repoRoot: source.clonePath ?? "", error: validation };
  }

  try {
    const result = await ensureGitSource(source, pull, log);
    return {
      source,
      skillsRoot: result.skillsRoot,
      repoRoot: result.repoRoot,
    };
  } catch (err) {
    return {
      source,
      skillsRoot: "",
      repoRoot: source.clonePath ?? "",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function resolveAllSources(
  sources: SkillSource[],
  pull: boolean,
  log: (message: string) => void
): Promise<ResolvedSource[]> {
  return Promise.all(sources.map((s) => resolveSource(s, { pull, log })));
}

export function shouldPullOnRefresh(): boolean {
  return getGitPullOnUpdate();
}
