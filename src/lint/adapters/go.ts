import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { LanguageAdapter, LanguageAnalysis } from "../types";

const GO_EXTENSIONS = new Set([".go"]);
const GO_BINARIES = ["go"];

// Top-level func declaration. Requiring the identifier to immediately follow
// `func ` naturally excludes methods, whose receiver form is `func (r *Runner) Start(`
// — that matches `func (`, not `func Name(`.
const FUNC_RE = /^func\s+([A-Za-z_][A-Za-z0-9_]*)/;
// `type Name`, `type Name struct`, `type Name interface`, `type Name = Alias`,
// and generic `type Name[T any] struct` — the capture stops before `[`.
const TYPE_RE = /^type\s+([A-Za-z_][A-Za-z0-9_]*)/;
const CONST_SINGLE_RE = /^const\s+([A-Za-z_][A-Za-z0-9_]*)/;
const CONST_BLOCK_RE = /^const\s*\(/;
const VAR_SINGLE_RE = /^var\s+([A-Za-z_][A-Za-z0-9_]*)/;
const VAR_BLOCK_RE = /^var\s*\(/;
const BLOCK_MEMBER_RE = /^([A-Za-z_][A-Za-z0-9_]*)/;
const PACKAGE_MAIN_RE = /^package\s+main\b/;
const MAIN_FUNC_RE = /^func\s+main\s*\(/;
const TESTING_IMPORT_RE = /"testing"/;

function isExported(name: string): boolean {
  return /^[A-Z]/.test(name);
}

function scanBlock(lines: string[], startIndex: number, onMember: (name: string) => void): number {
  let index = startIndex + 1;
  while (index < lines.length) {
    const line = lines[index]!.trim();
    if (line.startsWith(")")) {
      return index;
    }
    const match = BLOCK_MEMBER_RE.exec(line);
    if (match) {
      onMember(match[1]!);
    }
    index += 1;
  }
  return index;
}

function createEmptyAnalysis(): LanguageAnalysis {
  return {
    adapterId: "go",
    exports: new Set<string>(),
    valueExports: new Set<string>(),
    typeExports: new Set<string>(),
    localSymbols: new Set<string>(),
    exportConfidence: "heuristic",
    hasDefaultExport: false,
    hasWildcardReExport: false,
    hasMainEntrypoint: false,
    directReExportCount: 0,
    localExportCount: 0,
    localImplementationCount: 0,
    usesTestFramework: false,
  };
}

/**
 * Regex-based heuristic scan over top-level declarations. This is the
 * always-available floor: no toolchain dependency, used both as the
 * fallback when `go` isn't on PATH and as the exported-for-testing
 * comparison baseline against the exact go/ast backend.
 */
export function analyzeGoHeuristic(filePath: string, text: string): LanguageAnalysis {
  const analysis = createEmptyAnalysis();
  analysis.exportConfidence = "heuristic";

  const addDeclaration = (name: string) => {
    analysis.localSymbols.add(name);
    if (isExported(name)) {
      analysis.exports.add(name);
      analysis.valueExports.add(name);
    }
    analysis.localImplementationCount += 1;
  };

  let isPackageMain = false;
  let hasMainFunc = false;
  let importsTesting = false;

  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i]!;
    const line = rawLine.trimEnd();

    if (PACKAGE_MAIN_RE.test(line.trim())) {
      isPackageMain = true;
    }

    if (TESTING_IMPORT_RE.test(line)) {
      importsTesting = true;
    }

    // Column-0 (not indented) top-level declarations only — Go has no
    // nested top-level declarations.
    if (/^\s/.test(rawLine)) {
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    if (MAIN_FUNC_RE.test(trimmed)) {
      hasMainFunc = true;
    }

    const funcMatch = FUNC_RE.exec(trimmed);
    if (funcMatch) {
      addDeclaration(funcMatch[1]!);
      continue;
    }

    const typeMatch = TYPE_RE.exec(trimmed);
    if (typeMatch) {
      addDeclaration(typeMatch[1]!);
      continue;
    }

    if (CONST_BLOCK_RE.test(trimmed)) {
      i = scanBlock(lines, i, addDeclaration);
      continue;
    }

    const constMatch = CONST_SINGLE_RE.exec(trimmed);
    if (constMatch) {
      addDeclaration(constMatch[1]!);
      continue;
    }

    if (VAR_BLOCK_RE.test(trimmed)) {
      i = scanBlock(lines, i, addDeclaration);
      continue;
    }

    const varMatch = VAR_SINGLE_RE.exec(trimmed);
    if (varMatch) {
      addDeclaration(varMatch[1]!);
      continue;
    }
  }

  analysis.hasMainEntrypoint = isPackageMain && hasMainFunc;
  analysis.usesTestFramework = filePath.endsWith("_test.go") || importsTesting;
  analysis.localExportCount = analysis.exports.size;

  return analysis;
}

// Real go/parser + go/ast walk over top-level declarations, run as a
// throwaway `go run` program. ParseFile parses the file's syntax tree
// directly from the given source bytes — it does not evaluate build
// constraints (`//go:build ...`) the way a full `go build`/`go list`
// would, so files gated behind build tags still parse normally here.
const GO_ANALYZER_SCRIPT = String.raw`
package main

import (
	"encoding/json"
	"go/ast"
	"go/parser"
	"go/token"
	"io"
	"os"
	"sort"
	"strings"
)

// Plain map instead of a tagged struct — avoids backtick-inside-template-
// literal escaping headaches for the struct tags in this embedded script.
func toJSON(
	exports, valueExports, typeExports, localSymbols []string,
	hasMainEntrypoint bool,
	localExportCount, localImplementationCount int,
	usesTestFramework bool,
) ([]byte, error) {
	return json.Marshal(map[string]interface{}{
		"exports":                  exports,
		"valueExports":             valueExports,
		"typeExports":              typeExports,
		"localSymbols":             localSymbols,
		"exportConfidence":         "exact",
		"hasDefaultExport":         false,
		"hasWildcardReExport":      false,
		"hasMainEntrypoint":        hasMainEntrypoint,
		"directReExportCount":      0,
		"localExportCount":         localExportCount,
		"localImplementationCount": localImplementationCount,
		"usesTestFramework":        usesTestFramework,
	})
}

func keys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func main() {
	src, err := io.ReadAll(os.Stdin)
	if err != nil {
		os.Stderr.WriteString(err.Error())
		os.Exit(2)
	}

	// Invoked as: go run analyzer.go -- <filePath>. The "--" separator stops
	// "go run" from treating a trailing ".go"-suffixed argument as another
	// source file to compile alongside the analyzer, and is itself passed
	// through to the compiled binary's os.Args, hence index 2.
	filePath := ""
	if len(os.Args) > 2 {
		filePath = os.Args[2]
	}

	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, filePath, src, parser.ParseComments)
	if err != nil {
		os.Stderr.WriteString(err.Error())
		os.Exit(2)
	}

	exports := map[string]bool{}
	locals := map[string]bool{}
	localImplementationCount := 0
	hasMainFunc := false
	isPackageMain := file.Name != nil && file.Name.Name == "main"
	importsTesting := false

	addDecl := func(name string) {
		if name == "" || name == "_" {
			return
		}
		locals[name] = true
		if ast.IsExported(name) {
			exports[name] = true
		}
		localImplementationCount++
	}

	for _, imp := range file.Imports {
		importPath := strings.Trim(imp.Path.Value, "\"")
		if importPath == "testing" {
			importsTesting = true
		}
	}

	for _, decl := range file.Decls {
		switch d := decl.(type) {
		case *ast.FuncDecl:
			if d.Recv != nil {
				// Method — excluded, same as the heuristic.
				continue
			}
			name := d.Name.Name
			if name == "main" && isPackageMain {
				hasMainFunc = true
			}
			addDecl(name)
		case *ast.GenDecl:
			switch d.Tok {
			case token.TYPE:
				for _, spec := range d.Specs {
					if ts, ok := spec.(*ast.TypeSpec); ok {
						addDecl(ts.Name.Name)
					}
				}
			case token.CONST, token.VAR:
				for _, spec := range d.Specs {
					if vs, ok := spec.(*ast.ValueSpec); ok {
						for _, name := range vs.Names {
							addDecl(name.Name)
						}
					}
				}
			}
		}
	}

	sortedExports := keys(exports)
	sortedLocals := keys(locals)

	out, err := toJSON(
		sortedExports,
		sortedExports,
		[]string{},
		sortedLocals,
		isPackageMain && hasMainFunc,
		len(sortedExports),
		localImplementationCount,
		strings.HasSuffix(filePath, "_test.go") || importsTesting,
	)
	if err != nil {
		os.Stderr.WriteString(err.Error())
		os.Exit(2)
	}
	os.Stdout.Write(out)
}
`;

function normalizeResult(output: string): LanguageAnalysis {
  const parsed = JSON.parse(output) as {
    exports: string[];
    valueExports: string[];
    typeExports: string[];
    localSymbols: string[];
    exportConfidence: "exact" | "heuristic";
    hasDefaultExport: boolean;
    hasWildcardReExport: boolean;
    hasMainEntrypoint: boolean;
    directReExportCount: number;
    localExportCount: number;
    localImplementationCount: number;
    usesTestFramework: boolean;
  };

  const analysis = createEmptyAnalysis();
  analysis.exports = new Set(parsed.exports ?? []);
  analysis.valueExports = new Set(parsed.valueExports ?? []);
  analysis.typeExports = new Set(parsed.typeExports ?? []);
  analysis.localSymbols = new Set(parsed.localSymbols ?? []);
  analysis.exportConfidence = parsed.exportConfidence ?? "exact";
  analysis.hasDefaultExport = Boolean(parsed.hasDefaultExport);
  analysis.hasWildcardReExport = Boolean(parsed.hasWildcardReExport);
  analysis.hasMainEntrypoint = Boolean(parsed.hasMainEntrypoint);
  analysis.directReExportCount = Number(parsed.directReExportCount ?? 0);
  analysis.localExportCount = Number(parsed.localExportCount ?? 0);
  analysis.localImplementationCount = Number(parsed.localImplementationCount ?? 0);
  analysis.usesTestFramework = Boolean(parsed.usesTestFramework);
  return analysis;
}

/**
 * Runs the real go/parser + go/ast backend via a throwaway `go run`
 * program. Returns `null` when `go` is not on PATH so the caller can
 * degrade to the heuristic scan instead of hard-failing — unlike Python
 * and Dart, Go linting must never hard-block on a missing toolchain
 * because the heuristic floor is always available.
 */
function runExactAnalysis(filePath: string, text: string): LanguageAnalysis | null {
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "grace-go-analyzer-"));
  const analyzerFile = path.join(temporaryDirectory, "analyzer.go");
  writeFileSync(analyzerFile, GO_ANALYZER_SCRIPT, "utf8");
  try {
    for (const binary of GO_BINARIES) {
      const run = spawnSync(binary, ["run", analyzerFile, "--", filePath], {
        input: Buffer.from(text, "utf8"),
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        // Read PATH live rather than at process startup, so a missing `go`
        // binary is detected reliably (also lets tests simulate "go missing"
        // by mutating process.env.PATH around the call).
        env: process.env,
      });

      if (run.error) {
        const code = (run.error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          continue;
        }
        throw run.error;
      }

      if (run.status === 0) {
        return normalizeResult(run.stdout);
      }

      throw new Error(run.stderr.trim() || run.stdout.trim() || `Go analyzer failed via ${binary}.`);
    }
    return null;
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

export function createGoAdapter(): LanguageAdapter {
  return {
    id: "go",
    supports(filePath) {
      return GO_EXTENSIONS.has(path.extname(filePath));
    },
    analyze(filePath, text) {
      const exact = runExactAnalysis(filePath, text);
      if (exact) {
        return exact;
      }
      return analyzeGoHeuristic(filePath, text);
    },
  };
}
