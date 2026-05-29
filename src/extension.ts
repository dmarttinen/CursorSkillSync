import path from "node:path";

import * as vscode from "vscode";

import {
  disposeAutoRefresh,
  restartAutoRefresh,
  startAutoRefresh,
} from "./auto-refresh";
import { getSources, getSyncSharedContext, getWarnOnContentChange } from "./config";
import { discoverSkills } from "./discover-skills";
import { resolveAllSources, shouldPullOnRefresh } from "./source-resolver";
import {
  installSkill,
  manualSkillBlocksInstall,
  rememberInstallTarget,
  resolvePreferredTarget,
  SyncError,
  syncSharedRootFiles,
  uninstallSkill,
  updateSkill,
} from "./sync";
import {
  findInstall,
  loadMergedState,
  setInstallTarget as persistInstallTarget,
} from "./state";
import type {
  DiscoveredSkill,
  InstallTarget,
  ResolvedSource,
} from "./types";
import { stateKey } from "./types";

let outputChannel: vscode.OutputChannel;
let treeProvider: SkillsTreeProvider;

export function activate(context: vscode.ExtensionContext): void {
  outputChannel = vscode.window.createOutputChannel("Cursor Skills Sync");
  treeProvider = new SkillsTreeProvider();

  const treeView = vscode.window.createTreeView("cursorSkillsSync.skillsView", {
    treeDataProvider: treeProvider,
    manageCheckboxStateManually: true,
    showCollapseAll: true,
  });

  treeView.onDidChangeCheckboxState(async (event) => {
    for (const [item, state] of event.items) {
      if (!(item instanceof SkillTreeItem)) continue;
      if (state === vscode.TreeItemCheckboxState.Checked) {
        await treeProvider.enableSkill(item.skill);
      } else {
        await treeProvider.disableSkill(item.skill);
      }
    }
  });

  context.subscriptions.push(
    outputChannel,
    treeView,
    vscode.commands.registerCommand("cursorSkillsSync.refresh", () =>
      treeProvider.refresh()
    ),
    vscode.commands.registerCommand("cursorSkillsSync.updateAll", () =>
      treeProvider.updateAllEnabled()
    ),
    vscode.commands.registerCommand("cursorSkillsSync.openSettings", () =>
      vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "cursorSkillsSync"
      )
    ),
    vscode.commands.registerCommand("cursorSkillsSync.show", () =>
      vscode.commands.executeCommand(
        "workbench.view.extension.cursor-skills-sync"
      )
    ),
    vscode.commands.registerCommand(
      "cursorSkillsSync.enable",
      (item?: SkillTreeItem) => {
        if (item?.skill) return treeProvider.enableSkill(item.skill);
      }
    ),
    vscode.commands.registerCommand(
      "cursorSkillsSync.disable",
      (item?: SkillTreeItem) => {
        if (item?.skill) return treeProvider.disableSkill(item.skill);
      }
    ),
    vscode.commands.registerCommand(
      "cursorSkillsSync.update",
      (item?: SkillTreeItem) => {
        if (item?.skill) return treeProvider.updateSkill(item.skill);
      }
    ),
    vscode.commands.registerCommand(
      "cursorSkillsSync.setInstallTarget",
      (item?: SkillTreeItem) => {
        if (item?.skill) return treeProvider.pickInstallTarget(item.skill);
      }
    ),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("cursorSkillsSync.autoRefreshIntervalHours")) {
        restartAutoRefresh(() => treeProvider.refreshAndSyncInstalled({ silent: true }));
      }
      if (
        e.affectsConfiguration("cursorSkillsSync.sources") ||
        e.affectsConfiguration("cursorSkillsSync.gitPullOnUpdate")
      ) {
        void treeProvider.refresh();
      }
    }),
    disposeAutoRefresh()
  );

  startAutoRefresh(
    () => treeProvider.refreshAndSyncInstalled({ silent: true }),
    log
  );
  void treeProvider.refresh();
}

export function deactivate(): void {}

function log(message: string): void {
  outputChannel.appendLine(message);
}

