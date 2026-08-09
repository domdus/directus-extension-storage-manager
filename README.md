# Storage Manager

Browse, upload, and move files between your Directus storage locations (local disk, S3, Google Cloud, Azure, and more) — without losing the file’s identity in Directus.

Open **Storage** from the left bar (**admins only**).

> **Important:** This extension moves or copies the **actual files** between storage backends and updates where Directus looks for them. Prefer **Copy** when you try a new storage for the first time; use **Move** only when you are sure the new location is correct.

## Overview

Directus can use several storage locations at once, but it does not move existing files for you when you change storage. **Storage Manager** fills that gap: see what lives on each adapter, upload new files, find files on disk that are missing from Directus, and migrate selected files or whole folders between storages.

Files keep the same ID in Directus. Only their storage location changes. Image thumbnails are moved or copied with them when possible.

## Features

### Overview & adapters

- See every configured storage location with file counts and usage
- Open a location to browse its files (same card/table layouts as the File Library)
- Drag and drop (or use **Upload**) to add files straight onto that storage

### Folders

- Browse the same virtual folders as the File Library
- Migrate everything in a folder (optionally including subfolders), across any storage

### Migrate

- **Migrate selected** files, **all files on a storage**, or a **whole folder**
- **Move** — after a successful transfer, remove the file from the old storage
- **Copy** — leave a copy on the old storage (it will no longer be linked in Directus; you can clean it up or re-import with Detect)
- Live progress: from → to, current file, amount transferred, and speed

### Detect files

- Scan a storage for files that exist on disk/bucket but are **not** in Directus yet
- Import them into the library (creates database entries only — files stay where they are)
- Automatically skips Directus-generated image thumbnails

### Automation

- Use the **Storage Manager** Flow operation to copy or move files in automations

## Getting started

1. Make sure your project has more than one storage location configured (for example `local` and `s3`).
2. As an admin, open **Settings → Project Settings → Modules** and enable **Storage**.
3. Open **Storage** from the left bar.
4. Pick a storage card (or **Folders**) and browse files.
5. Select files (or migrate all on that storage / folder), choose a **target storage**, then **Move** or **Copy**.

Tips:

- Test with **Copy** first, then switch to **Move** once you are happy with the result.
- After a **Copy**, leftovers on the old storage can show up under **Detect files** — that is expected.
- Cloud storages often cannot report a full disk quota; the UI then shows Directus file totals only.

## Installation

Requires **Directus 9.26+ through 12.x**. The extension must run in the Directus API process (not the sandbox).

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
   2. Enable **Storage**
   3. Open **Storage** from the left bar

## License

MIT
