# Cursor Skills Sync

Cursor extension that lets developers opt in to individual Cursor skills from shared team repositories or local projects — with full control over which skills are active and whether they apply at project or user level.

## Why this extension exists

Sharing Cursor skills across a development team sounds simple in practice it creates several real problems.

**Skills accumulate silently.** When skills live in a shared git repo, pulling the latest branch can quietly introduce new skills without the developer noticing. There is no prompt, no review step — the skills just appear.

**Agents pick up skills they should not.** Cursor agents scan all available skills and will use whichever one seems relevant. If a repo contains skills the developer did not intend to activate, an agent may invoke them unexpectedly, performing actions the user did not ask for.

**Naming conflicts cause wrong-skill selection.** When multiple skills address similar tasks, an agent may pick the wrong one. Skills poorly matched to the current context, or skills with similar names and different purposes, produce unreliable agent behavior.

**Poorly formed skills waste tokens.** A skill with a badly written prompt or an overly broad trigger can run on queries it was never meant for, burning tokens on every interaction.

**Skills are project-scoped by default, user-scoping requires manual work.** Skills committed to a repo apply to that project only. Moving a skill to your personal `~/.cursor/skills` folder so it is available everywhere requires manual copying and ongoing maintenance.

---

Cursor Skills Sync solves these problems by giving each developer explicit, per-skill control:

- **Browse** skills discovered from any number of sources (team repos, personal repos, local folders).
- **Opt in** to only the skills you want active. Nothing is installed automatically on a pull.
- **Choose scope** per skill — install to the current project or to your personal user-level skills folder.
- **Stay current** with manual or scheduled refreshes that pull the latest skill content only for skills you have already opted in to.

Cursor extension that discovers skills from configured local or git-backed source repos and copies them into native Cursor skill paths:

- **Project:** `<workspace>/.cursor/skills/<skill-id>/`
- **User:** `~/.cursor/skills/<skill-id>/`

Only directories recorded in `.skills-sync-state.json` are removed on disable, so hand-authored skills are not deleted.

## Install

### Development (F5)

1. Open the CursorSkillSync repo in VS Code or Cursor.
2. `npm install && npm run compile`
3. Run **Run Extension** from `extensions/cursor-skills-sync/.vscode/launch.json` (or add that path to your workspace launch config).
4. In the Extension Development Host window, open a project workspace and configure sources (below).

### VSIX

```bash
cd extensions/cursor-skills-sync
npm install
npm run compile
npm run package
```

Install the generated `.vsix` via **Extensions → … → Install from VSIX**.

### Install Without Marketplace (GitHub Releases)

1. Open the Releases page for this repository.
2. Download the `.vsix` file from the desired release.
3. In Cursor or VS Code, run **Extensions: Install from VSIX...**.
4. Select the downloaded `.vsix` file.

## Automated VSIX Releases

This repository includes a GitHub Actions workflow that builds and attaches a VSIX to GitHub Releases.
It runs when you publish a GitHub Release or push a tag like `v0.1.1`.

1. Bump `version` in `package.json`.
2. Commit and push to `main`.
3. Create and push a version tag such as `v0.1.1`.
4. GitHub Actions builds the extension and uploads the VSIX to that release.
## Configuration

User settings (`cursorSkillsSync.*`):

```json
{
  "cursorSkillsSync.sources": [
    {
      "id": "SkillsLocal",
      "label": "Skills Local",
      "type": "local",
      "path": "c:/path/to/dir/Skills"
    },
    {
      "id": "SkillsRepo",
      "label": "Skills Repo",
      "type": "git",
      "url": "https://path/_git/SkillsRepo",
      "branch": "main",
      "clonePath": "${userHome}/.cursor/skills-sync-cache/skills-repo"
    }
  ],
  "cursorSkillsSync.gitPullOnUpdate": true,
  "cursorSkillsSync.syncSharedContext": true,
  "cursorSkillsSync.autoRefreshIntervalHours": 1
}
```

- **local** — `path` must contain `.cursor/skills/<skill-id>/SKILL.md`.
- **autoRefreshIntervalHours** — on a timer: **Refresh** the catalog (git pull when `gitPullOnUpdate` is true) and **Update All** for every enabled skill. `0` = off.
- **git** — sparse-clones only `.cursor` by default (`gitSparseClone` / `gitSparseCheckoutPaths`), so large application repos do not download entirely. Cache: `~/.cursor/skills-sync-cache/<id>`. Per-source override: `"sparsePaths": [".cursor/skills"]`. Delete an old cache folder to reclaim space from a previous full clone. Requires Git 2.27+.

## UI

Activity bar → **Cursor Skills Sync** (card sync icon on the left sidebar).

If you do not see the icon: Command Palette → **Cursor Skills Sync: Show Skills View**, or right-click the activity bar → ensure **Cursor Skills Sync** is checked.

- Checkbox per skill (enable / disable)
- Description shows Project vs Personal target
- Toolbar: **Refresh**, **Update All**, **Open Settings**
- Context menu: **Set Install Target…**, **Update** (enabled skills)

**Multi-root workspaces:** project installs use the **first** workspace folder.

## Provenance state

| Target | State file |
|--------|------------|
| Project | `<workspace>/.cursor/skills/.skills-sync-state.json` |
| Personal | `~/.cursor/skills/.skills-sync-state.json` |

Recommend adding to `.gitignore` if teams do not commit synced skills:

```gitignore
.cursor/skills/.skills-sync-state.json
```

## Output

Git and sync messages: **View → Output → Cursor Skills Sync**.
