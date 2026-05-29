# Cursor Skills Sync

Cursor extension that discovers skills from configured local or git-backed source repos and copies them into native Cursor skill paths:

- **Project:** `<workspace>/.cursor/skills/<skill-id>/`
- **User:** `~/.cursor/skills/<skill-id>/`

Only directories recorded in `.skills-sync-state.json` are removed on disable, so hand-authored skills are not deleted.W

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
