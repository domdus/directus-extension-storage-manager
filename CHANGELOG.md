# Changelog

All notable changes to this project are documented in this file.

## [1.3.0] - 2026-08-26

### Added

- **File with Storage**, **Files with Storage**, and **Image with Storage** interfaces — field-default folder and storage adapter for uploads (no runtime storage picker).
- **Storage Location** field-option interface — dropdown of configured adapters in Data Model.
- **Thumbnails** sidebar at storage root — **Show Files** / **Show Transforms** (Archive-style radio UI) and **Delete All Transforms** with dry-run confirmation.
- Transforms list view and `/root-transforms` API for disk-only generated image copies at the storage root.
- Lazy-loaded storage folder tree in the left navigation.
- Upload mirror hook — new file uploads respect Mirror Directus Folders when enabled for the target storage.

### Fixed

- Storage root file grid no longer applies a broken `filename_disk` filter that hid all files (SQL `LIKE` treats `_` as a wildcard).

### Changed

- README documents file field interfaces, Thumbnails, and lazy navigation.

## [1.2.8] - 2026-08-25

See git tag `v1.2.8` for prior release notes.
