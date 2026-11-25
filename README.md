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
| `/study drilling [--q N]` | Start directly with N questions (default 10). |
| `/study-benchmark` | Run three exercise-generation trials with Anki and Sudachi. |
| `/study-benchmark translator` | Audit the model's translations of fixed Japanese sentences. |
| `/study-benchmark validator` | Compare the reviewer's decisions against labeled pairs. |

The focused modes can run with Anki closed. Append `--debug` to any mode to inspect full inference inputs and raw model responses in the results editor. Press Escape to close the report. Use `/reload` after changing extension code in an existing Pi session.

For grading diagnostics run `/study drilling --q 2 --debug`. On exit the debug editor shows grading and breakdown prompts, raw visible responses, stop reasons, output budgets and errors.

## Tests

From the project root with the Python environment above installed, run the regression suite. It uses synthetic fixtures, mocked model replies, and the local Sudachi analyzer.

```powershell
node --test .pi/extensions/study-benchmark/*.test.ts
```

## Manual study checks on Windows

1. In Pi, run `/reload` and then `/study drilling --q 2`. Choose **Enter answer**, compose Japanese with the Windows IME, confirm the conversion, and press Enter to submit.
2. Submit an answer with a deliberate meaning or tense error. Check the verdict and specific feedback. Choose **Edit and submit** and verify the original English prompt and previous draft. Try a valid alternative translation. The completion screen appears after a correct grade, three evaluated attempts, or **Give up**.
3. In a fresh drill, press Escape during grading. Verify that the draft and remaining attempts are preserved. Retry, then select **Give up** and check the accented reference. Press E twice to show and hide its breakdown. Choose **Continue** to advance or **Exit** to return to Pi. Start another drill to verify cleanup.
