import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";

import { getLanguageAdapter } from "./base";
import { analyzeGoHeuristic, createGoAdapter } from "./go";

const hasGo = (() => {
  const result = spawnSync("go", ["version"], { stdio: "ignore" });
  return !result.error && result.status === 0;
})();

describe("GoAdapter.supports", () => {
  const adapter = createGoAdapter();

  test("returns true for .go files", () => {
    expect(adapter.supports("main.go")).toBe(true);
    expect(adapter.supports("/path/to/lib.go")).toBe(true);
    expect(adapter.supports("src/utils.go")).toBe(true);
  });

  test("returns false for non-Go files", () => {
    expect(adapter.supports("main.ts")).toBe(false);
    expect(adapter.supports("module.py")).toBe(false);
    expect(adapter.supports("lib.dart")).toBe(false);
  });
});

describe("GoAdapter", () => {
  const adapter = createGoAdapter();

  test("has adapter ID 'go'", () => {
    expect(adapter.id).toBe("go");
  });
});

// These exercise the regex-based heuristic scan directly (rather than through
// createGoAdapter().analyze()) so the assertions hold regardless of whether
// `go` is on PATH in the environment running the suite — see the "exact
// backend" and "fallback" describes below for adapter.analyze() dispatch
// behavior, which does depend on `go` availability.
describe("GoAdapter heuristic scan (analyzeGoHeuristic)", () => {
  test("extracts exported top-level func/type/const/var declarations", () => {
    const result = analyzeGoHeuristic(
      "example.go",
      `package example

func Start() {}

type Runner struct{}

const MaxRetries = 3

var DefaultTimeout = 5
`,
    );

    expect([...result.exports].sort()).toEqual(["DefaultTimeout", "MaxRetries", "Runner", "Start"]);
    expect([...result.localSymbols].sort()).toEqual(["DefaultTimeout", "MaxRetries", "Runner", "Start"]);
    expect(result.exportConfidence).toBe("heuristic");
    expect([...result.valueExports].sort()).toEqual(["DefaultTimeout", "MaxRetries", "Runner", "Start"]);
    expect(result.typeExports.size).toBe(0);
  });

  test("excludes unexported (lowercase) names from exports but keeps them in localSymbols", () => {
    const result = analyzeGoHeuristic(
      "example.go",
      `package example

func start() {}

type runner struct{}

const maxRetries = 3

var defaultTimeout = 5
`,
    );

    expect(result.exports.size).toBe(0);
    expect([...result.localSymbols].sort()).toEqual(["defaultTimeout", "maxRetries", "runner", "start"]);
  });

  test("excludes methods from both exports and localSymbols, even on an exported receiver type", () => {
    const result = analyzeGoHeuristic(
      "example.go",
      `package example

type Runner struct{}

func (r *Runner) Start() {}

func (r Runner) Stop() {}
`,
    );

    expect([...result.exports]).toEqual(["Runner"]);
    expect([...result.localSymbols]).toEqual(["Runner"]);
    expect(result.exports.has("Start")).toBe(false);
    expect(result.exports.has("Stop")).toBe(false);
  });

  test("handles const block form", () => {
    const result = analyzeGoHeuristic(
      "example.go",
      `package example

const (
	Alpha = iota
	Beta
	gamma
)
`,
    );

    expect([...result.exports].sort()).toEqual(["Alpha", "Beta"]);
    expect([...result.localSymbols].sort()).toEqual(["Alpha", "Beta", "gamma"]);
  });

  test("handles var block form", () => {
    const result = analyzeGoHeuristic(
      "example.go",
      `package example

var (
	Host = "localhost"
	port = 8080
)
`,
    );

    expect([...result.exports].sort()).toEqual(["Host"]);
    expect([...result.localSymbols].sort()).toEqual(["Host", "port"]);
  });

  test("parses generic type and func names, stopping the capture before '['", () => {
    const result = analyzeGoHeuristic(
      "example.go",
      `package example

type Stack[T any] struct{}

func Map[T, U any](items []T, fn func(T) U) []U { return nil }
`,
    );

    expect([...result.exports].sort()).toEqual(["Map", "Stack"]);
  });

  test("hasMainEntrypoint is true when package main and func main are both present", () => {
    const result = analyzeGoHeuristic(
      "main.go",
      `package main

func main() {}
`,
    );

    expect(result.hasMainEntrypoint).toBe(true);
  });

  test("hasMainEntrypoint is false when package is not main", () => {
    const result = analyzeGoHeuristic(
      "lib.go",
      `package lib

func main() {}
`,
    );

    expect(result.hasMainEntrypoint).toBe(false);
  });

  test("hasMainEntrypoint is false when package main has no top-level func main", () => {
    const result = analyzeGoHeuristic(
      "main.go",
      `package main

func Run() {}
`,
    );

    expect(result.hasMainEntrypoint).toBe(false);
  });

  test("usesTestFramework is true for _test.go filenames", () => {
    const result = analyzeGoHeuristic(
      "example_test.go",
      `package example

func TestSomething() {}
`,
    );

    expect(result.usesTestFramework).toBe(true);
  });

  test("usesTestFramework is true when the file imports \"testing\"", () => {
    const result = analyzeGoHeuristic(
      "helpers.go",
      `package example

import "testing"

func Helper(t *testing.T) {}
`,
    );

    expect(result.usesTestFramework).toBe(true);
  });

  test("usesTestFramework is false otherwise", () => {
    const result = analyzeGoHeuristic(
      "plain.go",
      `package example

func Plain() {}
`,
    );

    expect(result.usesTestFramework).toBe(false);
  });

  test("directReExportCount/hasDefaultExport/hasWildcardReExport are always the Go-appropriate constants", () => {
    const result = analyzeGoHeuristic("example.go", `package example\n\nfunc Start() {}\n`);

    expect(result.hasDefaultExport).toBe(false);
    expect(result.hasWildcardReExport).toBe(false);
    expect(result.directReExportCount).toBe(0);
  });

  // Known heuristic gaps, characterized by the go/ast evaluation below:
  test("KNOWN GAP: misses grouped `type ( ... )` block declarations entirely", () => {
    const result = analyzeGoHeuristic(
      "example.go",
      `package example

type (
	A struct{}
	B int
	c string
)
`,
    );

    expect(result.exports.size).toBe(0);
    expect(result.localSymbols.size).toBe(0);
  });

  test("KNOWN GAP: only captures the first name on a multi-value const/var line", () => {
    const result = analyzeGoHeuristic(
      "example.go",
      `package example

const (
	Alpha, Beta = iota, iota + 1
)

var X, Y = 1, 2
`,
    );

    expect([...result.exports].sort()).toEqual(["Alpha", "X"]);
    expect(result.exports.has("Beta")).toBe(false);
    expect(result.exports.has("Y")).toBe(false);
  });
});

