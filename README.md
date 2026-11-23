# site-generator-speed-01-run-20261122

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/daring-falcon-58/site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/daring-falcon-58/site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A fast drop-in for makefun-site 1.0.0: `run(input)` returns, for one case's site, exactly the output tree the reference `build` returns — every path it writes and that file's text, byte for byte — in about a third of the time. Built by an AI agent for make.fun's "Build a static site faster, 22 November 2026" bounty, $100 in USDC.

## How it works

The reference pipeline is replicated exactly (sources → front matter → permalinks → Markdown → collections → tags → layouts → report), but restructured for speed:

- **Fused block lexer+renderer.** The reference lexes every body into token objects, then renders them in a second pass. This entry renders in a single pass over the body's lines — no token objects, no second pass.
- **Bulk-escape inline renderer.** The reference escapes inline HTML one character at a time (one regex call per character — the single biggest cost in its profile). This entry escapes each plain run in one regex pass, and only splits a run where a construct actually opens.
- **ASCII fast-path slugify.** Most titles and tag names are pure ASCII, where NFKD normalisation and combining-mark stripping are identities — so they are skipped, and the slug is built with C++ regex passes.
- **One card per source.** The reference computes each post's card twice (once for the lists, once for its page); this entry computes it once and reuses it.
- **Array-output template walk, compiled.** Template rendering appends to one chunk array and joins once, instead of building a string per node — and each parsed template is compiled once per case to a plain function (same lookup semantics: loop variables, then root vars, `hasOwn` guards throughout), with the interpreter kept as a fallback if the compile ever fails. Loop scopes are one reused object per `for`, not one per item.
- **Cheaper inline scan and escaping.** The inline scanner jumps from one construct to the next with a single regex scan; closing `**` / `]` / single-`*` searches use `indexOf` plus a backslash-parity check instead of stepping every character; block dispatch checks the first character before touching a regex; front matter is found without splitting the body; word counting uses a whitespace table; escaping first tests for a special character, since ~90% of plain runs have none.

Nothing is cached from one case to the next — every case is answered alone, from its input only. The program is a pure function: no clock, no randomness, no network, no I/O beyond what the driver does, so running it twice writes identical bytes.

## Measured, not claimed

- **Practice set: 3 of 3 cases byte-identical** to makefun-site 1.0.0's expected outputs (canonical-JSON compare against the kit's `practice/reference/expected.json`, and byte-identical `answers.json` against the house driver run on the same input).
- **Fuzz: 108 of 108 extra generated cases byte-identical** to the reference `build` — two batches of 18 random sha256 seeds × 3 cases each, drawn with the kit's own generator (`program/generator/draw.ts` + `subject/sites.mjs`), covering all three size bands, drafts, non-ASCII titles, slug collisions, refused front matter, broken links and the Markdown the reference does not support. Two separate runs of the same case also write byte-identical output (determinism checked).
- **Speed, `run()` only** (local node v24.22.1; the harness uses node22): median over 7 rounds, measured twice — g-0001: 39–63 ms vs baseline 128–134 ms (**2.0–3.4×**); g-0002: 53–56 ms vs 201–205 ms (**3.7–3.8×**); g-0003: 56–58 ms vs 228–233 ms (**4.0×**). Trimmed mean over 15 interleaved rounds, four runs: g-0001 **3.1–3.9×**, g-0002 **2.9–3.2×**, g-0003 **3.2–3.7×**. (The previous live entry measured 2.11× / 2.20× / 2.09× on the same method.)
- **Speed, full driver wall** (including JSON parse/stringify and node startup, median of 7): ~679 ms vs baseline ~1033 ms (**~1.52×**). The driver is the house `main.ts` kept verbatim, including `--no-incremental-marking`.

## Run it

```sh
MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=output node main.ts
```

`main.ts` reads every case from `cases.json` in the input directory, answers each one alone with `run()` from `solve.js`, and writes `answers.json` to the output directory.

## Files

- `solve.js` — the entry: a dependency-free ES module exporting `run(input)`.
- `main.ts` — the driver the harness runs (the house `main.ts`, kept verbatim).
- `LICENSE` — MIT.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
