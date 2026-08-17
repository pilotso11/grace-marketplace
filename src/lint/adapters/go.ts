import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { LanguageAdapter, LanguageAnalysis } from "../types";

const GO_EXTENSIONS = new Set([".go"]);
const GO_BINARY = "go";

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

// Real go/parser + go/ast walk over top-level declarations. Built once into
// a cached binary (see ensureCachedBinary below) and then reused directly
// for every file. ParseFile parses the file's syntax tree directly from the
// given source bytes — it does not evaluate build constraints
// (`//go:build ...`) the way a full `go build`/`go list` would, so files
// gated behind build tags still parse normally here.
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
	symbolDetails map[string]interface{},
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
		"symbolDetails":            symbolDetails,
	})
}

// receiverTypeName resolves a method receiver's base type name, unwrapping
// pointer receivers (*T), and generic receivers (T[X], T[X, Y]) down to the
// bare identifier — same "strip leading * and generic brackets" convention
// the MODULE_MAP dotted-entry format (Type.Method) already assumes.
func receiverTypeName(expr ast.Expr) string {
	switch t := expr.(type) {
	case *ast.Ident:
		return t.Name
	case *ast.StarExpr:
		return receiverTypeName(t.X)
	case *ast.IndexExpr:
		return receiverTypeName(t.X)
	case *ast.IndexListExpr:
		return receiverTypeName(t.X)
	default:
		return ""
	}
}

