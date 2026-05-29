export type InstallTarget = "project" | "personal";

export type LocalSkillSource = {
  id: string;
  label: string;
  type: "local";
  path: string;
};

export type GitSkillSource = {
  id: string;
  label: string;
  type: "git";
  url: string;
  branch?: string;
  clonePath?: string;
  /** Sparse-checkout paths for this repo (default: [".cursor"]). */
  sparsePaths?: string[];
  /** Pin to a specific commit SHA; the extension verifies HEAD matches after clone/pull. */
  commitSha?: string;
};

export type SkillSource = LocalSkillSource | GitSkillSource;

export type SkillDefinition = {
  /** Folder name under skills root (stable id) */
  id: string;
  name: string;
  description: string;
  dirPath: string;
  skillFilePath: string;
  supportingFiles: string[];
};

export type SkillInstallRecord = {
  sourceId: string;
  skillId: string;
  installTarget: InstallTarget;
  installedPath: string;
  sourcePath: string;
  installedAt: string;
  /** SHA-256 hashes of installed files, keyed by path relative to installedPath. */
  fileHashes?: Record<string, string>;
};

export type SkillsSyncState = {
  version: 1;
  /** Preferred install target per sourceId::skillId (even when disabled) */
  installTargets: Record<string, InstallTarget>;
  installs: Record<string, SkillInstallRecord>;
};

export type ResolvedSource = {
  source: SkillSource;
  skillsRoot: string;
  repoRoot: string;
  error?: string;
};

export type DiscoveredSkill = SkillDefinition & {
  sourceId: string;
  stateKey: string;
  enabled: boolean;
  installTarget: InstallTarget;
  installedPath?: string;
};

export function stateKey(sourceId: string, skillId: string): string {
  return `${sourceId}::${skillId}`;
}
