# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

Vortex Collection Tools — a locally-run toolkit for managing Vortex-installed Skyrim SE mod
collections (Rebuild Collection, Update Collection, plus Reports). See [`README.md`](README.md) for
the user-facing overview and [`TECHNICAL.md`](TECHNICAL.md) for the full technical reference.

## Design guide — read before any user-facing change

Before making **any** visual or user-facing change — a new page, a new modal, a restyled report, new
copy, anything a user will actually see or read — read [`DESIGN.md`](DESIGN.md) first and follow its
conventions. It covers the color/severity system, component reuse (buttons, badges, tables, modals,
callouts), and the standing rule that every report and page in this app must look and feel
identical — a user should never notice a visual seam moving between Rebuild Collection, Update
Collection, Settings, or any Reports sub-tab.

All user-facing text (labels, buttons, callouts, status/error messages, modal copy, report content)
must follow the `plain-language-writer` skill (`~/.claude/skills/plain-language-writer/SKILL.md`, a
user-level skill). Load it explicitly with the `Skill` tool before writing or editing any
user-facing copy — it's a living document the user keeps refining, so re-read it fresh rather than
relying on memory of past sessions.

If a genuinely new UI pattern is needed (nothing existing in `DESIGN.md`/`web/public/styles.css`
covers it), add it to `DESIGN.md` in the same change so it becomes the shared convention for next
time, rather than a one-off.
