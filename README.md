# Language Drill

Language Drill is an Anki companion for practicing Japanese sentence production. The Windows Pi extension presents English prompts, accepts typed Japanese, and grades each submission using your selected Pi model. The [roadmap](docs/ROADMAP.md) tracks the interactive study experience.

## Setup on Windows

1. Install Pi and configure a model available in Pi. Use Node.js 26 for the test commands below.
2. For study sessions and full benchmarks, open Anki with AnkiConnect running and a compatible Core 2000 deck. See the [architecture](docs/ARCHITECTURE.md) for the required fields and card eligibility.
3. From the project root in PowerShell, create the local Python environment and launch Pi.

```powershell
py -m venv .venv
.\.venv\Scripts\python.exe -m pip install SudachiPy==0.6.11 sudachidict_core==20251022
pi.cmd --approve --no-session
```

Use `/model` in Pi to select the model for the run.

## Commands

| Pi command | Purpose |
| --- | --- |
| `/study` | Load vocabulary and open the study menu. |
| `/study drilling [--q N] [--difficulty easy\|medium\|hard] [--recent]` | Start directly with N questions (default 10). |
| `/study-benchmark` | Run three exercise-generation trials with Anki and Sudachi. |
| `/study-benchmark translator` | Audit the model's translations of fixed Japanese sentences. |
| `/study-benchmark validator` | Compare the reviewer's decisions against labeled pairs. |

The focused modes can run with Anki closed. Append `--debug` to any mode to inspect full inference inputs and raw model responses in the results editor. Press Escape to close the report. Use `/reload` after changing extension code in an existing Pi session.

For grading diagnostics run `/study drilling --q 2 --debug`. On exit the debug editor shows grading and breakdown prompts, raw visible responses, stop reasons, output budgets and errors.

## Difficulty and reviewed vocabulary

Drills mix easy, medium, and hard questions in a 50/30/20 split by default. Use `/study drilling --q 20 --difficulty hard` to practice one tier. Add `--recent` to favor recently reviewed vocabulary while keeping older words in the pool.

Review the proposed grammar entries in [grammar.json](data/grammar.json). Everyday predicates, polite past, polite requests, core particles and modifiers are enabled. Other proposed constructions can be reviewed individually. The file also controls the difficulty split and recency weighting.

Run `/study-benchmark easy`, `medium`, `hard`, or `mixed` in Pi, with optional `--recent` and `--debug`. The bare benchmark runs the original polite-past checks. Check the requested and accepted counts, grammar coverage and rejection reasons, sampled vocabulary use, and representative pairs in the report.

## Tests

From the project root with the Python environment above installed, run the regression suite. It runs directly under Node without launching Pi, connecting to Anki or starting VOICEVOX. It uses synthetic fixtures, mocked providers, and the local Sudachi analyzer. See the [architecture](docs/ARCHITECTURE.md) for standalone entry points and provider contracts.

```powershell
node --test tests/*.test.ts
```

## Manual study checks on Windows

1. In Pi, run `/reload` and then `/study drilling --q 2`. Choose **Enter answer**, compose Japanese with the Windows IME, confirm the conversion, and press Enter to submit.
2. Submit an answer with a deliberate meaning or tense error. Check the verdict and specific feedback. Choose **Edit and submit** and verify the original English prompt and previous draft. Try a valid alternative translation. The completion screen appears after a correct or partially correct grade, three incorrect grades, or **Give up**.
3. In a fresh drill, press Escape during grading. Verify that the draft and remaining attempts are preserved. Retry, then select **Give up** and check the accented reference. Press E twice to show and hide its breakdown. Choose **Continue** to advance or **Exit** to return to Pi. Start another drill to verify cleanup.

## Reference audio on Windows

Start VOICEVOX before the drill. Edit [voicevox.json](data/voicevox.json) before starting a session. Set `enabled` to enable audio, `apiAddress` to the engine URL, `speed` to a positive speaking rate (default 0.8), and `autoPlay` to control playback on reveal. A null `speakerId` selects Kurono Takehiro's normal style by name. Use a numeric style ID to override it.

Run `/reload` and start a drill. Check that the question and retry screens stay silent. After a correct or partially correct answer, give-up, or exhausted attempts, listen for the Japanese reference and press P twice to restart it. Continue or exit mid-sentence and confirm the sound stops. Repeat with automatic playback off to check manual replay, and with VOICEVOX closed to check silent study.

## Learning assistance checks

1. Run `/study-benchmark mixed` and inspect the final distribution of forms and sentence types alongside the actual pairs. Counts are surface estimates and form categories can overlap.
2. In `/study drilling --q 3`, show and hide a hint. Check particles and endings, the attempt count, and IME editing. Submit an alternative to the hinted structure. On reveal check the English beneath the reference and toggle E.
3. With VOICEVOX running, alternate P and L rapidly, then continue during replay. Check normal and slow speed, single playback, and silent navigation with the engine stopped.
4. On an expanded exercise, inspect the reading and gloss after reveal. Use N or S to dismiss it. Choose Y only for a word you want saved. Check the summary and restart to verify persistence. Give up on another question and exit early to check partial-session totals.
