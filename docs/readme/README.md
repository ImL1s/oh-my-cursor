# oh-my-cursor README translations

<p align="center">
  <img src="../../assets/omcu-character.png" alt="oh-my-cursor character" width="300">
</p>


English | [简体中文](./README.zh.md) | [繁體中文](./README.zh-TW.md)

Localized copies of the repository README and selected docs. **English is canonical** for behavior, CLI flags, and release truth.

## README index

| Language | File |
| --- | --- |
| English | [../../README.md](../../README.md) |
| 简体中文 | [README.zh.md](./README.zh.md) |
| 繁體中文 | [README.zh-TW.md](./README.zh-TW.md) |

## Translated docs

| Topic | English | 简体中文 | 繁體中文 |
| --- | --- | --- | --- |
| Installation and lifecycle | [installation.md](../installation.md) | [installation.zh.md](../installation.zh.md) | [installation.zh-TW.md](../installation.zh-TW.md) |
| CLI reference | [cli.md](../cli.md) | [cli.zh.md](../cli.zh.md) | [cli.zh-TW.md](../cli.zh-TW.md) |
| Architecture | [architecture.md](../architecture.md) | [architecture.zh.md](../architecture.zh.md) | [architecture.zh-TW.md](../architecture.zh-TW.md) |
| Cursor integration | [cursor-integration.md](../cursor-integration.md) | [cursor-integration.zh.md](../cursor-integration.zh.md) | [cursor-integration.zh-TW.md](../cursor-integration.zh-TW.md) |
| Session recovery | [recovery.md](../recovery.md) | [recovery.zh.md](../recovery.zh.md) | [recovery.zh-TW.md](../recovery.zh-TW.md) |
| Release process | [releasing.md](../releasing.md) | [releasing.zh.md](../releasing.zh.md) | [releasing.zh-TW.md](../releasing.zh-TW.md) |
| Live verification | [live-verification.md](../live-verification.md) | — (English only) | — (English only) |

## Maintenance rules

1. **English first.** Update the English source, then mirror the change in every locale twin that exists for that page.
2. **Keep identifiers literal:** `omcu`, `cursor-agent`, `.omcu/`, `@iml1s/oh-my-cursor`, script paths, JSON keys, and CLI subcommands stay untranslated.
3. **Relative links from `docs/readme/`:** `../../` for repository root assets (`README.md`, `LICENSE`, `CHANGELOG.md`); `../` for other `docs/` pages.
4. **Relative links from `docs/*.zh*.md`:** same-directory twins use `./`; English siblings use the basename without a locale suffix (for example `./installation.md`).
5. **Language switcher on every page:** top line — `English | 简体中文 | 繁體中文` with working relative targets. Pages without twins link English only and note that translations are not available yet.
6. **Do not edit plan files** under `.omc/` or other orchestration plans when doing locale-only work.
7. **Examples must stay runnable:** command blocks copy verbatim from English unless the surrounding prose is translated.
8. **Capability honesty:** do not strengthen claims in translation; host limits and `verified: false` boundaries match English.
9. **PR checklist for locale changes:** English diff, each touched twin, switcher links checked from both `docs/` and `docs/readme/` paths, and `npm run check` when behavior docs changed.

Contributors: see [Locale / translations](../../CONTRIBUTING.md#locale--translations) in `CONTRIBUTING.md`.
