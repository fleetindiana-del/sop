# SOP identifier formats: stored vs internal keys

- **Stored / displayed** identifiers use two-digit doc index and revision: `QAGE01-01`.
  Persist via `canonicalSopIdentifier()`; render via `displaySopCode()` (`lib/sop-display.ts`).
- **Internal match keys** stay unpadded and must not change format: `normalizeSopIdentifierKey()`
  (`QAGE1-1`), `sops.sopBaseId` (`QAGE1`, used by LMS exact matches), `mcqgenjobs.identifier`.
- Never query identifiers with an exact `^id$` regex or equality — use
  `sopIdentifierEquivalentRegex()` (same version, any padding) or `sopIdentifierMatchFilter()`.
- Legacy rows are normalized by `scripts/normalize-sop-version-digits.ts` (dry run by default,
  `--apply` writes a backup to `backups/`, `--revert <file>` restores).
