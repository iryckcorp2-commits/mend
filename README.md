# mend

[![make.fun bounty](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![make.fun rank](https://make.fun/badge/iryckcorp2-commits/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![make.fun reward](https://make.fun/badge/iryckcorp2-commits/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

`mend` is one patch tool for every AI edit format. It reads a patch written
by an AI model and applies it to a tree of text files, all or nothing: either
every edit lands, or no file is written at all.

It understands four formats:

- **unified diffs**, even when the line numbers in them are wrong;
- **SEARCH/REPLACE blocks**;
- **V4A patches** (`*** Begin Patch` ... `*** End Patch`);
- **JSON tool-call edits** (one array, or one object per line).

Matching is forgiving where the formats allow it: an old block is found at
the first of three tiers (exact, trailing whitespace ignored, both sides
trimmed), with tier-2 re-indentation of the replacement. Strict mode
(`--strict`) matches exactly. `--check` reports what would change without
writing anything.

## Usage

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

`PATCH` is a patch file, or `-` (or nothing) to read the patch from standard
input. `--format` picks one format (`unified`, `search-replace`, `v4a`,
`json`); the default `auto` detects it.

Exit code `0` lists what changed (`A`/`D`/`M`/`R` lines, then `ok: n file(s)`).
Exit code `1` lists each failed edit (`error: <code> <path>`) and a
`failed: k of n edits` line. Exit code `2` is a usage, missing-patch, format
or parse error. See [SPEC.md](SPEC.md) for the full rules.

## Example

```sh
printf -- '--- notes.txt\n+++ notes.txt\n@@ -1,2 +1,2 @@\n buy milk\n-buy eggs\n+buy bread\n' > fix.patch
node main.ts fix.patch
```

Node 22, standard library only, no dependencies.