// isStubBody reports only the unambiguous stub shapes named in issue #9: a
// nil body (forward-declared/assembly-linked — out of scope, not a stub), an
// empty body, a body that is only a panic(...) call, or a body that is only
// a bare "return"/"return nil". Deliberately NOT a statement-count
// threshold — short real functions are common and legitimate in Go.
func isStubBody(body *ast.BlockStmt) bool {
	if body == nil {
		return false
	}
	if len(body.List) == 0 {
		return true
	}
	if len(body.List) != 1 {
		return false
	}
	switch stmt := body.List[0].(type) {
	case *ast.ExprStmt:
		call, ok := stmt.X.(*ast.CallExpr)
		if !ok {
			return false
		}
		ident, ok := call.Fun.(*ast.Ident)
		return ok && ident.Name == "panic"
	case *ast.ReturnStmt:
		if len(stmt.Results) == 0 {
			return true
		}
		if len(stmt.Results) == 1 {
			ident, ok := stmt.Results[0].(*ast.Ident)
			return ok && ident.Name == "nil"
		}
		return false
	default:
		return false
	}
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

	// Invoked as the compiled binary directly: analyzer <filePath>.
	filePath := ""
	if len(os.Args) > 1 {
		filePath = os.Args[1]
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

	symbolDetails := map[string]interface{}{}

	for _, decl := range file.Decls {
		switch d := decl.(type) {
		case *ast.FuncDecl:
			// Separate from the exports/locals decision below: symbolDetails
			// covers methods too (keyed "Type.Method"), since #9's
			// doc-comment/stub checks need to inspect them even though
			// methods still must NOT be added to exports/localSymbols.
			var detailKey string
			if d.Recv != nil {
				if len(d.Recv.List) == 0 {
					continue
				}
				typeName := receiverTypeName(d.Recv.List[0].Type)
				if typeName == "" {
					continue
				}
				detailKey = typeName + "." + d.Name.Name
			} else {
				detailKey = d.Name.Name
			}
			symbolDetails[detailKey] = map[string]interface{}{
				"hasDocComment": d.Doc != nil && strings.TrimSpace(d.Doc.Text()) != "",
				"isStub":        isStubBody(d.Body),
			}

			if d.Recv != nil {
				// Method — excluded from exports/locals, same as the heuristic.
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
		symbolDetails,
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
    symbolDetails?: Record<string, { hasDocComment: boolean; isStub: boolean }>;
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
  analysis.symbolDetails = new Map(Object.entries(parsed.symbolDetails ?? {}));
  return analysis;
}

// Cache-dir resolution follows the common per-user-tool convention: honor
// XDG_CACHE_HOME when set, else ~/.cache. GRACE_GO_ANALYZER_CACHE_DIR is an
// internal override, not a documented user-facing knob — it exists so tests
// can point at a scoped temp dir instead of polluting/depending on the real
// ~/.cache/grace-cli state across test runs.
function resolveCacheDir(): string {
  const override = process.env.GRACE_GO_ANALYZER_CACHE_DIR;
  if (override) {
    return override;
  }
  const xdgCacheHome = process.env.XDG_CACHE_HOME;
  const base = xdgCacheHome ? xdgCacheHome : path.join(os.homedir(), ".cache");
  return path.join(base, "grace-cli", "go-analyzer");
}

// Content-addressed on the embedded script, so any future edit to
// GO_ANALYZER_SCRIPT invalidates the cache automatically — no version-bump
// bookkeeping needed, and a stale binary is never reused.
function analyzerBinaryPath(): string {
  const hash = createHash("sha256").update(GO_ANALYZER_SCRIPT, "utf8").digest("hex").slice(0, 16);
  const extension = process.platform === "win32" ? ".exe" : "";
  return path.join(resolveCacheDir(), `analyzer-${hash}${extension}`);
}

/**
 * Builds the analyzer into the content-addressed cache path if it isn't
 * there already, then returns that path. Returns `null` when `go` is not on
 * PATH so the caller can degrade to the heuristic scan instead of
 * hard-failing — unlike Python and Dart, Go linting must never hard-block on
 * a missing toolchain because the heuristic floor is always available.
 *
 * Builds to a temp file first and renames into place, so a concurrent
 * `grace lint` process racing to build the same cache entry never observes
 * a partially-written binary. If another process wins the race and the
 * rename target already exists, we just use what's there.
 */
function ensureAnalyzerBinary(): string | null {
  const binaryPath = analyzerBinaryPath();
  if (existsSync(binaryPath)) {
    return binaryPath;
  }

  const cacheDir = resolveCacheDir();
  mkdirSync(cacheDir, { recursive: true });

  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "grace-go-analyzer-"));
  try {
    const analyzerFile = path.join(temporaryDirectory, "analyzer.go");
    writeFileSync(analyzerFile, GO_ANALYZER_SCRIPT, "utf8");
    const buildOutput = path.join(temporaryDirectory, "analyzer-build");

    const build = spawnSync(GO_BINARY, ["build", "-o", buildOutput, analyzerFile], {
      encoding: "utf8",
      // Read PATH live rather than at process startup, so a missing `go`
      // binary is detected reliably (also lets tests simulate "go missing"
      // by mutating process.env.PATH around the call).
      env: process.env,
    });

    if (build.error) {
      const code = (build.error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return null;
      }
      throw build.error;
    }

    if (build.status !== 0) {
      throw new Error(build.stderr.trim() || build.stdout.trim() || "Go analyzer build failed.");
    }

    if (!existsSync(binaryPath)) {
      try {
        renameSync(buildOutput, binaryPath);
      } catch (error) {
        // Cross-filesystem temp/cache dirs can't be renamed (EXDEV) — copy
        // instead. Also tolerate a concurrent process having won the race
        // and already placed the binary in the meantime.
        if (!existsSync(binaryPath)) {
          copyFileSync(buildOutput, binaryPath);
        } else {
          void error;
        }
      }
    }

    return binaryPath;
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

/**
 * Runs the real go/parser + go/ast backend via the cached compiled binary
 * (building it once if needed). Returns `null` when `go` is not on PATH and
 * no cached binary exists, so the caller can degrade to the heuristic scan.
 */
function runExactAnalysis(filePath: string, text: string): LanguageAnalysis | null {
  const binaryPath = ensureAnalyzerBinary();
  if (!binaryPath) {
    return null;
  }

  const run = spawnSync(binaryPath, [filePath], {
    input: Buffer.from(text, "utf8"),
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });

  if (run.error) {
    throw run.error;
  }

  if (run.status === 0) {
    return normalizeResult(run.stdout);
  }

  throw new Error(run.stderr.trim() || run.stdout.trim() || "Go analyzer failed.");
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
