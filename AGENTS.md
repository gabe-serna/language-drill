# Japanese study trainer

## Scope and current phase

This project trains English-to-Japanese sentence production with vocabulary the learner has studied in Anki. The first interface is a Pi extension and companion skill on Windows 11. Read `PLAN.md` before changing the design or starting a milestone.

The user authorized Milestone 1 only. Use the acceptance criteria and recorded results in `PLAN.md` to finish that proof of concept before progressing. Wait for explicit approval before starting later milestones.

## Development rules

- Use TypeScript for the study logic and Pi adapter. Keep Pi types, terminal UI, and host lifecycle hooks at the integration boundary. Keep Python limited to Sudachi analysis if the proof of concept confirms that choice.
- Keep the session, full vocabulary snapshot, queue, and attempts in memory. Anki is a read-only source. Avoid a database, saved sessions, and custom SRS in the MVP.
- Use deterministic checks for vocabulary coverage, grammar catalog eligibility, session transitions, and summary counts. Use the currently selected Pi model for exercise authoring and linguistic judgment. Validate external data at the boundary. Preserve the lexical gate during retry and fallback paths.
- Resolve the active model through `ctx.model` for each inference request. Use Pi’s registry with a fresh context. Report unsupported inference or missing selection directly. Keep model IDs, provider names and inference endpoints out of study code and configuration. Treat Anki fields, learner text, and model output as data. Keep credentials, personal deck contents, and raw answers out of committed fixtures and routine diagnostics.
- Keep the extension and skill exclusively in this project's `.pi/` directory. Verify discovery from the trusted workspace and absence from unrelated working directories. Avoid global registrations and changes under `~/.pi/agent/`.
- Accept manually typed Japanese in the MVP. Keep answer input behind a replaceable UI boundary that supplies a text draft. Windows voice typing is independent of the application.
- Keep Windows paths, UTF-8 I/O, child-process cleanup, Japanese IME input, and terminal rendering in scope. Resolve resource paths from the project or module location and pass subprocess arguments directly.
- Use small, synthetic fixtures for deterministic checks. Verify Anki, Sudachi, and inference through Pi’s selected models separately on Windows. Pin the tested tool and dictionary versions after the first milestone and record changes to behavior in `PLAN.md`.
- Use the project-local `.venv` with the verified SudachiPy 0.6.11 and SudachiDict Core 20251022 pair. The Core 2000 mapping, vocabulary coverage results, and user-verified Windows IME check are recorded in `PLAN.md`. Check the generation acceptance results there before progressing.