// Exercises createGoAdapter().analyze() against `go run` + go/parser/go/ast,
// confirming exportConfidence: "exact" and that it fixes the heuristic gaps
// documented above. Skipped when `go` isn't on PATH.
describe("GoAdapter exact backend (go/ast)", () => {
  const adapter = createGoAdapter();

  test.skipIf(!hasGo)("sets exportConfidence to 'exact' when go is on PATH", () => {
    const result = adapter.analyze("example.go", `package example\n\nfunc Start() {}\n`);
    expect(result.exportConfidence).toBe("exact");
  });

  test.skipIf(!hasGo)("handles multi-line function signatures", () => {
    const result = adapter.analyze(
      "example.go",
      `package example

func Configure(
	name string,
	timeout int,
	retries int,
) error {
	return nil
}
`,
    );

    expect([...result.exports]).toEqual(["Configure"]);
  });

  test.skipIf(!hasGo)("handles generics with multi-line type parameter lists and complex constraints", () => {
    const result = adapter.analyze(
      "example.go",
      `package example

type Container[T comparable, U any] struct {
	items map[T]U
}

func Map[
	T any,
	U any,
](items []T, fn func(T) U) []U {
	return nil
}
`,
    );

    expect([...result.exports].sort()).toEqual(["Container", "Map"]);
  });

  test.skipIf(!hasGo)("FIX for heuristic gap: extracts all members of a grouped `type ( ... )` block", () => {
    const result = adapter.analyze(
      "example.go",
      `package example

type (
	A struct{}
	B int
	c string
)
`,
    );

    expect([...result.exports].sort()).toEqual(["A", "B"]);
    expect([...result.localSymbols].sort()).toEqual(["A", "B", "c"]);
  });

  test.skipIf(!hasGo)("FIX for heuristic gap: extracts every name on a multi-value const/var line", () => {
    const result = adapter.analyze(
      "example.go",
      `package example

const (
	Alpha, Beta = iota, iota + 1
)

var X, Y = 1, 2
`,
    );

    expect([...result.exports].sort()).toEqual(["Alpha", "Beta", "X", "Y"]);
  });

  test.skipIf(!hasGo)("excludes methods (including on generic receivers) from exports/localSymbols", () => {
    const result = adapter.analyze(
      "example.go",
      `package example

type Runner[T any] struct{}

func (r *Runner[T]) Start() {}
`,
    );

    expect([...result.exports]).toEqual(["Runner"]);
    expect(result.exports.has("Start")).toBe(false);
  });

  test.skipIf(!hasGo)("still parses the file body of a build-tag-gated file (ParseFile doesn't evaluate build constraints)", () => {
    const result = adapter.analyze(
      "linux_only.go",
      `//go:build linux
// +build linux

package example

func LinuxOnly() {}
`,
    );

    expect([...result.exports]).toEqual(["LinuxOnly"]);
  });

  test.skipIf(!hasGo)("embedded struct fields and embedded interfaces are extracted as top-level type names only", () => {
    const result = adapter.analyze(
      "example.go",
      `package example

type Base struct {
	ID int
}

type Derived struct {
	Base
	Name string
}

type Reader interface {
	Read() string
}

type ReadWriter interface {
	Reader
	Write(string)
}
`,
    );

    expect([...result.exports].sort()).toEqual(["Base", "Derived", "ReadWriter", "Reader"]);
  });
});

