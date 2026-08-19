# Storage Manager

Browse, create, and **move** files and physical folders across your Directus adapters (local disk, S3, Google Cloud, Azure, and more) — without losing the file’s identity in Directus.

> **Important:** Studio **moves** objects between storages and updates where Directus looks for them. The same `directus_files` UUID is kept. Prefer a **Dry Run** before a large move. Copy is available in the Flow operation only (it leaves an unregistered leftover on the source).

## Overview

<img alt="Storage Manager overview with local, local2, S3, and GCS adapters" src="https://raw.githubusercontent.com/domdus/directus-extension-storage-manager/main/docs/screenshot_storage_manager.png" width="800" />

Directus can use several storage locations at once, but it does not move existing files for you when you change storage. **Storage Manager** fills that gap: see what lives on each adapter, optionally **mirror Directus folders** onto that adapter, browse physical folders on disk/bucket, upload files, find objects missing from Directus, **materialize** a virtual folder tree onto storage, and **move** selected files, folders, or a whole adapter.

Files keep the same ID in Directus. Only their storage location (and optionally their path under that location) changes. Image thumbnails / transforms are moved with them when possible.

## Features

### Overview & adapters

- See every configured storage location with file counts, folder counts, usage, and root / bucket
- Per-adapter **Mirror Directus Folders** toggle
- **Browse** opens that adapter’s files and folders

### Mirror Directus Folders

When enabled on a storage card, that adapter follows the Directus virtual folder tree:

- **New uploads** land under the matching physical path (folder names)
- **Rename / delete** of a Directus folder updates physical paths **on this adapter only**

A Directus folder is **virtual**: it can contain files from several adapters at once. Example: `Articles` has some files on `local` and some on `s3`. If both have Mirror on, a rename updates `local` and `s3` independently (each only its own objects). If only `local` has Mirror on, `s3` paths stay unchanged.

Sibling folders with the same name use `name_<folder-uid>` so paths stay unique. The first folder to claim a plain name keeps it.

Mirror does **not** rewrite files that are already on disk. Use **Move to Storage Folder** or **Materialize** for existing files.

### Left navigation

1. **Storage Manager** (overview)
2. **Storage adapters** — expandable physical folder trees
3. **Directus Folders** — virtual folder tree
4. **Settings**

Trees expand down to the current folder / storage path on load and refresh.

### Browse UI

- Same card / table layouts as the File Library
- Physical folder cards appear next to files when browsing a storage path
- File detail opens in-module (back stays in Storage Manager)
- Search, filter, and layout presets are remembered per browser
- **Upload** (header **+**, sidebar, empty states) opens a File Library–style **dropzone dialog**
- Window-level drag-and-drop onto the page still works
- In Directus Folders view, each file card shows which storage it lives on

### Physical storage folders

Manage real folders on disk / in the bucket (not only Directus virtual folders):

- **Create Storage Folder** — local `mkdir`, or a `.keep` marker on cloud adapters so empty folders survive
- Right-click context menu (nav + folder cards):
  - **Rename Folder** — rewrites nested registered files’ paths and moves objects on disk
  - **Move to Folder** — reparent under another storage path
  - **Delete Folder** — File Library–style dialog: move registered content one level up, or delete all content, then remove the folder
- **Delete** (header) — selected files via core `/files` delete; when storage folders are selected, same Delete Folder dialog as above
- Upload / drop into a nested path places the file under that folder after create

Example: create `My Test Folder` on `local`, upload while browsing it → object lands under `My Test Folder/` on disk and in `filename_disk`.

### Move to Storage Folder

One dialog for selected files, selected physical folders, the current Directus folder (nothing selected), or **Move all** at a storage root.

- Pick a destination **adapter + physical path**
- **Dry Run** counts files, folders, empty folders, size, and destination conflicts (sample from → to paths)
- **Include empty folders** when moving a whole adapter or selected folders (local `mkdir` / cloud `.keep`)
- Selected **folders keep their name** (`local/hello` → `local2/hello`). If `hello/` already exists on the destination, contents are **merged into it**
- Loose **files** flatten to the basename under the destination path
- Whole-adapter moves **preserve nested paths**
- Studio always **moves** (no Copy in the UI)

<img alt="Move Files progress from local to S3" src="https://raw.githubusercontent.com/domdus/directus-extension-storage-manager/main/docs/screenshot_storage_move_to_gcs.png" width="800" />

#### Conflicts

| Situation | What happens |
| --- | --- |
| Destination **folder** already exists | Contents are merged into it |
| Destination **path** already has another `directus_files` row | Incoming file is **skipped** — it stays on the source. Two files are never pointed at the same path |
| Destination **blob** exists but no other file row owns it | Treated as resume: this file is pointed at the dest path, then the source is removed |

### Materialize

In **Directus Folders**, turn the virtual tree into physical storage paths:

- **Keep** — each file stays on its current adapter; only the folder path is created there. Optional **structure-only** (folders, no file moves)
- **Merge** — all files move onto one target adapter at their virtual folder path
- Recursive (include subfolders)
- Dry run with file / folder / conflict counts

The virtual folder tree in the File Library is never rewritten here.

<img alt="Materialize Folder drawer with Keep and Merge storage modes" src="https://raw.githubusercontent.com/domdus/directus-extension-storage-manager/main/docs/screenshot_storage_materialize.png" width="800" />

### Thumbnails & transforms

Directus stores generated transforms at the **storage root** as `{stem}__{hash}.ext` (for example `uuid__7abd30….avif`).

