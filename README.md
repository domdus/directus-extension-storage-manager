# Storage Manager

Move files between your Directus storages — local disk, S3, Google Cloud, Azure, and more — without losing the file in Directus. The file keeps the same ID. Only where it lives changes.

> Before a large move, click **Dry Run**. That shows what would happen without moving anything. Studio always **moves** files (it does not leave a copy behind). Copy exists only as a Flow operation.

## Overview

<img alt="Storage Manager overview with local, local2, S3, and GCS adapters" src="https://raw.githubusercontent.com/domdus/directus-extension-storage-manager/main/docs/screenshot_storage_manager.png" width="800" />

Directus can use several storages at once, but it will not move existing files for you. Storage Manager does: browse each storage, upload, find files that are on disk but not in Directus, and move files or whole folders.

### Your storages

The overview shows every storage with file counts, folder counts, and usage. **Browse** opens that storage’s files and folders.

Cloud storages often cannot report a full disk quota. In that case the bar shows the size Directus already knows about.

### Mirror Directus Folders

Turn this on for a storage if you want that storage to follow your Directus folder tree:

- New uploads go into matching folders on that storage
- Renaming or deleting a Directus folder updates folders **on this storage only**

A Directus folder is only a label in Directus. Files inside it can sit on different storages. If `Articles` has files on `local` and on `s3`, and Mirror is on for both, a rename updates both. If Mirror is only on for `local`, the `s3` files stay put.

Mirror does not rearrange files that are already stored. Use **Move to Storage Folder** or **Materialize** for those.

If two Directus folders share the same name, the second one gets a unique folder name on disk so they do not collide.

### Move to Storage Folder

Pick files, folders, or everything on a storage, then choose where they should go.

- **Dry Run** first: how many files, folders, and possible conflicts
- Selected folders keep their name (`hello` stays `hello`). If that folder already exists at the destination, contents are merged into it
- Loose files land in the folder you pick
- Moving a whole storage keeps the folder structure
- Empty folders can be included when you move a storage or selected folders

<img alt="Move Files progress from local to S3" src="https://raw.githubusercontent.com/domdus/directus-extension-storage-manager/main/docs/screenshot_storage_move_to_gcs.png" width="800" />

If the destination already has a **folder** with that name, files are merged into it. If another Directus file already uses that exact path, the incoming file is skipped and stays where it is. Image thumbnails move with the file when possible.

### Materialize

In **Directus Folders**, turn your Directus folder tree into real folders on storage:

- **Keep** — each file stays on its current storage. Only the folder path is created there. You can also build folders without moving files.
- **Merge** — all files move onto one storage, in the same folder layout as Directus.

Include subfolders if you want the whole tree. Dry Run shows counts before you run it. Directus Folders themselves are not changed.

<img alt="Materialize Folder drawer with Keep and Merge storage modes" src="https://raw.githubusercontent.com/domdus/directus-extension-storage-manager/main/docs/screenshot_storage_materialize.png" width="800" />

### Detect files

Find files that are on a storage but not yet in Directus.

- At the storage root: **Detect Files on {storage}**
- Inside a folder: **Detect Files in this Folder**

Import adds them to Directus without moving the files. You can also delete leftover files that Directus does not know about (generated thumbnails are left alone).

### Settings

Check for updates, export or import your Mirror settings, or remove Storage Manager’s saved settings if you uninstall.

### Flows

The **Storage Manager** Flow operation can move (or copy) files in automations. Copy leaves a leftover on the old storage — it will show up under Detect.

## Getting started

1. Set up more than one storage if you plan to move files (for example `local` and `s3`).
2. As an admin, go to **Settings → Project Settings → Modules** and enable **Storage Manager**.
3. Open **Storage Manager** from the left bar.
4. On the overview, turn on **Mirror Directus Folders** for any storage that should follow your Directus folders.
5. Browse a storage (or **Directus Folders**) and move or materialize as needed.
6. Use **Dry Run**, then **Move**.

## Installation

Requires **Directus 9.26+ through 12.x**. Admins only. The extension must run in the Directus API process (not the sandbox).

### Marketplace

Search for **Storage Manager** in **Settings → Marketplace**. If install is blocked (this bundle includes an API), use npm or the manual steps below.

### npm

```bash
npm install directus-extension-storage-manager
```

Put the package in your Directus `extensions` folder (or install it in a project that loads extensions from `node_modules`), then restart Directus.

### Manual installation

```bash
cd directus-extension-storage-manager
npm install
npm run build
```

Copy the built package into your Directus `extensions` folder (`package.json` and the `dist` folder), restart Directus, then enable **Storage Manager** under **Settings → Project Settings → Modules**.

## License

MIT
