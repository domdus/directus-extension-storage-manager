# Storage Manager

Browse, create, and migrate files and storage folders across your Directus adapters (local disk, S3, Google Cloud, Azure, and more) — without losing the file’s identity in Directus. Build folder structure yourself, or pick a smart folder strategy per storage.

> **Important:** This extension moves or copies the **actual files** between storage backends and updates where Directus looks for them. Prefer **Copy** when you try a new storage for the first time; use **Move** only when you are sure the new location is correct.

## Overview

<img alt="Storage overview with local, S3, and GCS adapters" src="https://raw.githubusercontent.com/domdus/directus-extension-storage-manager/main/docs/screenshot_storage_migration.png" width="800" />

Directus can use several storage locations at once, but it does not move existing files for you when you change storage. **Storage Manager** fills that gap: see what lives on each adapter, organise new uploads with per-storage folder strategies, browse physical folders on disk/bucket, upload files, find objects missing from Directus, and migrate selected files or whole folders between storages.

Files keep the same ID in Directus. Only their storage location (and optionally their path under that location) changes. Image thumbnails / transforms are moved or copied with them when possible.

## Features

### Overview & adapters

- See every configured storage location with file counts, folder counts, usage, and root / bucket
- Per-adapter **Storage Folder Strategy** with Save / Reset only when the draft differs from what’s saved
- Compact strategy rail (type/date configure via tune icon; no layout jump between cards)
- **Strategy Guide** in the sidebar (strategies + **Sync Folder Changes**)
- **Browse** opens that adapter’s files and folders

### Storage folder strategies

Choose how **new uploads** are placed under each storage adapter.

> A strategy applies from when you save it — only to new uploads. It does **not** reorganise files already on that storage.

| Strategy | What it does | Example `filename_disk` |
| --- | --- | --- |
| **None** | Directus default — flat path, no storage folder | `uuid.jpg` |
| **Mirror Folders by Name** | Mirrors the virtual folder tree using folder names | `Articles/Drafts/uuid.jpg` |
| **Mirror Folders by UID** | Same tree using folder IDs (stable when renamed) | `<parent-uuid>/<child-uuid>/uuid.jpg` |
| **Create by File Type** | Prefix from MIME category via a configurable type map | `images/uuid.jpg`, `videos/uuid.mp4` |
| **Create by Date** | Prefix from upload date (`yyyy/MM`, `yyyy/MM/dd`, or `yyyy`) | `2026/08/uuid.jpg` |

Type and date options open in a **Configure** dialog (tune icon on the overview card). Live one-line previews on the card (e.g. `Format: yyyy/MM → 2026/08`, `4 Type Mappings`, mirror path examples).

#### Mirror by Name — name collisions

Created siblings with the same name on the same hierarchy level use `name_<folder-uid>` for uniqueness and to prevent conflicts.

Example under parent `Articles`:

1. Create folder `Drafts` → uploads go to `Articles/Drafts/…`
2. Create another `Drafts` → uploads go to `Articles/Drafts_<folder-uid>/…`

The first folder to claim a plain name keeps it (sticky first-wins). Claims live in `directus_settings.storage_manager`.

#### Sync Folder Changes (mirror strategies)

Optional, configured **per storage** (overview **Configure** dialog or browse sidebar):

| Setting | Behaviour |
| --- | --- |
| **Sync Folder Changes** | When Directus virtual folders are renamed or deleted, update physical paths on **this** adapter only |
| **On Rename → Move Files** | Rewrite `filename_disk` and move objects (e.g. `Articles/Drafts/…` → `Articles/Published/…`). Can be expensive for large folders |
| **On Rename → Leave Files** | Leave existing objects where they are; new uploads use the new name |
| **On Delete → Move to Parent** | Relocate storage paths one level up (same idea as File Library moving content to the parent). Sync **never** deletes registered files |

A Directus folder is **virtual**: it can contain files from several adapters at once. Example: `Articles` has some files on `local` and some on `s3`. If both have Mirror + Sync enabled, a rename updates `local` and `s3` independently (each only its own objects). If only `local` has Sync on, `s3` paths stay unchanged.

UID mirror skips rename sync (IDs don’t change when a folder is renamed). Relocating many files logs a warning in the API (≥100 files).

### Left navigation

Order:

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
- **Upload** (header **+**, sidebar, empty states) opens a File Library–style **dropzone dialog** (drag/drop or click to browse) — not an immediate OS file picker
- Window-level drag-and-drop onto the page still works

### Physical storage folders

Manage real folders on disk / in the bucket (not only Directus virtual folders):

- **Create Storage Folder** — local `mkdir`, or a `.keep` marker on cloud adapters so empty folders survive
- Right-click context menu (nav + folder cards), File Library options except Download:
  - **Rename Folder** — rewrites nested registered files’ paths and moves objects on disk
  - **Move to Folder** — reparent under another storage path
  - **Delete Folder** — File Library–style dialog: move registered content one level up, or delete all content, then remove the folder
