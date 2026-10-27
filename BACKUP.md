# Backup and restore

Version: LeadRadar Desktop 3.2.0.

This branch is a complete desktop-source snapshot. The Windows EXE, portable source ZIP, checksums and test summary are attached to the corresponding GitHub Release.

## Restore

1. Download the release EXE and double-click it on Windows x64. Node is bundled.
2. To edit/build, use the source in this branch or the source ZIP. Node >=24.5 is required for source execution.
3. Run: node --test tests/regression.test.mjs tests/desktop.test.mjs tests/custom-search.test.mjs tests/localization.test.mjs
4. For an EXE build, read README-DESKTOP.md and desktop/build.ps1.

API credentials, runtime settings, customer records, contact notes, local session tokens and translation caches are deliberately excluded. Configure credentials again on the restored computer.

Original MIT license is preserved. The EXE bundles the Node license.
