import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

import type { InstallTarget, SkillInstallRecord } from "./types";
import { discoverRootMarkdown, isValidSkillId, walkFiles } from "./discover-skills";
import {
  getAllowedSkillFileExtensions,
  getMaxSkillFileSizeBytes,
  getMaxSkillTotalSizeBytes,
  getMaxWalkDepth,
  isWindowsReservedName,
} from "./config";
import {
  findInstall,
  getInstallTarget,
  getProjectSkillsDir,
  getPersonalSkillsDir,
  installedPathFor,
  loadMergedState,
  loadStateForTarget,
  recordInstall,
  removeInstall,
  saveStateForTarget,
} from "./state";

export class SyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyncError";
  }
}

/**
 * Copy a skill directory to a destination, applying security filters:
 * - Symlinks are skipped (via walkFiles).
 * - Only allowed file extensions are copied.
 * - Windows reserved filenames are rejected on all platforms.
 * - Per-file and total-size limits are enforced.
 *
 * Returns a map of relative file path → SHA-256 hash for integrity tracking.
 */
export async function copySkillDir(
  sourceDir: string,
  destDir: string,
  options?: { log?: (message: string) => void }
): Promise<Record<string, string>> {
  const log = options?.log ?? (() => { /* no-op */ });
  const allowedExts = getAllowedSkillFileExtensions();
  const maxFileSize = getMaxSkillFileSizeBytes();
  const maxTotalSize = getMaxSkillTotalSizeBytes();
  const maxDepth = getMaxWalkDepth();

  const allFiles = await walkFiles(sourceDir, { maxDepth, log });

  let totalSize = 0;
  const approved: Array<{ src: string; rel: string }> = [];

  for (const srcFile of allFiles) {
    const rel = path.relative(sourceDir, srcFile);
    const basename = path.basename(srcFile);
    const ext = path.extname(srcFile).toLowerCase();

    // Reject Windows reserved basenames on all platforms.
    if (isWindowsReservedName(basename)) {
      log(`Skipping reserved filename: ${rel}`);
      continue;
    }

    // Reject disallowed file types.
    if (!allowedExts.includes(ext)) {
      log(`Skipping disallowed file type (${ext}): ${rel}`);
      continue;
    }

    // Enforce per-file size limit.
    const stat = await fs.stat(srcFile);
    if (stat.size > maxFileSize) {
      log(`Skipping oversized file (${stat.size} bytes > ${maxFileSize}): ${rel}`);
      continue;
    }

    // Enforce total size limit.
    if (totalSize + stat.size > maxTotalSize) {
      log(`Skipping file — total size limit reached (${maxTotalSize} bytes): ${rel}`);
      continue;
    }

    totalSize += stat.size;
    approved.push({ src: srcFile, rel });
  }

  // Replace destination directory.
  await fs.mkdir(path.dirname(destDir), { recursive: true });
  await fs.rm(destDir, { recursive: true, force: true });
  await fs.mkdir(destDir, { recursive: true });

  // Copy approved files and compute SHA-256 hashes.
  const hashes: Record<string, string> = {};
  for (const { src, rel } of approved) {
    const dest = path.join(destDir, rel);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    const content = await fs.readFile(src);
    await fs.writeFile(dest, content);
    hashes[rel] = createHash("sha256").update(content).digest("hex");
  }

  return hashes;
}

export async function manualSkillBlocksInstall(
  skillId: string,
  target: InstallTarget,
  sourceId: string
): Promise<string | undefined> {
  const dest = installedPathFor(target, skillId);
  if (!dest) {
    return target === "project"
      ? "Open a workspace folder to install skills to the project"
      : "Cannot resolve personal skills directory";
  }

  try {
    await fs.stat(dest);
  } catch {
    return undefined;
  }

  const merged = await loadMergedState();
  const existing = findInstall(merged, sourceId, skillId);
  if (existing) return undefined;

  return `Manual skill present at ${dest}; rename or remove it before enabling`;
}

