import * as os from "node:os";
import path from "node:path";

import * as vscode from "vscode";

import type { GitSkillSource, LocalSkillSource, SkillSource } from "./types";

const SKILLS_SUBPATH = path.join(".cursor", "skills");

// Windows reserved basenames that must never be used as filenames (all platforms).
const WINDOWS_RESERVED_NAMES = new Set([
  "CON", "PRN", "AUX", "NUL",
  "COM0", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
  "LPT0", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
]);

export function isWindowsReservedName(filename: string): boolean {
  const base = path.basename(filename, path.extname(filename)).toUpperCase();
  return WINDOWS_RESERVED_NAMES.has(base);
}

/** Strip embedded credentials from a git URL before logging. SSH shorthand is returned as-is. */
export function sanitizeGitUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    // SSH shorthand (git@host:org/repo.git) — no embedded credentials to strip.
    return url;
  }
}

/** Replace the user's home directory prefix with ~ to avoid leaking paths in logs. */
export function maskHomePath(value: string): string {
  const home = os.homedir();
  if (value.startsWith(home)) {
    return "~" + value.slice(home.length);
  }
  return value;
}

export function resolveConfigPath(value: string): string {
  const home = os.homedir();
  return value
    .replace(/\$\{userHome\}/gi, home)
    .replace(/\$\{env:([^}]+)\}/gi, (_, name: string) => process.env[name] ?? "");
}

export function getSources(): SkillSource[] {
  const config = vscode.workspace.getConfiguration("cursorSkillsSync");
  const raw = config.get<SkillSource[]>("sources", []);
  return raw.map(normalizeSource);
}

export function getGitPullOnUpdate(): boolean {
  return vscode.workspace.getConfiguration("cursorSkillsSync").get("gitPullOnUpdate", true);
}

export function getSyncSharedContext(): boolean {
  return vscode.workspace.getConfiguration("cursorSkillsSync").get("syncSharedContext", true);
}

/** Hours between automatic skill catalog refreshes; 0 disables. */
/** When true, git sources use partial clone + sparse-checkout (see gitSparseCheckoutPaths). */
export function getGitSparseClone(): boolean {
  return vscode.workspace.getConfiguration("cursorSkillsSync").get("gitSparseClone", true);
}

/** Default sparse-checkout paths for git sources (e.g. [".cursor"]). */
export function getGitSparseCheckoutPaths(): string[] {
  const paths = vscode.workspace
    .getConfiguration("cursorSkillsSync")
    .get<string[]>("gitSparseCheckoutPaths", [".cursor"]);
  if (!Array.isArray(paths) || paths.length === 0) {
    return [".cursor"];
  }
  return paths.map((p) => p.trim()).filter(Boolean);
}

export function sparsePathsForGitSource(source: GitSkillSource): string[] {
  if (source.sparsePaths?.length) {
    return source.sparsePaths.map((p) => p.trim()).filter(Boolean);
  }
  return getGitSparseCheckoutPaths();
}

export function getAutoRefreshIntervalHours(): number {
  const value = vscode.workspace
    .getConfiguration("cursorSkillsSync")
    .get<number>("autoRefreshIntervalHours", 0);
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return value;
}

export function getAllowedSkillFileExtensions(): string[] {
  const value = vscode.workspace
    .getConfiguration("cursorSkillsSync")
    .get<string[]>("allowedSkillFileExtensions", [".md", ".txt", ".json", ".yaml", ".yml"]);
  if (!Array.isArray(value) || value.length === 0) {
    return [".md", ".txt", ".json", ".yaml", ".yml"];
  }
  return value.map((e) => (e.startsWith(".") ? e.toLowerCase() : `.${e.toLowerCase()}`));
}

export function getMaxSkillFileSizeBytes(): number {
  const value = vscode.workspace
    .getConfiguration("cursorSkillsSync")
    .get<number>("maxSkillFileSizeBytes", 512 * 1024);
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 512 * 1024;
}

export function getMaxSkillTotalSizeBytes(): number {
  const value = vscode.workspace
    .getConfiguration("cursorSkillsSync")
    .get<number>("maxSkillTotalSizeBytes", 5 * 1024 * 1024);
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 5 * 1024 * 1024;
}

export function getMaxSkillsPerSource(): number {
  const value = vscode.workspace
    .getConfiguration("cursorSkillsSync")
    .get<number>("maxSkillsPerSource", 100);
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 100;
}

export function getMaxWalkDepth(): number {
  const value = vscode.workspace
    .getConfiguration("cursorSkillsSync")
    .get<number>("maxWalkDepth", 10);
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 10;
}

export function getWarnOnContentChange(): boolean {
  return vscode.workspace
    .getConfiguration("cursorSkillsSync")
    .get<boolean>("warnOnContentChange", true);
}

function normalizeSource(source: SkillSource): SkillSource {
  if (source.type === "local" && source.path) {
    return { ...source, path: resolveConfigPath(source.path) };
  }
  if (source.type === "git") {
    const git = source as GitSkillSource;
    const clonePath =
      git.clonePath ??
      path.join(os.homedir(), ".cursor", "skills-sync-cache", git.id);
    return {
      ...git,
      branch: git.branch ?? "main",
      clonePath: resolveConfigPath(clonePath),
    };
  }
  return source;
}

export function skillsRootFromRepoRoot(repoRoot: string): string {
  return path.join(repoRoot, SKILLS_SUBPATH);
}

export function validateLocalSource(source: LocalSkillSource): string | undefined {
  if (!source.path?.trim()) {
    return "Local source is missing path";
  }
  return undefined;
}

export function validateGitSource(source: GitSkillSource): string | undefined {
  if (!source.url?.trim()) {
    return "Git source is missing url";
  }
  const url = source.url.trim();
  if (!url.startsWith("https://") && !url.startsWith("git@")) {
    if (url.startsWith("file://")) {
      return "Git source URL uses the 'file://' scheme which is not allowed; use https:// or git@";
    }
    if (url.startsWith("http://")) {
      return "Git source URL uses insecure 'http://' scheme; use https:// instead";
    }
    const scheme = url.split(":")[0] ?? url;
    return `Git source URL must use https:// or git@ scheme (got: ${scheme})`;
  }
  if (!source.clonePath?.trim()) {
    return "Git source is missing clonePath";
  }
  return undefined;
}

export function defaultClonePath(sourceId: string): string {
  return path.join(os.homedir(), ".cursor", "skills-sync-cache", sourceId);
}
