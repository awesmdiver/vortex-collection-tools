# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

Vortex Collection Tools — a locally-run toolkit for managing Vortex-installed Skyrim SE mod
collections (Rebuild Collection, Update Collection, Rules Generator, Reports, and a Utilities area:
Vortex Scrub, Missing Masters, Archive Finder). See [`README.md`](README.md) for the user-facing
overview and [`TECHNICAL.md`](TECHNICAL.md) for the full technical reference.

## Keep README.md's Key Features list in sync

**Whenever a new tool or Utilities feature ships, add a bullet to README.md's "Key Features" list
in the same change** — not deferred to a later doc pass. Match the existing bullets' voice and
shape exactly: bold verb-first lead-in + colon, then 1-2 plain-language sentences (pain point, then
what this tool does about it) — run it through the `plain-language-writer` skill like any other
user-facing text. If the new feature changes the app's actual elevator pitch (not just adds to the
list), also touch the "Overview" paragraph right above it — but the one-line tagline blockquote at
the very top is deliberately terse and names only the flagship features; don't dilute it by trying
to list everything there.

This drifted once already (2026-07-28): Vortex Scrub, Missing Masters, and Archive Finder all
shipped without a README update, and it sat stale for a full extra session before the user caught
it and asked for a catch-up pass. Don't let it happen again.

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
