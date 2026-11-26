"""Return the Sudachi tokens needed by the Milestone 1 benchmark."""

import json
import sys

from sudachipy import Dictionary, SplitMode


tokenizer = Dictionary().create()
lines = json.loads(sys.stdin.buffer.read().decode("utf-8"))
results = [
    [
        [m.surface(), m.dictionary_form(), m.part_of_speech()[0], m.is_oov(), m.begin(), m.end(), m.part_of_speech()[1]]
        for m in tokenizer.tokenize(line, SplitMode.C)
    ]
    for line in lines
]
sys.stdout.buffer.write(json.dumps(results, ensure_ascii=False).encode("utf-8"))