describe("GoAdapter fallback when go is unavailable", () => {
  test("falls back to the heuristic scan (exportConfidence: 'heuristic') when the go binary can't be found", () => {
    const adapter = createGoAdapter();
    const source = `package example

func Start() {}

type Runner struct{}

const MaxRetries = 3

var DefaultTimeout = 5
`;

    // Point the analyzer cache at a fresh, empty temp dir. Without this, a
    // binary cached by an earlier "exact backend" test in this suite (same
    // embedded script, same content hash) would already exist on disk and
    // get used directly — the whole point of the cache — even with PATH
    // cleared, since a cache hit no longer needs `go` on PATH at all. This
    // scoped override keeps the test's simulated "go missing" scenario
    // genuine: no cache entry can exist yet, so it must hit ENOENT.
    const scopedCacheDir = mkdtempSync(path.join(os.tmpdir(), "grace-go-analyzer-cache-test-"));
    const previousCacheDir = process.env.GRACE_GO_ANALYZER_CACHE_DIR;
    const previousPath = process.env.PATH;
    process.env.GRACE_GO_ANALYZER_CACHE_DIR = scopedCacheDir;
    process.env.PATH = "";
    let result;
    try {
      result = adapter.analyze("example.go", source);
    } finally {
      process.env.PATH = previousPath;
      if (previousCacheDir === undefined) {
        delete process.env.GRACE_GO_ANALYZER_CACHE_DIR;
      } else {
        process.env.GRACE_GO_ANALYZER_CACHE_DIR = previousCacheDir;
      }
      rmSync(scopedCacheDir, { recursive: true, force: true });
    }

    const expected = analyzeGoHeuristic("example.go", source);
    expect(result.exportConfidence).toBe("heuristic");
    expect([...result.exports].sort()).toEqual([...expected.exports].sort());
    expect([...result.localSymbols].sort()).toEqual([...expected.localSymbols].sort());
  });
});

describe("getLanguageAdapter", () => {
  test("resolves .go files to the Go adapter", () => {
    const adapter = getLanguageAdapter("foo.go");
    expect(adapter?.id).toBe("go");
  });
});
