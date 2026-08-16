# Go Language Adapter (heuristic) — Design

Tracks: [pilotso11/grace-marketplace#3](https://github.com/pilotso11/grace-marketplace/issues/3)

## Problem

`.go` is in `CODE_EXTENSIONS` but not in `ADAPTER_BACKED_EXTENSIONS`, and no adapter
exists in `LANGUAGE_ADAPTERS`. `getLanguageAdapter` returns `null` for every Go file,
so `validateMapParity` never runs on Go — MODULE_MAP drift on Go files is invisible.

## Scope

This PR ships a **heuristic-only** adapter: a regex scan over top-level `func`, `type`,
`const`, `var` declarations, with `exportConfidence: "heuristic"` always. No Go toolchain
dependency, no `go/ast` parsing.

An exact `go/ast`-backed adapter (mirroring how `python.ts`/`dart.ts` shell out to their
runtime) is an intentional fast-follow, not part of this PR. The issue is explicit about
why: turning this on exact-first converts every currently-invisible Go file straight into
a blocking `error`-severity `markup.module-map-mismatch`. Heuristic-first reports
`analysis.heuristic-map-mismatch` as a `warning`, so an existing Go codebase's first run
surfaces drift without breaking the build.

## Adapter contract

New file: `src/lint/adapters/go.ts`, exporting `createGoAdapter(): LanguageAdapter`,
following the same shape as `typescript.ts`/`python.ts`/`dart.ts`:

```ts
export function createGoAdapter(): LanguageAdapter {
  return {
    id: "go",
    supports(filePath) {
      return path.extname(filePath) === ".go";
    },
    analyze(filePath, text) {
      // pure regex scan of `text`, no subprocess
    },
  };
}
```

Unlike Python/Dart, `analyze` does no `spawnSync` — this is plain TypeScript, no
`LanguageRuntimeMissingError` path, no runtime dependency at all.

### What the regex scan does

Scan top-level (column-0, not indented — Go has no nested top-level declarations)
lines for:

- `func Name(` — function declaration. Skip if it has a receiver: `func (r *Runner) Start(`
  matches `func (` first, not `func Name(`, so the receiver form is naturally excluded
  by requiring the identifier to immediately follow `func `.
- `type Name` — covers `type Name struct`, `type Name interface`, `type Name = Alias`,
  and generic `type Name[T any] struct` (capture stops at the identifier, before `[`).
- `const Name` / `const (` block — block form requires scanning subsequent lines until
  the matching `)`.
- `var Name` / `var (` block — same block handling as `const`.

An identifier is exported iff its first rune is uppercase (`/^[A-Z]/`), which is the
whole of Go's export rule — no keyword list, no annotations, unlike TS/Python.

**Methods are excluded from both `exports` and `localSymbols`.** They belong to their
receiver type, which is already represented in the map as the type's own declaration.
This matches every existing adapter, which is file-scoped and tracks only top-level
bindings — Go methods aren't top-level bindings.

### LanguageAnalysis fields

| Field | Value |
|---|---|
| `exports` / `localSymbols` | same set — Go has no separate "explicit export list" like Python's `__all__`, so both are the exported (or all, for LOCALS) top-level names |
| `valueExports` | same as `exports` (Go has no type-only export concept at this heuristic level) |
| `typeExports` | empty set |
| `exportConfidence` | always `"heuristic"` |
| `hasDefaultExport` | always `false` (no such concept in Go) |
| `hasWildcardReExport` | always `false` (no such concept in Go) |
| `hasMainEntrypoint` | `true` iff `package main` and a top-level `func main(` are both present |
| `directReExportCount` | always `0` |
| `localExportCount` | count of exported top-level names |
| `localImplementationCount` | count of all top-level declarations, exported or not |
| `usesTestFramework` | `true` iff the filename ends in `_test.go` or the file imports `"testing"` |

Note: only `exports`, `localSymbols`, and `exportConfidence` are actually read by
`validateMapParity` today (confirmed by grep — the other fields aren't consumed
anywhere in `project-utils.ts` yet). They're populated for contract completeness and
because a future rule may start reading them, not because anything branches on them now.

### Edge cases explicitly handled

- **Generics**: `type Stack[T any] struct` and `func Map[T, U any](...)` — capture group
  stops at the identifier, before `[`, so the type parameter list doesn't corrupt the name.
- **Embedded struct fields**: irrelevant to this adapter — it only scans top-level
  declaration lines, not struct body contents.
- **`_test.go` files**: `inferRole` already assigns these `TEST` role elsewhere; the
  adapter itself doesn't special-case the role, only sets `usesTestFramework`.
- **Build-tag-gated files** (`//go:build ...`): out of scope. The regex scans whatever
  text it's given; conditional compilation isn't modeled. Same limitation the heuristic
  Dart adapter already has for conditional imports.

## Registration

`src/language-registry.ts`:
- Add `import { createGoAdapter } from "./lint/adapters/go";`
- Add `".go"` to `ADAPTER_BACKED_EXTENSIONS`
- Add `createGoAdapter()` to `LANGUAGE_ADAPTERS`

## Testing

New `src/lint/adapters/go.test.ts`, Bun test, following `python.test.ts`/`dart.test.ts`
conventions (`describe`/`test`, no subprocess mocking needed since there's no subprocess).
Cases: `supports()` extension check; plain func/type/const/var exports; unexported
(lowercase) names excluded; methods excluded even when the receiver type is exported;
`const`/`var` block forms; generic type/func names; `hasMainEntrypoint` true/false;
`usesTestFramework` via filename and via import.

Also add a fixture-level check (or extend an existing one, if `typescript.test.ts` /
`dart.test.ts` has a "registered in LANGUAGE_ADAPTERS" style test) confirming
`getLanguageAdapter("foo.go")` resolves to the Go adapter.

## Non-goals (explicitly out of scope, per the issue)

- `go/ast` exact backend — fast-follow PR.
- Fixing `markup.role-map-mode-mismatch` on Go files (`#2`, already merged into this
  branch as PR #2's RUNTIME/LOCALS widening — separate concern from map *verification*).
- Package-scoped (cross-file) export resolution — matches existing adapters' file-scoped
  design.

## Branching / PR strategy

Current branch `vendor/zai-reviewer-v4` already contains PR #1
(`fix/non-js-log-marker-evidence` → `upstream/go-log-marker-evidence`) and PR #2
(`fix/role-allows-multiple-map-modes`) as ancestors. The new work branches from this
HEAD, so it's stacked on both:

```
git checkout -b feat/go-language-adapter vendor/zai-reviewer-v4
```

PR opened against `pilotso11/grace-marketplace:main` (fork staging, per the existing
PR #1/#2 pattern — "staged on our fork for review before offering upstream"), noting in
the PR body that it depends on #1 and #2 landing first, or reviewing only the delta if
they're still open. Once accepted on the fork, it's the candidate to offer upstream to
`osovv/grace-marketplace`.
