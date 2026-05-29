import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";

import * as vscode from "vscode";

import type { InstallTarget, SkillInstallRecord, SkillsSyncState } from "./types";
import { stateKey } from "./types";

const STATE_FILENAME = ".skills-sync-state.json";

/**
 * Minimal per-key async mutex implemented as a Promise chain.
 * Ensures state file read-modify-write operations are serialized per install target,
 * preventing data loss when concurrent operations race on the same file.
 */
class Mutex {
  private readonly locks = new Map<string, Promise<void>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => { release = resolve; });
    this.locks.set(key, previous.then(() => next));
    try {
      await previous;
      return await fn();
    } finally {
      release();
      if (this.locks.get(key) === previous.then(() => next)) {
        this.locks.delete(key);
      }
    }
  }
}

const stateMutex = new Mutex();

function emptyState(): SkillsSyncState {
  return { version: 1, installTargets: {}, installs: {} };
}

export function getPersonalSkillsDir(): string {
  return path.join(os.homedir(), ".cursor", "skills");
}

export function getProjectSkillsDir(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return undefined;
  return path.join(folders[0]!.uri.fsPath, ".cursor", "skills");
}

export function stateFileForTarget(target: InstallTarget): string | undefined {
  const skillsDir =
    target === "project" ? getProjectSkillsDir() : getPersonalSkillsDir();
  if (!skillsDir) return undefined;
  return path.join(skillsDir, STATE_FILENAME);
}

export function installedPathFor(
  target: InstallTarget,
  skillId: string
): string | undefined {
  const skillsDir =
    target === "project" ? getProjectSkillsDir() : getPersonalSkillsDir();
  if (!skillsDir) return undefined;
  return path.join(skillsDir, skillId);
}

export async function loadStateForTarget(
  target: InstallTarget
): Promise<SkillsSyncState> {
  const file = stateFileForTarget(target);
  if (!file) return emptyState();

  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw) as Partial<SkillsSyncState>;
    return {
      version: 1,
      installTargets: parsed.installTargets ?? {},
      installs: parsed.installs ?? {},
    };
  } catch {
    return emptyState();
  }
}

export async function loadMergedState(): Promise<SkillsSyncState> {
  const [project, personal] = await Promise.all([
    loadStateForTarget("project"),
    loadStateForTarget("personal"),
  ]);

  return {
    version: 1,
    installTargets: { ...personal.installTargets, ...project.installTargets },
    installs: { ...personal.installs, ...project.installs },
  };
}

export async function saveStateForTarget(
  target: InstallTarget,
  state: SkillsSyncState
): Promise<void> {
  const file = stateFileForTarget(target);
  if (!file) {
    throw new Error(
      target === "project"
        ? "No workspace folder open for project installs"
        : "Cannot resolve personal skills directory"
    );
  }

  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(file, JSON.stringify(state, null, 2), "utf8");
}

export async function getStateSliceForTarget(
  target: InstallTarget
): Promise<SkillsSyncState> {
  return loadStateForTarget(target);
}

export function getInstallTarget(
  state: SkillsSyncState,
  sourceId: string,
  skillId: string
): InstallTarget {
  const key = stateKey(sourceId, skillId);
  return state.installTargets[key] ?? "project";
}

export async function setInstallTarget(
  sourceId: string,
  skillId: string,
  target: InstallTarget
): Promise<void> {
  return stateMutex.run(target, async () => {
    const state = await loadStateForTarget(target);
    const key = stateKey(sourceId, skillId);
    state.installTargets[key] = target;
    await saveStateForTarget(target, state);
  });
}

export async function recordInstall(
  record: SkillInstallRecord
): Promise<void> {
  return stateMutex.run(record.installTarget, async () => {
    const state = await loadStateForTarget(record.installTarget);
    const key = stateKey(record.sourceId, record.skillId);
    state.installTargets[key] = record.installTarget;
    state.installs[key] = record;
    await saveStateForTarget(record.installTarget, state);
  });
}

export async function removeInstall(
  sourceId: string,
  skillId: string,
  target: InstallTarget
): Promise<void> {
  return stateMutex.run(target, async () => {
    const state = await loadStateForTarget(target);
    const key = stateKey(sourceId, skillId);
    delete state.installs[key];
    await saveStateForTarget(target, state);
  });
}

export function findInstall(
  merged: SkillsSyncState,
  sourceId: string,
  skillId: string
): SkillInstallRecord | undefined {
  return merged.installs[stateKey(sourceId, skillId)];
}
