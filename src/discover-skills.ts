import * as fs from "node:fs/promises";
import path from "node:path";

import matter from "gray-matter";

import type { SkillDefinition } from "./types";
import { getMaxSkillsPerSource, getMaxWalkDepth } from "./config";

type SkillFrontmatter = {
  name?: unknown;
  description?: unknown;
};

/** Valid skill IDs: alphanumeric, hyphens, underscores only. */
const SKILL_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

export function isValidSkillId(id: string): boolean {
  return SKILL_ID_PATTERN.test(id);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function walkFiles(
  rootDir: string,
  options?: { maxDepth?: number; log?: (msg: string) => void }
): Promise<string[]> {
  const results: string[] = [];
  const maxDepth = options?.maxDepth ?? Infinity;
  const log = options?.log;

  async function walk(currentDir: string, depth: number) {
    if (depth > maxDepth) {
      log?.(`Skipping directory exceeding max depth (${maxDepth}): ${currentDir}`);
      return;
    }

    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "node_modules") continue;

      // Symlinks are skipped to prevent traversal into targets outside the skills root.
      if (entry.isSymbolicLink()) {
        log?.(`Skipping symlink: ${path.join(currentDir, entry.name)}`);
        continue;
      }

      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath, depth + 1);
      } else if (entry.isFile()) {
        results.push(fullPath);
      }
    }
  }

  await walk(rootDir, 0);
  return results;
}

export async function discoverSkills(
  skillsRootDir: string,
  options?: { log?: (msg: string) => void }
): Promise<SkillDefinition[]> {
  const log = options?.log;
  const maxSkills = getMaxSkillsPerSource();
  const maxDepth = getMaxWalkDepth();

  let entries;
  try {
    entries = await fs.readdir(skillsRootDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const skills: SkillDefinition[] = [];

  for (const entry of entries) {
    if (skills.length >= maxSkills) {
      log?.(`Skill count limit (${maxSkills}) reached; skipping remaining entries in ${skillsRootDir}`);
      break;
    }

    // Symlinks to directories are skipped to prevent traversal outside the skills root.
    if (entry.isSymbolicLink()) {
      log?.(`Skipping symlink in skills root: ${entry.name}`);
      continue;
    }
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".")) continue;

    const id = entry.name;

    // Reject skill IDs that could be used for path traversal.
    if (!isValidSkillId(id)) {
      log?.(`Skipping skill directory with invalid ID: ${id}`);
      continue;
    }

    const dirPath = path.join(skillsRootDir, id);
    const skillFilePath = path.join(dirPath, "SKILL.md");

    if (!(await fileExists(skillFilePath))) continue;

    const raw = await fs.readFile(skillFilePath, "utf8");
    // Pass { engines: {} } to disable all custom YAML engines and prevent code execution
    // in frontmatter regardless of the gray-matter version's defaults.
    const parsed = matter(raw, { engines: {} });
    const fm = (parsed.data ?? {}) as SkillFrontmatter;

    const name =
      typeof fm.name === "string" && fm.name.trim().length > 0 ? fm.name.trim() : id;
    const description =
      typeof fm.description === "string" && fm.description.trim().length > 0
        ? fm.description.trim()
        : "";

    const allFiles = await walkFiles(dirPath, { maxDepth, log });
    const supportingFiles = allFiles
      .filter((p) => path.basename(p).toLowerCase() !== "skill.md")
      .sort((a, b) => a.localeCompare(b));

    skills.push({
      id,
      name,
      description,
      dirPath,
      skillFilePath,
      supportingFiles,
    });
  }

  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}

/** Root-level .md files directly under the skills folder (not in skill subdirs). */
export async function discoverRootMarkdown(skillsRootDir: string): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(skillsRootDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.toLowerCase().endsWith(".md")) continue;
    files.push(path.join(skillsRootDir, entry.name));
  }
  return files.sort((a, b) => a.localeCompare(b));
}
