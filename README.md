# Storage Manager

Move files between your Directus storages — local disk, S3, Google Cloud, Azure, and more — without losing the file in Directus. The file keeps the same ID. Only where it lives changes.

> Before a large move, click **Dry Run**. That shows what would happen without moving anything. Studio always **moves** files (it does not leave a copy behind). Copy exists only as a Flow operation.

## Overview

![Storage Manager overview with local, local2, S3, and GCS adapters](https://raw.githubusercontent.com/domdus/directus-extension-storage-manager/main/docs/screenshot_storage_manager.png)

Directus can use several storages at once, but it will not move existing files for you. Storage Manager does: browse each storage, upload, find files that are on disk but not in Directus, move files or whole folders, and find File Library entries that nothing uses anymore.

When you open a storage from the overview, the left sidebar shows that storage’s folder tree. Folders load as you expand them, so large storages stay quick to navigate.

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

Find files that are on a storage but not yet in Directus.

- At the storage root: **Detect Files on {storage}**
- Inside a folder: **Detect Files in this Folder**

Import adds them to Directus without moving the files. You can also delete leftover files that Directus does not know about. Generated resize/preview files are left alone (use **Thumbnails → Delete All Transforms** at the storage root if you want to clear those).

### Unreferenced Files

Open **Unreferenced Files** from the left sidebar to find File Library items that nothing in your project still uses — leftovers after content was deleted, images that were replaced, or uploads that never got attached.

![Unreferenced Files scan options, summary, and results](https://raw.githubusercontent.com/domdus/directus-extension-storage-manager/main/docs/screenshot_storage_unreferenced_files.png)

Set your scan options, then click **Scan**:

- **Min Age** — skip files that were uploaded very recently (so mid-upload or draft files are not flagged yet)
- **Storage Filter** — limit the search to one storage, or check all
- **Scan WYSIWYG / JSON Fields** — also look inside rich text and similar content for file links. This can take longer on large sites; turn it off for a faster check of file/image fields only

After a scan you get a short summary and a list of matches (same cards/table layouts as elsewhere in Storage Manager). Select files and choose what to do:

- **Move to Directus Folder** — organize them in the File Library (virtual folders only)
- **Move to Storage Folder** — relocate them on disk / cloud storage
- **Delete** — remove them if they are still unused (each file is checked again before delete)

In the right sidebar, **File Lifecycle** sets defaults for the Storage Manager file field interfaces: what should happen when someone clears a file from a field, or when a whole item is deleted (`keep`, `ask`, or delete the file if nothing else uses it).

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
6. At a storage root, open **Thumbnails** in the sidebar if you need to inspect or clear generated image copies.
7. For collection fields that must land on a specific storage, use **File with Storage**, **Files with Storage**, or **Image with Storage** instead of the native file interfaces.
8. Use **Unreferenced Files** when you want to find leftover File Library entries, then move or delete them.
9. Use **Dry Run**, then **Move**.

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