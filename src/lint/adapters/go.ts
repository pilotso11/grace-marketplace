import path from "node:path";

import type { LanguageAdapter, LanguageAnalysis } from "../types";

const GO_EXTENSIONS = new Set([".go"]);

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

export function createGoAdapter(): LanguageAdapter {
  return {
    id: "go",
    supports(filePath) {
      return GO_EXTENSIONS.has(path.extname(filePath));
    },
    analyze(filePath, text) {
      const analysis: LanguageAnalysis = {
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
    },
  };
}
