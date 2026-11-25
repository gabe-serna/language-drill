# Language Drill

Language Drill is an Anki companion for practicing Japanese sentence production. The current Windows Pi extension benchmarks the generation of Japanese reference sentences and their English prompts. The [roadmap](docs/ROADMAP.md) tracks the interactive study experience.

## Setup on Windows

1. Install Pi and configure a model available in Pi. Use Node.js 26 for the test commands below.
2. For full benchmarks, open Anki with AnkiConnect running and a compatible Core 2000 deck. See the [architecture](docs/ARCHITECTURE.md) for the required fields and card eligibility.
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
| `/study-benchmark` | Run three exercise-generation trials with Anki and Sudachi. |
| `/study-benchmark translator` | Audit the model's translations of fixed Japanese sentences. |
| `/study-benchmark validator` | Compare the reviewer's decisions against labeled pairs. |

The focused modes can run with Anki closed. Append `--debug` to any mode to inspect full inference inputs and raw model responses in the results editor. Press Escape to close the report. Use `/reload` after changing extension code in an existing Pi session.

## Tests

From the project root with the Python environment above installed, run the regression suite. It uses synthetic fixtures, mocked model replies, and the local Sudachi analyzer.

```powershell
node --test .pi/extensions/study-benchmark/generation.test.ts .pi/extensions/study-benchmark/vocabulary.test.ts
```
