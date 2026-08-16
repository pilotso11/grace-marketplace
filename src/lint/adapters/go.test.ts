import { describe, expect, test } from "bun:test";

import { getLanguageAdapter } from "./base";
import { createGoAdapter } from "./go";

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

  test("extracts exported top-level func/type/const/var declarations", () => {
    const result = adapter.analyze(
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
    const result = adapter.analyze(
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
    const result = adapter.analyze(
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
    const result = adapter.analyze(
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
    const result = adapter.analyze(
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
    const result = adapter.analyze(
      "example.go",
      `package example

type Stack[T any] struct{}

func Map[T, U any](items []T, fn func(T) U) []U { return nil }
`,
    );

    expect([...result.exports].sort()).toEqual(["Map", "Stack"]);
  });

  test("hasMainEntrypoint is true when package main and func main are both present", () => {
    const result = adapter.analyze(
      "main.go",
      `package main

func main() {}
`,
    );

    expect(result.hasMainEntrypoint).toBe(true);
  });

  test("hasMainEntrypoint is false when package is not main", () => {
    const result = adapter.analyze(
      "lib.go",
      `package lib

func main() {}
`,
    );

    expect(result.hasMainEntrypoint).toBe(false);
  });

  test("hasMainEntrypoint is false when package main has no top-level func main", () => {
    const result = adapter.analyze(
      "main.go",
      `package main

func Run() {}
`,
    );

    expect(result.hasMainEntrypoint).toBe(false);
  });

  test("usesTestFramework is true for _test.go filenames", () => {
    const result = adapter.analyze(
      "example_test.go",
      `package example

func TestSomething() {}
`,
    );

    expect(result.usesTestFramework).toBe(true);
  });

  test("usesTestFramework is true when the file imports \"testing\"", () => {
    const result = adapter.analyze(
      "helpers.go",
      `package example

import "testing"

func Helper(t *testing.T) {}
`,
    );

    expect(result.usesTestFramework).toBe(true);
  });

  test("usesTestFramework is false otherwise", () => {
    const result = adapter.analyze(
      "plain.go",
      `package example

func Plain() {}
`,
    );

    expect(result.usesTestFramework).toBe(false);
  });

  test("directReExportCount/hasDefaultExport/hasWildcardReExport are always the Go-appropriate constants", () => {
    const result = adapter.analyze("example.go", `package example\n\nfunc Start() {}\n`);

    expect(result.hasDefaultExport).toBe(false);
    expect(result.hasWildcardReExport).toBe(false);
    expect(result.directReExportCount).toBe(0);
  });
});

describe("getLanguageAdapter", () => {
  test("resolves .go files to the Go adapter", () => {
    const adapter = getLanguageAdapter("foo.go");
    expect(adapter?.id).toBe("go");
  });
});