class SourceTreeItem extends vscode.TreeItem {
  constructor(
    public readonly resolved: ResolvedSource,
    public readonly skills: DiscoveredSkill[]
  ) {
    const label = resolved.source.label;
    const suffix =
      resolved.source.type === "git"
        ? ` (${(resolved.source as { branch?: string }).branch ?? "main"})`
        : " (local)";
    super(`${label}${suffix}`, vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = "cursorSkillsSync.source";
    if (resolved.error) {
      this.description = resolved.error;
      this.iconPath = new vscode.ThemeIcon("error");
      this.tooltip = resolved.error;
    } else {
      this.description = `${skills.length} skill(s)`;
      this.iconPath = new vscode.ThemeIcon("folder-library");
    }
  }
}

class SkillTreeItem extends vscode.TreeItem {
  constructor(public readonly skill: DiscoveredSkill) {
    super(skill.name, vscode.TreeItemCollapsibleState.None);
    this.id = skill.stateKey;
    this.contextValue = skill.enabled
      ? "cursorSkillsSync.skillEnabled"
      : "cursorSkillsSync.skill";
    this.checkboxState = skill.enabled
      ? vscode.TreeItemCheckboxState.Checked
      : vscode.TreeItemCheckboxState.Unchecked;

    const targetLabel =
      skill.installTarget === "project" ? "$(folder) Project" : "$(person) Personal";
    const desc = skill.description
      ? truncate(skill.description, 80)
      : skill.id;
    this.description = `${targetLabel} · ${desc}`;
    this.tooltip = [
      skill.description || "(no description)",
      `ID: ${skill.id}`,
      `Target: ${skill.installTarget}`,
      skill.enabled ? `Installed: ${skill.installedPath ?? "—"}` : "Not installed",
    ].join("\n");
  }
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

class SkillsTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private sources: ResolvedSource[] = [];
  private skillsBySource = new Map<string, DiscoveredSkill[]>();

  refresh(): void {
    void this.load();
  }

  /** Re-discover sources, then recopy all enabled skills from source. */
  async refreshAndSyncInstalled(options?: { silent?: boolean }): Promise<void> {
    const silent = options?.silent ?? false;
    if (!silent) {
      log("Refresh and sync installed skills…");
    }
    await this.load();
    await this.updateAllEnabled({ silent });
    if (!silent) {
      log("Refresh and sync complete.");
    }
  }

  async load(): Promise<void> {
    const sources = getSources();
    const pull = shouldPullOnRefresh();
    log(`Refreshing ${sources.length} source(s)…`);

    this.sources = await resolveAllSources(sources, pull, log);
    const merged = await loadMergedState();
    this.skillsBySource.clear();

    for (const resolved of this.sources) {
      if (resolved.error) {
        this.skillsBySource.set(resolved.source.id, []);
        continue;
      }
      const defs = await discoverSkills(resolved.skillsRoot, { log });
      const skills: DiscoveredSkill[] = defs.map((def) => {
        const key = stateKey(resolved.source.id, def.id);
        const install = findInstall(merged, resolved.source.id, def.id);
        const installTarget = resolvePreferredTarget(
          merged,
          resolved.source.id,
          def.id
        );
        return {
          ...def,
          sourceId: resolved.source.id,
          stateKey: key,
          enabled: Boolean(install),
          installTarget,
          installedPath: install?.installedPath,
        };
      });
      this.skillsBySource.set(resolved.source.id, skills);
    }

    this._onDidChange.fire();
    log("Refresh complete.");
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
    if (!element) {
      return this.sources.map(
        (resolved) =>
          new SourceTreeItem(
            resolved,
            this.skillsBySource.get(resolved.source.id) ?? []
          )
      );
    }
    if (element instanceof SourceTreeItem) {
      return (this.skillsBySource.get(element.resolved.source.id) ?? []).map(
        (s) => new SkillTreeItem(s)
      );
    }
    return [];
  }

  private findResolved(sourceId: string): ResolvedSource | undefined {
    return this.sources.find((s) => s.source.id === sourceId);
  }

  private updateSkillInTree(skill: DiscoveredSkill, patch: Partial<DiscoveredSkill>): void {
    const list = this.skillsBySource.get(skill.sourceId);
    if (!list) return;
    const idx = list.findIndex((s) => s.stateKey === skill.stateKey);
    if (idx >= 0) {
      list[idx] = { ...list[idx]!, ...patch };
    }
  }

  async pickInstallTarget(skill: DiscoveredSkill): Promise<void> {
    const choice = await vscode.window.showQuickPick(
      [
        { label: "Workspace (.cursor/skills)", target: "project" as const },
        { label: "User (~/.cursor/skills)", target: "personal" as const },
      ],
      { placeHolder: `Install target for ${skill.name}` }
    );
    if (!choice) return;

    await this.changeInstallTarget(skill, choice.target);
  }

  async changeInstallTarget(
    skill: DiscoveredSkill,
    target: InstallTarget
  ): Promise<void> {
    if (skill.installTarget === target && !skill.enabled) {
      await rememberInstallTarget(skill.sourceId, skill.id, target);
      this.updateSkillInTree(skill, { installTarget: target });
      this._onDidChange.fire();
      return;
    }

    if (skill.enabled) {
      await uninstallSkill(skill.sourceId, skill.id);
      await rememberInstallTarget(skill.sourceId, skill.id, target);
      const resolved = this.findResolved(skill.sourceId);
      if (!resolved || resolved.error) return;
      const record = await installSkill({
        sourceId: skill.sourceId,
        skillId: skill.id,
        sourceDir: path.join(resolved.skillsRoot, skill.id),
        installTarget: target,
      });
      this.updateSkillInTree(skill, {
        installTarget: target,
        enabled: true,
        installedPath: record.installedPath,
      });
    } else {
      await rememberInstallTarget(skill.sourceId, skill.id, target);
      this.updateSkillInTree(skill, { installTarget: target });
    }
    this._onDidChange.fire();
  }

