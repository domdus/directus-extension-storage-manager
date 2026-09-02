# Storage Manager

Move files between your Directus storages — local disk, S3, Google Cloud, Azure, and more — without losing the file in Directus. The file keeps the same ID. Only where it lives changes.

> Before a large move, click **Dry Run**. That shows what would happen without moving anything. Studio always **moves** files (it does not leave a copy behind). Copy exists only as a Flow operation.

## Overview

![Storage Manager overview with local, local2, S3, and GCS adapters](https://raw.githubusercontent.com/domdus/directus-extension-storage-manager/main/docs/screenshot_storage_manager.png)

Directus can use several storages at once, but it will not move existing files for you. Storage Manager does: browse each storage, upload, find files that are on disk but not in Directus, move files or whole folders, find File Library entries that nothing uses anymore, and optionally quarantine deletes in a Recycle Bin before permanent removal.

When you open a storage from the overview, the left sidebar shows that storage’s folder tree. Folders load as you expand them, so large storages stay quick to navigate. The right sidebar has dedicated panels for the page you are on: **Materialize** in Directus Folders, **Detect** (and **Move** at the storage root) when browsing a storage, and **Restore** inside Recycle.

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

When you upload through Storage Manager while browsing a specific storage, files go to that storage. Mirror then keeps new uploads in step with your Directus folders on that same storage.

### File field interfaces

Storage Manager adds three interfaces for file fields. Each one works like the built-in File, Files, or Image interface, but uploads go to the **storage adapter and folder you set on the field**.


| Interface              | Use for                                         |
| ---------------------- | ----------------------------------------------- |
| **File with Storage**  | Single file (M2O)                               |
| **Files with Storage** | Multiple files (M2M)                            |
| **Image with Storage** | Single image (M2O), image MIME types by default |


When you configure the field, set **Folder** and **Storage Location** (for example `local` or `s3`). Every upload from that field uses those settings. If **Mirror Directus Folders** is on for that storage, new files follow your Directus folder tree on disk.

You can also set **On Deselect** and **On Item Delete** on each field, or leave them on **Use File Interfaces default** so they follow the **File Interfaces** page (see below).

### Thumbnails

At the **top level** of a storage (not inside a subfolder), a **Thumbnails** panel appears in the right sidebar.

Directus often creates extra image files when it resizes or converts pictures for the website. Those files usually live at the storage root and do not show up as normal entries in the File Library. Storage Manager lets you work with them separately:

- **Show Files** — your usual file list (the way you browse today)
- **Show Thumbnails** — only those generated resize/preview files, using the same cards/table layouts and pagination as the File Library

You can search by filename in the thumbnails view. To free up space, use **Delete All Transforms**. That removes the generated copies only — your original uploads stay safe. Directus will recreate those copies the next time an image is requested. A confirmation step tells you how many files would be removed before anything is deleted.

### Move to Storage Folder

Pick files, folders, or everything on a storage, then choose where they should go.

- **Dry Run** first: how many files, folders, and possible conflicts
- Selected folders keep their name (`hello` stays `hello`). If that folder already exists at the destination, contents are merged into it
- Loose files land in the folder you pick
- Moving a whole storage keeps the folder structure
- Empty folders can be included when you move a storage or selected folders

![Move Files progress from local to S3](https://raw.githubusercontent.com/domdus/directus-extension-storage-manager/main/docs/screenshot_storage_move_to_gcs.png)

If the destination already has a **folder** with that name, files are merged into it. If another Directus file already uses that exact path, the incoming file is skipped and stays where it is. Image thumbnails move with the file when possible.

### Materialize

In **Directus Folders**, turn your Directus folder tree into real folders on storage:

- **Keep** — each file stays on its current storage. Only the folder path is created there. You can also build folders without moving files.
- **Merge** — all files move onto one storage, in the same folder layout as Directus.

Include subfolders if you want the whole tree. Dry Run shows counts before you run it. Directus Folders themselves are not changed.

![Materialize Folder drawer with Keep and Merge storage modes](https://raw.githubusercontent.com/domdus/directus-extension-storage-manager/main/docs/screenshot_storage_materialize.png)

### Detect files

The file list in a storage folder is the **File Library** — files Directus already knows about. A folder can look empty even when objects still sit on disk or in the cloud (for example after a database restore, a failed delete, or files uploaded outside Directus).

Use **Detect** in the right sidebar:

- At the storage root: **Detect Files on {storage}**
- Inside a folder: **Detect Files in this Folder**

That lists files on storage that are not registered yet. **Import** creates File Library rows without copying anything. Titles come from the filename (underscores become spaces). You can also **delete** selected leftovers from storage. Generated thumbnails are left alone (use **Thumbnails → Delete All Transforms** at the storage root).

If you try to delete a storage folder and it comes back or is skipped, open Detect first. Delete Folder only relocates or removes files that are already in Directus.

### Delete storage folders

When you delete a folder on a storage:

- **Move content one level up** — registered files go to the parent folder
- **Delete all content** — registered files are removed for good

Recycle Bin files under that path stay put, and the folder is not removed until they are restored or purged. Files that exist only on storage must be imported or deleted with Detect first. Empty cloud folders (GCS/S3 placeholders and `.keep` markers) are removed once nothing real is left.

### Unreferenced Files

Open **Unreferenced Files** from the left sidebar to find File Library items that nothing in your project still uses — leftovers after content was deleted, images that were replaced, or uploads that never got attached.

![Unreferenced Files scan options, summary, and results](https://raw.githubusercontent.com/domdus/directus-extension-storage-manager/main/docs/screenshot_storage_unreferenced_files.png)

Set your scan options, then click **Scan**:

- **Min Age** — skip files that were uploaded very recently (so mid-upload or draft files are not flagged yet)
- **Storage Filter** — limit the search to one storage, or check all
- **Scan Text Fields** — also look inside rich text, Markdown, JSON, code, multiline, list, tags, and text columns for file links. This can take longer on large sites; turn it off for a faster check of file/image fields only

After a scan you get a short summary and a list of matches (same cards/table layouts as elsewhere in Storage Manager, including storage location badges). Select files and choose what to do:

- **Move to Recycle** — when Recycle Bin is on, quarantine selected files instead of deleting immediately (primary action)
- **Move to Directus Folder** — organize them in the File Library (virtual folders only)
- **Move to Storage Folder** — relocate them on disk / cloud storage
- **Delete Permanently** — remove them if they are still unused (each file is checked again before delete)

### Recycle Bin

Open **Recycle Bin** from the left sidebar for an opt-in File Library quarantine. Isolation is the point: files stay registered, but `/assets` returns 404 (no thumbnails in collections or Studio), and they cannot be found in file interfaces, search, or the picker unless you open the recycle folder on purpose. If still-used content was quarantined, the gap shows up immediately — move the file out of Recycle to restore access.

![Recycle Bin status, retention, purge actions, and scheduled purge Flow](https://raw.githubusercontent.com/domdus/directus-extension-storage-manager/main/docs/screenshot_storage_recycle_bin.png)

Turn **On** to create `storage_manager_trashed_at` on `directus_files` and a recycle folder (default **`_Recycle`** — you can pick another File Library folder while Off). Unreferenced Files can move selections here. You can also **Move to Recycle** from a storage or Directus Folders browse when files or folders are selected.

On each storage browse page, Recycle files for that adapter appear in a virtual folder of the same name (objects stay at their original keys). From there you can restore selected files, or use **Restore All**. Restore always returns files to the File Library root — storage keys do not move.

While On you can:

- Set **Retention (days)** — how long files stay before they are purge candidates
- **Dry Run Purge** / **Purge Expired** — permanently delete files older than retention after re-checking that they are still unreferenced
- **Restore All** — sidebar action on Recycle Bin and on each storage’s virtual `_Recycle` folder. Restores every quarantined file (or every Recycle file on that storage) to the File Library root, with progress, cancel, and background for large bins
- **Scheduled Purge** — optionally create a daily Schedule Flow (`0 3 * * *`) that runs **Purge Recycle Bin**. Turning Recycle Bin off pauses a linked Flow; you can open or remove the Flow from this page

Source of truth is the folder id. Renaming the folder in the File Library is fine.

### File Interfaces

Open **File Interfaces** from the left sidebar to set what happens when a file field is cleared, or when the collection item that holds the file is deleted.

![File Interfaces lifecycle defaults for Native Directus and Storage Manager](https://raw.githubusercontent.com/domdus/directus-extension-storage-manager/main/docs/screenshot_storage_file_interfaces.png)

Defaults are split into two groups:

- **Native Directus Interfaces** — File / Image / Files. Cleanup runs on save (or when the item is deleted) via hooks. There is no Ask prompt in Studio for native fields.
- **Storage Manager Interfaces** — File / Image / Files with Storage. Deselect can run immediately in the form. **Ask** shows a Studio dialog so editors can choose deselect only, or delete the file if nothing else still uses it.

For each group you can choose:

| Setting | Options |
| ------- | ------- |
| **On deselect** | Keep file in library · Move to Recycle Bin if unreferenced · Ask (Storage Manager only) · Delete file if unreferenced |
| **On item delete** | Keep file in library · Move to Recycle Bin if unreferenced · Delete file if unreferenced |

**Move to Recycle Bin** only runs when Recycle Bin is On and the file is still unused elsewhere; otherwise the file is kept. Storage Manager fields can override these defaults per field in Data Model (including **Use File Interfaces default**). Delete / recycle only run when nothing else still references the file.

### Settings

Check for updates, export or import your Mirror settings, or **Remove Extension Data** before uninstall. Cleanup clears `directus_settings.storage_manager`, deletes the scheduled purge Flow (if any), and removes the **Unreferenced File Scans** snapshot folder. Recycle Bin files are left alone unless you opt in to empty them.

### Flows

The **Storage Manager** Flow operation can move (or copy) **selected file IDs** in automations. Pick the target storage from a dropdown of configured locations, optionally assign files to a Directus File Library folder after a successful migrate, and pass an explicit `file_ids` array (for example from a trigger or previous step). It does not migrate an entire storage or folder at once. Copy leaves a leftover on the old storage — it will show up under Detect.

**Scan Unreferenced Files** is a separate Flow operation that runs the same dry-run scan as the module (optional storage filter, min age, text-field scan). It returns `file_ids` (capped list), `unreferenced_count`, `unreferenced_bytes`, and full `meta` so you can chain into migrate or your own follow-up steps. It does not delete anything.

**Purge Recycle Bin** permanently deletes expired Recycle Bin files (still-unreferenced only). Retention comes from Recycle Bin settings unless you override **Older Than (Days)**. Use **Dry Run** to count candidates. The Recycle Bin page can install a daily Schedule Flow that runs this operation.

## Getting started

1. Set up more than one storage if you plan to move files (for example `local` and `s3`).
2. As an admin, go to **Settings → Project Settings → Modules** and enable **Storage Manager**.
3. Open **Storage Manager** from the left bar.
4. On the overview, turn on **Mirror Directus Folders** for any storage that should follow your Directus folders.
5. Browse a storage (or **Directus Folders**) and move or materialize as needed.
6. At a storage root, open **Thumbnails** in the sidebar if you need to inspect or clear generated image copies.
7. For collection fields that must land on a specific storage, use **File with Storage**, **Files with Storage**, or **Image with Storage** instead of the native file interfaces.
8. Use **File Interfaces** to set default cleanup behaviour when editors clear a file field or delete an item (works for native file fields too).
9. Use **Unreferenced Files** when you want to find leftover File Library entries, then move them to Recycle, relocate, or delete permanently.
10. Turn on **Recycle Bin** if you want a quarantine step before permanent delete, and optionally create **Scheduled Purge**. Use **Restore All** (or restore selected files) to put them back at the File Library root.
11. If a storage folder looks empty, open **Detect** — files may still exist on storage that Directus does not know about.
12. Use **Dry Run**, then **Move**.

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