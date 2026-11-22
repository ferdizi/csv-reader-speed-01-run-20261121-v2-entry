# csv-reader v2 — Read broken CSV files faster

A faster drop-in for csv-reader 1.0.0 (make.fun bounty
`csv-reader-speed-01-run-20261121`): `solve.js` answers every case exactly
as csv-reader does, and `main.ts` runs it on `/input/cases.json`, writing
`/output/answers.json`.

## Design

- **Streaming JSON emitter.** The parser writes the answer's JSON text
  directly while parsing — no answer object graph is built and
  `JSON.stringify` is never called on it. That removes the stringify
  round-trip, about a third of v1's cost.
- **Single-pass parser** (`solve.js`, dependency-free ES module). One
  left-to-right scan with a tight `charCodeAt` loop; a fast path for
  unquoted fields (~85%), lazy field materialisation (start/end indexes,
  one slice per field), a reusable scratchpad for quoted fields that
  need rewriting (`""` → `"`, CRLF/lone CR inside quotes → LF), no
  regex in the hot loop, and stable monomorphic shapes.
- **Two entry points, one logic.** `runToJson(input)` emits the JSON
  text; `run(input)` is `JSON.parse` of the same text, so both agree by
  construction. `main.ts` uses the streaming path.
- **Semantics.** Exactly csv-reader's: BOM dropped, records end at
  LF/CRLF, empty lines are no record, stray CR outside quotes is dropped
  (`stray_cr`), quoted fields run to the next non-doubled quote with
  junk appended (`quote_junk`), a never-closing quote is literal and
  the text after it is re-read as unquoted (`unterminated_quote`),
  rows are padded/cut to the first record's width (`short_row` /
  `long_row`). Errors are `{code, line, row}` in encounter order, with
  `line` the record's start line.

## Verification (practice set, this box)

- `check.mjs`: **6/6 cases identical, byte-equal** to
  `JSON.stringify(expected)` (11,621,516 output bytes).
- Fuzz vs the reference oracle: **100,186 random edge-case inputs, 0
  mismatches** (value-identical and byte-identical emitter output).
- Cold benchmark (fresh `node` per round, interleaved with v1,
  20 rounds): v2 median **1,118 ms** vs v1 median **1,183 ms**
  (~5.5% faster); warm parse+emit ~195 ms/set vs v1's
  parse+stringify ~610 ms/set. Server v1 CPU is 1,330,000 µs.

## Run

```sh
node --no-incremental-marking main.ts
# reads $MAKEFUN_INPUT_DIR/cases.json (default /input),
# writes $MAKEFUN_OUTPUT_DIR/answers.json (default /output)
```

## Files

- `solve.js` — the parser + emitter (`run`, `runToJson`)
- `main.ts` — the driver the harness runs
- `package.json` — `{"type": "module"}`
- `LICENSE` — MIT (`SPDX-License-Identifier: MIT`)
- `.makefun/owner.json` — payout-wallet claim file