  async enableSkill(skill: DiscoveredSkill): Promise<void> {
    try {
      let target = skill.installTarget;
      const merged = await loadMergedState();
      const hasPreference = Boolean(
        merged.installTargets[stateKey(skill.sourceId, skill.id)]
      );

      if (!hasPreference) {
        const choice = await vscode.window.showQuickPick(
          [
            {
              label: "Install to workspace",
              description: "Project .cursor/skills",
              target: "project" as const,
            },
            {
              label: "Install to user",
              description: "~/.cursor/skills",
              target: "personal" as const,
            },
          ],
          { placeHolder: `Where should "${skill.name}" be installed?` }
        );
        if (!choice) {
          this._onDidChange.fire();
          return;
        }
        target = choice.target;
        await persistInstallTarget(skill.sourceId, skill.id, target);
      }

      const block = await manualSkillBlocksInstall(skill.id, target, skill.sourceId);
      if (block) {
        throw new SyncError(block);
      }

      const resolved = this.findResolved(skill.sourceId);
      if (!resolved?.skillsRoot || resolved.error) {
        throw new SyncError(resolved?.error ?? "Source unavailable");
      }

      const sourceDir = path.join(resolved.skillsRoot, skill.id);
      const record = await installSkill({
        sourceId: skill.sourceId,
        skillId: skill.id,
        sourceDir,
        installTarget: target,
      });

      if (getSyncSharedContext()) {
        await syncSharedRootFiles(resolved.skillsRoot, target);
      }

      this.updateSkillInTree(skill, {
        enabled: true,
        installTarget: target,
        installedPath: record.installedPath,
      });
      this._onDidChange.fire();
      vscode.window.showInformationMessage(`Enabled skill: ${skill.name}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(msg);
      log(`Enable failed: ${msg}`);
      this._onDidChange.fire();
    }
  }

  async disableSkill(skill: DiscoveredSkill): Promise<void> {
    try {
      await uninstallSkill(skill.sourceId, skill.id);
      this.updateSkillInTree(skill, { enabled: false, installedPath: undefined });
      this._onDidChange.fire();
      vscode.window.showInformationMessage(`Disabled skill: ${skill.name}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(msg);
      log(`Disable failed: ${msg}`);
    }
  }

  async updateSkill(
    skill: DiscoveredSkill,
    options?: { silent?: boolean }
  ): Promise<void> {
    const silent = options?.silent ?? false;
    try {
      const resolved = this.findResolved(skill.sourceId);
      if (!resolved?.skillsRoot || resolved.error) {
        throw new SyncError(resolved?.error ?? "Source unavailable");
      }

      if (resolved.source.type === "git" && shouldPullOnRefresh()) {
        const { resolveSource } = await import("./source-resolver");
        const refreshed = await resolveSource(resolved.source, { pull: true, log });
        if (refreshed.error) throw new SyncError(refreshed.error);
        resolved.skillsRoot = refreshed.skillsRoot;
      }

      const sourceDir = path.join(resolved.skillsRoot, skill.id);
      await updateSkill({
        sourceId: skill.sourceId,
        skillId: skill.id,
        sourceDir,
        log,
        onContentChange: (changedFiles) => {
          if (getWarnOnContentChange()) {
            vscode.window.showWarningMessage(
              `Skill "${skill.name}" content changed (${changedFiles.length} file(s) modified).`
            );
          }
          log(`Content change detected in "${skill.name}": ${changedFiles.join(", ")}`);
        },
      });

      if (getSyncSharedContext()) {
        const merged = await loadMergedState();
        const install = findInstall(merged, skill.sourceId, skill.id);
        if (install) {
          await syncSharedRootFiles(resolved.skillsRoot, install.installTarget);
        }
      }

      this._onDidChange.fire();
      if (!silent) {
        vscode.window.showInformationMessage(`Updated skill: ${skill.name}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!silent) {
        vscode.window.showErrorMessage(msg);
      }
      log(`Update failed (${skill.name}): ${msg}`);
    }
  }

  async updateAllEnabled(options?: { silent?: boolean }): Promise<void> {
    const silent = options?.silent ?? false;
    const enabled: DiscoveredSkill[] = [];
    for (const list of this.skillsBySource.values()) {
      enabled.push(...list.filter((s) => s.enabled));
    }
    if (enabled.length === 0) {
      if (!silent) {
        vscode.window.showInformationMessage("No enabled skills to update.");
      }
      return;
    }

    const run = async () => {
      for (const skill of enabled) {
        await this.updateSkill(skill, { silent });
      }
      if (silent) {
        log(`Auto-sync updated ${enabled.length} installed skill(s).`);
      }
    };

    if (silent) {
      await run();
      return;
    }

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Updating skills",
        cancellable: false,
      },
      run
    );
  }
}