- Move copies related transforms to the **target root** basename (where AssetsService expects them)
- Same-adapter folder rename / move keeps root transforms and cleans colocated orphans when needed
- **Detect** / orphan import / orphan delete skip generated thumbnails, dotfiles, and `directus-health-file`

### Detect files

- Scan for objects on disk / bucket that are **not** in Directus yet
- At storage root: **Detect Files on {adapter}**
- Inside a physical folder: **Detect Files in this Folder** (scan scoped to that path and subfolders)
- Import creates database rows only — files stay where they are. Image width/height are read so Directus can generate thumbnails
- Delete selected orphans permanently (thumbnails are never deleted via this path)

### Settings

- **Check now** for a published npm update
- **Export / Import** JSON backup of Mirror Directus Folders settings
- **Delete** stored `storage_manager` data from `directus_settings` (field is recreated empty on next start if the extension is still installed)

### Automation

- **Storage Manager** Flow operation — copy or move files in automations (file IDs, source storage, and/or folder + recursive). Copy leaves an unregistered leftover on the source (it will show up under Detect).

## Getting started

1. Configure more than one storage location if you plan to move files (for example `local` and `s3`).
2. As an admin, open **Settings → Project Settings → Modules** and enable **Storage Manager**.
3. Open **Storage Manager** from the left bar.
4. On the overview, turn on **Mirror Directus Folders** per adapter if you want new uploads and folder rename/delete to follow the virtual tree.
5. **Browse** a storage (or **Directus Folders**) and work with files / physical folders.
6. Use **Move to Storage Folder** (or **Move all** at a storage root). Dry-run first, then Move.

Tips:

- After a **Copy** (Flow operation only), leftovers on the old storage can show up under **Detect** — that is expected.
- Cloud storages often cannot report a full disk quota; the UI then shows Directus file totals only.
- Virtual folders can span multiple storages; Mirror is always per-adapter.
- Same-name sibling Directus folders use `name_<folder-uid>` on disk so paths stay unique.

## Readable URLs for paths with spaces

Disk and the database keep real spaces. Studio routes encode spaces as `_` and existing underscores as `__` so URLs stay readable and reversible.

| On disk / in DB | In the Studio URL |
| --- | --- |
| `My Test Folder` | `/storage-manager/storage/local/path/My_Test_Folder` |
| `already_underscored` | `…/already__underscored` |

Legacy `%20` segments still decode correctly.

## Configuration

Uses standard Directus storage environment variables — no extension-specific env vars:

```bash
STORAGE_LOCATIONS="local,s3"
STORAGE_LOCAL_DRIVER="local"
STORAGE_LOCAL_ROOT="./uploads"
STORAGE_S3_DRIVER="s3"
STORAGE_S3_BUCKET="…"
# …plus the usual key / region / endpoint settings for your driver
```

Per-location Mirror settings are stored in **`directus_settings.storage_manager`** (JSON), editable from the overview (admin only).

## Installation

Requires **Directus 9.26+ through 12.x**. The extension must run in the Directus API process (not the sandbox). Admin-only module.

### npm

```bash
npm install directus-extension-storage-manager
```

Place the package in your Directus `extensions` folder (or install into a project that loads extensions from `node_modules`), then restart Directus.

### Marketplace

Search for **Storage Manager** in **Settings → Marketplace**. This bundle includes an API endpoint, so some environments only allow App extensions from the Marketplace — use the npm/manual install below if install is blocked.

### Manual installation

1. Install and build:

```bash
cd directus-extension-storage-manager
npm install
npm run build
```

2. Copy the built package into your Directus `extensions` folder (include `package.json` and the `dist` folder).

3. Restart Directus.

4. In the Data Studio:

   1. Open **Settings → Project Settings → Modules**
   2. Enable **Storage Manager**
   3. Open **Storage Manager** from the left bar

## Operator API (admin)

Base path: `/storage-manager`

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/storages` | List adapters + usage |
| `GET` | `/storages/:location/browse?path=` | Immediate physical folders |
| `GET` | `/storages/:location/folder-tree` | Nested physical tree |
| `POST` | `/storages/:location/folders` | Create folder (`name`, `parent_path`) |
| `PATCH` | `/storages/:location/folders` | Rename (`name`) and/or move (`parent_path`) |
| `DELETE` | `/storages/:location/folders` | Delete folders (`paths[]`, `mode: move\|delete`) |
| `POST` | `/storages/:location/move-files` | Relocate registered files on the same adapter |
| `POST` | `/storages/:location/place-file` | Nest a file under a path after upload |
| `GET` | `/storages/:location/orphans?path=` | Detect unknown objects (optional path scope) |
| `POST` | `/storages/:location/import-orphans` | Register orphans (reads image width/height) |
| `POST` | `/storages/:location/delete-orphans` | Delete orphans |
| `POST` | `/migrate/dry-run` | Count files/folders/conflicts without moving |
| `POST` | `/migrate` | Batch migrate (JSON result) |
| `POST` | `/migrate/stream` | SSE migrate progress |
| `POST` | `/materialize/dry-run` | Count materialize work |
| `POST` | `/materialize` | Materialize virtual folders onto storage |
| `POST` | `/materialize/stream` | SSE materialize progress |
| `GET` / `PATCH` | `/settings` | Read / merge settings |

**Move / migrate body (typical):** `target_storage`, `mode` (`move`; `copy` for the Flow operation), plus `file_ids` and/or `source_storage` (optional `source_path`, `preserve_paths`) and/or `folder_id` (optional `recursive`). Optional `target_path`, `source_folders`, `include_empty_folders`.

Same-adapter `move-files` skips a file when another registered row already owns the destination path.

## License

MIT