- **Move to Storage Folder** (header) — relocate **selected files** to any adapter + folder path (same-adapter path rewrite, or cross-adapter move)
- **Delete** (header) — selected files via core `/files` delete; when storage folders are selected, same Delete Folder dialog as above
- Upload / drop into a nested path places the file under that folder after create

Example: create `My Test Folder` on `local`, upload while browsing it → object lands under `My Test Folder/` on disk and in `filename_disk`.

### Readable URLs for paths with spaces

Disk and the database keep real spaces. Studio routes encode spaces as `_` and existing underscores as `__` so URLs stay readable and reversible.

| On disk / in DB | In the Studio URL |
| --- | --- |
| `My Test Folder` | `/storage-manager/storage/local/path/My_Test_Folder` |
| `already_underscored` | `…/already__underscored` |

Legacy `%20` segments still decode correctly.

### Migrate

<img alt="Migrate Files drawer — choose target storage and Move or Copy" src="https://raw.githubusercontent.com/domdus/directus-extension-storage-manager/main/docs/screenshot_storage_migration_files.png" width="800" />

- **Migrate Selected Folder(s)** — when physical storage folders are selected (contents)
- **Migrate** everything on a storage adapter (root, nothing selected)
- **Migrate This Folder** — current virtual Directus folder (Directus Folders view)
- **Move to Storage Folder** — selected files → any adapter + tree (also covers nested storage paths)
- **Move** — after a successful transfer, remove the file from the old storage
- **Copy** — leave a copy on the old storage (no longer linked in Directus; clean up or re-import with Detect)
- Live progress (SSE): from → to, current file, amount transferred, and speed
- Up to **5000** files per interactive migrate request

<img alt="Migrate progress from GCS to local storage" src="https://raw.githubusercontent.com/domdus/directus-extension-storage-manager/main/docs/screenshot_storage_migration_storage_gcs.png" width="800" />

### Thumbnails & transforms

Directus stores generated transforms at the **storage root** as `{stem}__{hash}.ext` (for example `uuid__7abd30….avif`).

- Migrate / move copies related transforms to the **target root** basename (where AssetsService expects them)
- Same-adapter folder rename / move keeps root transforms and cleans colocated orphans when needed
- **Detect** / orphan import / orphan delete skip generated thumbnails, dotfiles, and `directus-health-file`

### Detect files

- Scan for objects on disk / bucket that are **not** in Directus yet
- At storage root: **Detect Files on {adapter}**
- Inside a physical folder: **Detect Files in this Folder** (scan scoped to that path and subfolders)
- Import creates database rows only — files stay where they are
- Delete selected orphans permanently (thumbnails are never deleted via this path)

### Settings

- Module **Settings** page: **Export / Import** JSON backup of strategies, sync options, and name-mirror claims
- **Delete** stored `storage_manager` data from `directus_settings` (field is recreated empty on next start if the extension is still installed)

### Automation

- **Storage Manager** Flow operation — copy or move files in automations (same engine as the UI: file IDs, source storage, and/or folder + recursive)

## Getting started

1. Configure more than one storage location if you plan to migrate (for example `local` and `s3`).
2. As an admin, open **Settings → Project Settings → Modules** and enable **Storage Manager**.
3. Open **Storage Manager** from the left bar.
4. On the overview, pick a **Storage Folder Strategy** per adapter if you want organised paths, then **Save**.
5. **Browse** a storage (or **Directus Folders**) and work with files / physical folders.
6. Select files and/or folders, or migrate the whole adapter / current folder; choose a **target storage**, then **Move** or **Copy**.

Tips:

- Test with **Copy** first, then switch to **Move** once you are happy with the result.
- After a **Copy**, leftovers on the old storage can show up under **Detect** — that is expected.
- Cloud storages often cannot report a full disk quota; the UI then shows Directus file totals only.
- Prefer **Mirror Folders by UID** if folder renames must not change storage paths; use **by Name** when human-readable paths matter.
- Strategies do not rewrite existing files — use **Migrate** or **Sync Folder Changes** when you need path updates.
- Virtual folders can span multiple storages; Sync is always per-adapter (see Sync section above).

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

Per-location strategies and sync options are stored in **`directus_settings.storage_manager`** (JSON), editable from the overview and storage sidebars (admin only).

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
| `POST` | `/storages/:location/import-orphans` | Register orphans |
| `POST` | `/storages/:location/delete-orphans` | Delete orphans |
| `POST` | `/migrate` | Batch migrate (JSON result) |
| `POST` | `/migrate/stream` | SSE migrate progress |
| `GET` / `PATCH` | `/settings` | Read / merge settings |

**Migrate body (typical):** `target_storage`, `mode` (`copy` \| `move`), plus `file_ids` and/or `source_storage` (optional `source_path`) and/or `folder_id` (optional `recursive`).

## License

MIT
