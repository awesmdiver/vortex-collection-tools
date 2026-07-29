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

### Pick the voice register yourself — the user shouldn't have to tell you each time

The skill has two registers, and choosing between them is part of the job, not something to wait to be
told:

- **Casual / friendly (the default)** — the large majority of user-facing text: tool intros, buttons,
  labels, hints, success messages, empty states, launcher and report copy.
- **Serious / friendly-technical** — anything genuinely consequential *in this app specifically*: any
  step that writes to Vortex's live database (Create Backup, Apply Ignores, Apply Disables, Rules
  Generator's Apply to Vortex, a rebuild), any destructive or hard-to-reverse action, any "Vortex must
  be closed first" blocker, security warnings, and the message right before or reporting the result of
  any of those. Casual markers (exclamation points, "feel free to," breezy asides) never belong here.

When it's ambiguous which applies, lean serious. Match the icon to severity the same way — 🛑 for a
hard blocker (the action is actually refused), ⚠️ for proceed-with-caution (see the skill's "Icon
usage by severity"). Don't ship copy in the wrong register and make the user ask for a redo — that's
the exact repetition this standing order exists to remove.

### Surface judgment calls, don't silently decide

When a change involves a genuine judgment call (a reword that's arguably clearer but not obviously
wrong as-is, a possible redundancy, which register applies, a small UX trade-off), flag it up front —
show the current text, your proposed change, and why — rather than baking in a preference the user
didn't ask for. Clear-cut fixes (typos, stale claims, plain jargon swaps) can just be applied.

If a genuinely new UI pattern is needed (nothing existing in `DESIGN.md`/`web/public/styles.css`
covers it), add it to `DESIGN.md` in the same change so it becomes the shared convention for next
time, rather than a one-off.

## End every task by writing a handoff file

At the end of any task or work session, write a concise wrap-up to `prompts/handoff-latest.md`
(overwrite it each time — it's an ephemeral scratchpad, not a log, and it's gitignored, so don't
commit it). This is how the **design-side session** — a second Claude working in the desktop app on
this same filesystem — picks up your results without the user copy-pasting terminal output back and
forth (which truncates and loses things). It must be self-contained; write it for someone who did not
watch the run. Include:

- **What changed / what you did** — the outcome, not a play-by-play.
- **Findings** — anything you discovered that affects the design or the next steps.
- **Judgment calls** — decisions you made on your own, and why.
- **Open questions / needs a decision** — anything the user or the design side should weigh in on.

Keep durable engineering detail in `TECHNICAL.md` as usual; the handoff file is the short "here's the
result, here's what I need" summary that points at the deeper records.
