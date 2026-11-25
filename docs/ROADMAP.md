# Roadmap

## Implemented

- [x] Project-local Pi extension with isolated inference through the selected model.
- [x] Read-only Core 2000 import, foundational vocabulary, and Sudachi coverage.
- [x] Japanese generation, independent translation and review, bounded refills, and controlled vocabulary expansion.
- [x] Generation benchmark, focused translation and reviewer audits, debug reports, and regression tests.

## Current milestone

- [ ] Validate the current generation policy in live benchmarks. Require at least two of three trials to fill all ten slots and manually audit meaning, naturalness, and target fit.

## Planned, subject to approval

- [ ] Add a grammar catalog and deterministic study-session transitions.
- [ ] Build a typed Pi study flow with Japanese IME input, answer grading, hints, retries, cancellation, and a session summary.
- [ ] Add explicit interactive confirmation of unconfirmed vocabulary.
- [ ] Evaluate complete study sessions and grade accuracy against labeled learner answers.
- [ ] Evaluate a desktop interface that reuses the study core.