export async function installSkill(params: {
  sourceId: string;
  skillId: string;
  sourceDir: string;
  installTarget: InstallTarget;
  log?: (message: string) => void;
}): Promise<SkillInstallRecord> {
  const { sourceId, skillId, sourceDir, installTarget } = params;
  const log = params.log;

  // Reject skill IDs that do not match the safe pattern to prevent path traversal.
  if (!isValidSkillId(skillId)) {
    throw new SyncError(`Invalid skill ID: "${skillId}"`);
  }

  const block = await manualSkillBlocksInstall(skillId, installTarget, sourceId);
  if (block) throw new SyncError(block);

  const dest = installedPathFor(installTarget, skillId);
  if (!dest) throw new SyncError("Cannot resolve install path");

  // Verify the resolved destination is within the expected skills directory.
  const skillsDir = installTarget === "project" ? getProjectSkillsDir() : getPersonalSkillsDir();
  if (skillsDir) {
    const resolvedDest = path.resolve(dest);
    const resolvedParent = path.resolve(skillsDir);
    if (!resolvedDest.startsWith(resolvedParent + path.sep) && resolvedDest !== resolvedParent) {
      throw new SyncError(`Skill ID resolves outside skills directory: ${skillId}`);
    }
  }

  const fileHashes = await copySkillDir(sourceDir, dest, { log });

  const record: SkillInstallRecord = {
    sourceId,
    skillId,
    installTarget,
    installedPath: dest,
    sourcePath: sourceDir,
    installedAt: new Date().toISOString(),
    fileHashes,
  };
  await recordInstall(record);
  return record;
}

export async function uninstallSkill(
  sourceId: string,
  skillId: string
): Promise<void> {
  const merged = await loadMergedState();
  const record = findInstall(merged, sourceId, skillId);
  if (!record) return;

  try {
    await fs.rm(record.installedPath, { recursive: true, force: true });
  } catch {
    // destination may already be gone
  }

  await removeInstall(sourceId, skillId, record.installTarget);
}

export async function updateSkill(params: {
  sourceId: string;
  skillId: string;
  sourceDir: string;
  log?: (message: string) => void;
  onContentChange?: (changedFiles: string[]) => void;
}): Promise<void> {
  const merged = await loadMergedState();
  const record = findInstall(merged, params.sourceId, params.skillId);
  if (!record) {
    throw new SyncError("Skill is not enabled");
  }

  const newHashes = await copySkillDir(params.sourceDir, record.installedPath, { log: params.log });

  // Detect changed or removed files to surface integrity warnings.
  if (params.onContentChange) {
    const oldHashes = record.fileHashes ?? {};
    const changedFiles: string[] = [];
    for (const [file, hash] of Object.entries(newHashes)) {
      if (oldHashes[file] !== hash) changedFiles.push(file);
    }
    for (const file of Object.keys(oldHashes)) {
      if (!(file in newHashes)) changedFiles.push(file);
    }
    if (changedFiles.length > 0) {
      params.onContentChange(changedFiles);
    }
  }

  record.installedAt = new Date().toISOString();
  record.sourcePath = params.sourceDir;
  record.fileHashes = newHashes;
  await recordInstall(record);
}

export async function syncSharedRootFiles(
  skillsRoot: string,
  installTarget: InstallTarget
): Promise<void> {
  const destRoot =
    installTarget === "project" ? getProjectSkillsDir() : getPersonalSkillsDir();
  if (!destRoot) return;

  const files = await discoverRootMarkdown(skillsRoot);
  await fs.mkdir(destRoot, { recursive: true });

  for (const srcFile of files) {
    const destFile = path.join(destRoot, path.basename(srcFile));
    await fs.copyFile(srcFile, destFile);
  }
}

export async function rememberInstallTarget(
  sourceId: string,
  skillId: string,
  target: InstallTarget
): Promise<void> {
  const state = await loadStateForTarget(target);
  const key = `${sourceId}::${skillId}`;
  state.installTargets[key] = target;
  await saveStateForTarget(target, state);
}

export function resolvePreferredTarget(
  merged: Awaited<ReturnType<typeof loadMergedState>>,
  sourceId: string,
  skillId: string
): InstallTarget {
  const install = findInstall(merged, sourceId, skillId);
  if (install) return install.installTarget;
  return getInstallTarget(merged, sourceId, skillId);
}
