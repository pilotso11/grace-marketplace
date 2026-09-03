import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, test } from "bun:test";

import { analyzeGovernedFile, collectCodeFiles, describeUnreadableDirectory, hasRuntimeMarkerEvidence, parseGovernedFile } from "./project-utils";

const hasGo = (() => {
  const result = spawnSync("go", ["version"], { stdio: "ignore" });
  return !result.error && result.status === 0;
})();

function contract(mapMode: "EXPORTS" | "LOCALS" | "SUMMARY" | "NONE", moduleMap = ""): string {
  return `// START_MODULE_CONTRACT
// PURPOSE: Exercise semantic markup.
// SCOPE: Test-only fixture.
// DEPENDS: none
// LINKS: M-EXAMPLE
// ROLE: ${mapMode === "LOCALS" ? "SCRIPT" : mapMode === "SUMMARY" ? "BARREL" : mapMode === "NONE" ? "CONFIG" : "RUNTIME"}
// MAP_MODE: ${mapMode}
// END_MODULE_CONTRACT
${moduleMap ? `// START_MODULE_MAP\n${moduleMap}\n// END_MODULE_MAP\n` : ""}`;
}

describe("governed file analysis", () => {
  it("parses the shared markup record and enforces exact TypeScript value/type export parity", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "grace-markup-"));
    const file = path.join(root, "src", "example.ts");
    const text = `${contract("EXPORTS", "// value - Runtime value.\n// ExampleType - Public type.")}export const value = 1;\nexport type ExampleType = string;\n`;

    const record = parseGovernedFile(root, file, text);
    const analysis = analyzeGovernedFile(root, file, text);

    expect(record.path).toBe("src/example.ts");
    expect(record.linkedModuleIds).toEqual(["M-EXAMPLE"]);
    expect(record.moduleMap.map((item) => item.symbolName)).toEqual(["value", "ExampleType"]);
    expect(analysis.language?.exportConfidence).toBe("exact");
    expect(analysis.issues.filter((issue) => issue.severity === "error")).toHaveLength(0);
  });

  it("accepts bracketed and unbracketed LINKS lists while filtering non-module anchors", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "grace-links-"));
    const file = path.join(root, "src", "example.ts");
    const links = (value: string) => parseGovernedFile(root, file, contract("NONE").replace("LINKS: M-EXAMPLE", `LINKS: ${value}`)).linkedModuleIds;

    expect(links("[M-ONE]")).toEqual(["M-ONE"]);
    expect(links("[M-ONE, M-TWO, V-M-ONE]")).toEqual(["M-ONE", "M-TWO"]);
    expect(links("M-ONE, M-TWO, V-M-ONE")).toEqual(["M-ONE", "M-TWO"]);
    expect(links("[none]")).toEqual([]);
    expect(links("none")).toEqual([]);
  });

  it("accepts RUNTIME+LOCALS for files with no public surface but rejects a genuinely invalid role/mode pair", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "grace-role-map-mode-"));

    const runtimeLocalsFile = path.join(root, "src", "wiring.ts");
    const runtimeLocalsText = `// START_MODULE_CONTRACT
// PURPOSE: Wire internal dependencies with no public surface.
// SCOPE: Dependency injection only.
// DEPENDS: none
// LINKS: M-EXAMPLE
// ROLE: RUNTIME
// MAP_MODE: LOCALS
// END_MODULE_CONTRACT
// START_MODULE_MAP
// wireDeps - Internal dependency wiring.
// END_MODULE_MAP
function wireDeps() {}
`;
    const runtimeLocalsIssues = analyzeGovernedFile(root, runtimeLocalsFile, runtimeLocalsText).issues;
    expect(runtimeLocalsIssues.map((issue) => issue.code)).not.toContain("markup.role-map-mode-mismatch");

    const configExportsFile = path.join(root, "src", "config.ts");
    const configExportsText = `// START_MODULE_CONTRACT
// PURPOSE: Static configuration values.
// SCOPE: Config only.
// DEPENDS: none
// LINKS: M-EXAMPLE
// ROLE: CONFIG
// MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
// START_MODULE_MAP
// value - Exported value.
// END_MODULE_MAP
export const value = 1;
`;
    const configExportsIssues = analyzeGovernedFile(root, configExportsFile, configExportsText).issues;
    expect(configExportsIssues.map((issue) => issue.code)).toContain("markup.role-map-mode-mismatch");
    const configExportsMismatch = configExportsIssues.find((issue) => issue.code === "markup.role-map-mode-mismatch");
    expect(configExportsMismatch?.message).toBe("CONFIG files require MAP_MODE NONE, not EXPORTS.");
  });

  it("still rejects RUNTIME+NONE and RUNTIME+SUMMARY, pinning the RUNTIME boundary to EXPORTS or LOCALS", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "grace-runtime-boundary-"));

    const runtimeNoneFile = path.join(root, "src", "sideeffect.ts");
    const runtimeNoneText = `// START_MODULE_CONTRACT
// PURPOSE: Register a side effect on import.
// SCOPE: Side effect only.
// DEPENDS: none
// LINKS: M-EXAMPLE
// ROLE: RUNTIME
// MAP_MODE: NONE
// END_MODULE_CONTRACT
`;
    const runtimeNoneIssues = analyzeGovernedFile(root, runtimeNoneFile, runtimeNoneText).issues;
    const runtimeNoneMismatch = runtimeNoneIssues.find((issue) => issue.code === "markup.role-map-mode-mismatch");
    expect(runtimeNoneMismatch?.message).toBe("RUNTIME files require MAP_MODE EXPORTS or LOCALS, not NONE.");

    const runtimeSummaryFile = path.join(root, "src", "summary.ts");
    const runtimeSummaryText = `// START_MODULE_CONTRACT
// PURPOSE: A summary-mode runtime file.
// SCOPE: Not a barrel.
// DEPENDS: none
// LINKS: M-EXAMPLE
// ROLE: RUNTIME
// MAP_MODE: SUMMARY
// END_MODULE_CONTRACT
// START_MODULE_MAP
// value - Exported value.
// END_MODULE_MAP
export const value = 1;
`;
    const runtimeSummaryIssues = analyzeGovernedFile(root, runtimeSummaryFile, runtimeSummaryText).issues;
    const runtimeSummaryMismatch = runtimeSummaryIssues.find((issue) => issue.code === "markup.role-map-mode-mismatch");
    expect(runtimeSummaryMismatch?.message).toBe("RUNTIME files require MAP_MODE EXPORTS or LOCALS, not SUMMARY.");
  });

  it("still checks RUNTIME+LOCALS parity: a local symbol missing from MODULE_MAP is a mismatch", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "grace-runtime-locals-parity-"));
    const file = path.join(root, "src", "wiring.ts");
    const text = `// START_MODULE_CONTRACT
// PURPOSE: Wire internal dependencies with no public surface.
// SCOPE: Dependency injection only.
// DEPENDS: none
// LINKS: M-EXAMPLE
// ROLE: RUNTIME
// MAP_MODE: LOCALS
// END_MODULE_CONTRACT
// START_MODULE_MAP
// wireDeps - Internal dependency wiring.
// END_MODULE_MAP
function wireDeps() {}
function otherHelper() {}
`;
    const issues = analyzeGovernedFile(root, file, text).issues;
    const mismatch = issues.find((issue) => issue.code === "markup.module-map-mismatch");
    expect(mismatch?.message).toContain("otherHelper");
  });

  // Issue #463: markup.module-map-mismatch is a Set-difference check, so a
  // symbol named TWICE in the MODULE_MAP is neither "missing" nor "extra" -
  // set(map) still equals set(code), and the duplicate ships lint-clean.
  // Reproduces the issue's own four-state matrix on one fixture, each state
  // differing only in the MODULE_MAP body, so the negative control (state 3)
  // and the false-positive check (state 1) run against the SAME shape of
  // file the defect (state 2) does.
  describe("markup.duplicate-module-map-entry (issue #463)", () => {
    const header = `// START_MODULE_CONTRACT
// PURPOSE: Wire internal dependencies with no public surface.
// SCOPE: Dependency injection only.
// DEPENDS: none
// LINKS: M-EXAMPLE
// ROLE: RUNTIME
// MAP_MODE: LOCALS
// END_MODULE_CONTRACT
// START_MODULE_MAP
`;
    const footer = "\n// END_MODULE_MAP\n";
    const analyze = (moduleMap: string, code: string) => {
      const root = mkdtempSync(path.join(os.tmpdir(), "grace-map-duplicate-"));
      const file = path.join(root, "src", "wiring.ts");
      return analyzeGovernedFile(root, file, `${header}${moduleMap}${footer}${code}`).issues;
    };

    it("state 1 - entry present once: 0 errors, no false positive on the normal case", () => {
      const issues = analyze("// wireDeps - Internal dependency wiring.", "function wireDeps() {}\n");
      expect(issues.filter((issue) => issue.severity === "error")).toHaveLength(0);
    });

    it("state 2 - the SAME entry duplicated: now 1 duplicate-module-map-entry error (the fix)", () => {
      const issues = analyze(
        "// wireDeps - Internal dependency wiring.\n// wireDeps - wires the container's deps.",
        "function wireDeps() {}\n",
      );
      expect(issues.map((issue) => issue.code)).not.toContain("markup.module-map-mismatch");
      const duplicates = issues.filter((issue) => issue.code === "markup.duplicate-module-map-entry");
      expect(duplicates).toHaveLength(1);
      // 10 and 11 are where the entries physically ARE: the contract occupies
      // 1-8 and START_MODULE_MAP is line 9. This read "(lines 9, 10)" before -
      // every entry reported one line high, because parseListSection used the
      // section's startLine, which is the MARKER's line, as the base for
      // content beginning on the next one. The old expectation encoded the bug
      // and sent a reader to the marker instead of the entry.
      expect(duplicates[0]?.message).toBe("MODULE_MAP names 'wireDeps' 2 times (lines 10, 11); a symbol is documented once.");
      // Pinned against the fixture rather than a literal, so this cannot drift
      // back by someone "correcting" the numbers to match a regression.
      expect(duplicates[0]?.line).toBe(10);
    });

    it("state 3 - entry removed (negative control): module-map-mismatch still fires, proving the rule ran on this file", () => {
      // wireDeps stays a real local (the code declares it), but the map now
      // documents a different, unrelated symbol instead - the point under
      // test is that `wireDeps` itself is undocumented, i.e. "missing".
      const issues = analyze(
        "// otherHelper - Unrelated helper, present so LOCALS still has a non-empty map.",
        "function wireDeps() {}\nfunction otherHelper() {}\n",
      );
      const mismatch = issues.find((issue) => issue.code === "markup.module-map-mismatch");
      expect(mismatch?.message).toContain("wireDeps");
      expect(issues.map((issue) => issue.code)).not.toContain("markup.duplicate-module-map-entry");
    });

    it("state 4 - entry naming a non-existent symbol: module-map-mismatch still fires (extra), no duplicate false positive", () => {
      const issues = analyze(
        "// wireDeps - Internal dependency wiring.\n// bogusSymbolThatDoesNotExist - Not real.",
        "function wireDeps() {}\n",
      );
      const mismatch = issues.find((issue) => issue.code === "markup.module-map-mismatch");
      expect(mismatch?.message).toContain("bogusSymbolThatDoesNotExist");
      expect(issues.map((issue) => issue.code)).not.toContain("markup.duplicate-module-map-entry");
    });
  });

  // Follow-up to issue #463, found reviewing pilotso11/zai-reviewer#469:
  // GROUPED_MAP_ENTRY required EVERY "/"-separated member to be a clean
  // identifier, so one malformed member (e.g. an elided "...Foo" abbreviation)
  // failed the WHOLE line's match. DESCRIBED_MAP_ENTRY then misread the line
  // as a continuation of the PREVIOUS entry rather than an entry of its own,
  // so none of its members - including a well-formed one duplicating a
  // standalone entry elsewhere - ever reached validateMapDuplicates's tally.
  // The fix (ELLIPSIS_IDENT / GROUPED_MEMBER) lets a "..."-prefixed member
  // stay inert (no checkable symbol, like a DOTTED_MAP_ENTRY) WITHOUT
  // failing the rest of the line's classification as a real entry.
  describe("markup.duplicate-module-map-entry sees a combined entry with an elided member", () => {
    const header = `// START_MODULE_CONTRACT
// PURPOSE: Wire internal dependencies with no public surface.
// SCOPE: Dependency injection only.
// DEPENDS: none
// LINKS: M-EXAMPLE
// ROLE: RUNTIME
// MAP_MODE: LOCALS
// END_MODULE_CONTRACT
// START_MODULE_MAP
`;
    const footer = "\n// END_MODULE_MAP\n";
    const analyze = (moduleMap: string, code: string) => {
      const root = mkdtempSync(path.join(os.tmpdir(), "grace-map-duplicate-combined-"));
      const file = path.join(root, "src", "wiring.ts");
      return analyzeGovernedFile(root, file, `${header}${moduleMap}${footer}${code}`).issues;
    };

    it("negative control - a combined entry's lead member duplicates a standalone entry: caught, not swallowed as a continuation", () => {
      const issues = analyze(
        [
          "// wireDeps - Internal dependency wiring.",
          "// otherHelper - Unrelated helper, documented on its own line first.",
          "// wireDeps / ...Helper - a later note that re-documents the same pair together.",
        ].join("\n"),
        "function wireDeps() {}\nfunction otherHelper() {}\n",
      );
      // If the combined line were still misread as a continuation, its text
      // would glue onto otherHelper's description instead of standing alone -
      // and wireDeps' second mention would never be tallied at all.
      const duplicates = issues.filter((issue) => issue.code === "markup.duplicate-module-map-entry");
      expect(duplicates).toHaveLength(1);
      expect(duplicates[0]?.message).toContain("'wireDeps' 2 times");
      expect(issues.map((issue) => issue.code)).not.toContain("markup.module-map-mismatch");
    });

    it("the elided member itself stays inert - no false 'extra' mismatch, mirroring a DOTTED_MAP_ENTRY", () => {
      const issues = analyze(
        [
          "// wireDeps - Internal dependency wiring.",
          "// otherHelper / ...NeverDeclared - otherHelper is real; the elided second member names nothing checkable.",
        ].join("\n"),
        "function wireDeps() {}\nfunction otherHelper() {}\n",
      );
      expect(issues.map((issue) => issue.code)).not.toContain("markup.module-map-mismatch");
      expect(issues.map((issue) => issue.code)).not.toContain("markup.duplicate-module-map-entry");
    });
  });

  it("reports line-addressed missing, reversed, duplicate, mismatched, and overlapping markers", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "grace-markers-"));
    const file = path.join(root, "broken.ts");
    const text = `// END_BLOCK_REVERSED
// START_MODULE_CONTRACT
// START_MODULE_MAP
// END_MODULE_CONTRACT
// START_BLOCK_DUP
// END_BLOCK_DUP
// START_BLOCK_DUP
// END_BLOCK_OTHER
// START_CHANGE_SUMMARY
`;
    const issues = analyzeGovernedFile(root, file, text).issues;
    const codes = issues.map((issue) => issue.code);

    expect(codes).toContain("markup.reversed-marker");
    expect(codes).toContain("markup.overlapping-markers");
    expect(codes).toContain("markup.mismatched-marker");
    expect(codes).toContain("markup.duplicate-marker");
    expect(codes).toContain("markup.missing-end-marker");
    expect(issues.filter((issue) => issue.code.startsWith("markup.")).every((issue) => typeof issue.line === "number")).toBe(true);
  });

  it("parses properly nested semantic blocks without reporting overlap", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "grace-nested-blocks-"));
    const file = path.join(root, "nested.ts");
    const text = `// START_BLOCK_OUTER
// START_BLOCK_INNER
export const value = true;
// END_BLOCK_INNER
// END_BLOCK_OUTER
`;

    expect(parseGovernedFile(root, file, text).blocks).toEqual([
      { name: "OUTER", startLine: 1, endLine: 5 },
      { name: "INNER", startLine: 2, endLine: 4 },
    ]);
    expect(analyzeGovernedFile(root, file, text).issues.map((issue) => issue.code)).not.toContain("markup.overlapping-markers");
  });

  it("accepts a function contract nested inside a semantic block", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "grace-contract-in-block-"));
    const file = path.join(root, "contract-in-block.ts");
    const text = `// START_BLOCK_SEAM
// START_CONTRACT: observe
//   PURPOSE: p
//   INPUTS: { a: string - a }
//   OUTPUTS: { void - nothing }
//   SIDE_EFFECTS: none
//   LINKS: M-X
// END_CONTRACT: observe
export const observe = (a: string) => a;
// END_BLOCK_SEAM
`;

    const codes = analyzeGovernedFile(root, file, text).issues.map((issue) => issue.code);
    expect(codes).not.toContain("markup.overlapping-markers");
    expect(codes).not.toContain("markup.mismatched-marker");
  });

  it("still rejects a block opened inside a function contract", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "grace-block-in-contract-"));
    const file = path.join(root, "block-in-contract.ts");
    const text = `// START_CONTRACT: observe
// START_BLOCK_SEAM
// END_BLOCK_SEAM
// END_CONTRACT: observe
`;

    expect(analyzeGovernedFile(root, file, text).issues.map((issue) => issue.code)).toContain(
      "markup.overlapping-markers",
    );
  });

  it("treats a wrapped MODULE_MAP description as part of the previous entry", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "grace-wrapped-map-"));
    const file = path.join(root, "wrapped.ts");
    const text = `// START_MODULE_MAP
//   getModels - GET /api/models; swallows any failure to [] so callers can
//     fall back to a free-text input when the endpoint is not deployed yet
// END_MODULE_MAP
export const getModels = () => [];
`;

    const map = parseGovernedFile(root, file, text).moduleMap;
    expect(map.map((item) => item.symbolName)).toEqual(["getModels"]);
    expect(map[0]!.label).toContain("fall back to a free-text input");
  });

  it("registers all names in a comma-grouped MODULE_MAP entry for EXPORTS parity", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "grace-comma-group-map-"));
    const file = path.join(root, "src", "example.ts");
    const text = `${contract("EXPORTS", "// AccountsHandler, NewAccountsHandler - the handler and its constructor")}export const AccountsHandler = 1;\nexport const NewAccountsHandler = 2;\n`;

    const record = parseGovernedFile(root, file, text);
    const analysis = analyzeGovernedFile(root, file, text);

    expect(record.moduleMap[0]!.symbolNames).toEqual(["AccountsHandler", "NewAccountsHandler"]);
    expect(analysis.issues.map((issue) => issue.code)).not.toContain("markup.module-map-mismatch");
  });

  it("still parses a slash-grouped MODULE_MAP entry unchanged", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "grace-slash-group-map-"));
    const file = path.join(root, "src", "example.ts");
    const text = `${contract("EXPORTS", "// foo / bar - shared description")}export const foo = 1;\nexport const bar = 2;\n`;

    const record = parseGovernedFile(root, file, text);
    const analysis = analyzeGovernedFile(root, file, text);

    expect(record.moduleMap[0]!.symbolNames).toEqual(["foo", "bar"]);
    expect(record.moduleMap[0]!.symbolName).toBe("foo");
    expect(analysis.issues.map((issue) => issue.code)).not.toContain("markup.module-map-mismatch");
  });

  it("recognizes a dotted Type.Method MODULE_MAP entry as self-contained and exempt from parity", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "grace-dotted-method-map-"));
    const file = path.join(root, "src", "example.ts");
    const text = `${contract(
      "EXPORTS",
      "// AccountsHandler - the handler\n// AccountsHandler.List - GET /api/accounts/:id: one account's config",
    )}export const AccountsHandler = 1;\n`;

    const record = parseGovernedFile(root, file, text);
    const analysis = analyzeGovernedFile(root, file, text);

    expect(record.moduleMap).toHaveLength(2);
    expect(record.moduleMap[0]!.label).toBe("AccountsHandler - the handler");
    expect(record.moduleMap[1]!.label).toBe("AccountsHandler.List - GET /api/accounts/:id: one account's config");
    expect(record.moduleMap[1]!.symbolNames).toEqual([]);
    expect(analysis.issues.map((issue) => issue.code)).not.toContain("markup.module-map-mismatch");
  });

  it("parses a real-world-shaped MODULE_MAP combining plain, comma-grouped, and dotted entries cleanly", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "grace-mixed-map-"));
    const file = path.join(root, "src", "example.ts");
    const text = `${contract(
      "EXPORTS",
      [
        "// plainExport - an ordinary export",
        "// AccountsHandler, NewAccountsHandler - the handler and its constructor",
        "// AccountsHandler.List - GET /api/accounts/:id: one account's config",
      ].join("\n"),
    )}export const plainExport = 1;\nexport const AccountsHandler = 2;\nexport const NewAccountsHandler = 3;\n`;

    const analysis = analyzeGovernedFile(root, file, text);

    expect(analysis.issues.filter((issue) => issue.code === "markup.module-map-mismatch")).toHaveLength(0);
  });

  it("tolerates a real unexported local documented alongside exports in EXPORTS mode (Go-seam-shaped)", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "grace-exports-unexported-seam-"));
    const file = path.join(root, "src", "example.ts");
    const text = `${contract(
      "EXPORTS",
      [
        "// accountConfigStore - consumer-defined seam over account reads/writes",
        "// AccountsHandler, NewAccountsHandler - the handler and its constructor",
      ].join("\n"),
    )}interface accountConfigStore {}\nexport const AccountsHandler = 1;\nexport const NewAccountsHandler = 2;\n`;

    const analysis = analyzeGovernedFile(root, file, text);

    expect(analysis.issues.filter((issue) => issue.code === "markup.module-map-mismatch")).toHaveLength(0);
  });

  it("still flags a MODULE_MAP entry naming no real symbol at all as extra (stale rename/typo)", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "grace-exports-fabricated-entry-"));
    const file = path.join(root, "src", "example.ts");
    const text = `${contract(
      "EXPORTS",
      [
        "// AccountsHandler - the handler",
        "// totallyMadeUpSymbol - does not exist anywhere in this file",
      ].join("\n"),
    )}export const AccountsHandler = 1;\n`;

    const analysis = analyzeGovernedFile(root, file, text);

    const mismatch = analysis.issues.find((issue) => issue.code === "markup.module-map-mismatch");
    expect(mismatch?.message).toContain("extra: totallyMadeUpSymbol");
  });

  it("still flags a genuinely missing real export as missing (unchanged behavior)", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "grace-exports-missing-export-"));
    const file = path.join(root, "src", "example.ts");
    const text = `${contract("EXPORTS", "// AccountsHandler - the handler")}export const AccountsHandler = 1;\nexport const NewAccountsHandler = 2;\n`;

    const analysis = analyzeGovernedFile(root, file, text);

    const mismatch = analysis.issues.find((issue) => issue.code === "markup.module-map-mismatch");
    expect(mismatch?.message).toContain("Missing: NewAccountsHandler");
  });

  it("keeps LOCALS mode parity unchanged: an undocumented local symbol is still extra", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "grace-locals-unchanged-"));
    const file = path.join(root, "src", "wiring.ts");
    const text = `// START_MODULE_CONTRACT
// PURPOSE: Wire internal dependencies with no public surface.
// SCOPE: Dependency injection only.
// DEPENDS: none
// LINKS: M-EXAMPLE
// ROLE: RUNTIME
// MAP_MODE: LOCALS
// END_MODULE_CONTRACT
// START_MODULE_MAP
// wireDeps - Internal dependency wiring.
// notARealLocal - documents a symbol that does not exist
// END_MODULE_MAP
function wireDeps() {}
`;
    const analysis = analyzeGovernedFile(root, file, text);
    const mismatch = analysis.issues.find((issue) => issue.code === "markup.module-map-mismatch");
    expect(mismatch?.message).toContain("extra: notARealLocal");
  });

  it("does not manufacture an outer block from crossed nesting", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "grace-crossed-blocks-"));
    const file = path.join(root, "crossed.ts");
    const text = `// START_BLOCK_OUTER
// START_BLOCK_INNER
// END_BLOCK_OUTER
// END_BLOCK_INNER
`;

    expect(parseGovernedFile(root, file, text).blocks.map((block) => block.name)).toEqual(["INNER"]);
    const codes = analyzeGovernedFile(root, file, text).issues.map((issue) => issue.code);
    expect(codes).toContain("markup.mismatched-marker");
    expect(codes).toContain("markup.missing-end-marker");
  });

  it("credits exact marker constants with identifier-aware boundaries", () => {
    const marker = "[Example][run][BLOCK_RUN]";
    expect(hasRuntimeMarkerEvidence(`console.info("${marker} ok");`, marker)).toBe(true);
    expect(hasRuntimeMarkerEvidence(`const marker$ = "${marker}";\nconsole.info(marker$ + " ok");`, marker)).toBe(true);
    expect(hasRuntimeMarkerEvidence(`static let marker = "${marker}"\nlog.info("\\(marker) ok")`, marker)).toBe(true);
    expect(hasRuntimeMarkerEvidence(`const marker$ = "${marker}";\nconsole.info(marker$Other + " ok");`, marker)).toBe(false);
    expect(hasRuntimeMarkerEvidence(`const marker$ = "${marker}";\nreturn marker$;`, marker)).toBe(false);
    expect(hasRuntimeMarkerEvidence(`// const marker$ = "${marker}";\nconsole.info(marker$ + " ok");`, marker)).toBe(false);
  });

  it("credits capitalised logger methods used by Go, Java, and C#", () => {
    const marker = "[Example][run][BLOCK_RUN]";
    // Go stdlib log
    expect(hasRuntimeMarkerEvidence(`log.Info("${marker} ok")`, marker)).toBe(true);
    expect(hasRuntimeMarkerEvidence(`log.Warn("${marker} ok")`, marker)).toBe(true);
    // Go slog, context-taking variants
    expect(hasRuntimeMarkerEvidence(`d.log.InfoContext(ctx, "${marker} ok")`, marker)).toBe(true);
    expect(hasRuntimeMarkerEvidence(`slog.Error("${marker} failed")`, marker)).toBe(true);
    // Go logrus/zap, printf form
    expect(hasRuntimeMarkerEvidence(`logger.Errorf("${marker} failed: %v", err)`, marker)).toBe(true);
    // java.util.logging - note `severe` is its error level, not a Go/SLF4J name
    expect(hasRuntimeMarkerEvidence(`LOG.info("${marker} ok")`, marker)).toBe(true);
    expect(hasRuntimeMarkerEvidence(`LOG.severe("${marker} failed")`, marker)).toBe(true);
    // Java SLF4J / Log4j, on a receiver not called `logger`
    expect(hasRuntimeMarkerEvidence(`LOG.debug("${marker} ok")`, marker)).toBe(true);
    // C# ILogger. The receiver here is NOT `logger`, so this passes only because
    // the `Log*` method names are matched - not by the bare `logger.` prefix.
    expect(hasRuntimeMarkerEvidence(`_log.LogInformation("${marker} ok")`, marker)).toBe(true);
    expect(hasRuntimeMarkerEvidence(`_log.LogWarning("${marker} ok")`, marker)).toBe(true);
  });

  it("credits the level spellings and suffixes the alternation exists for", () => {
    const marker = "[Example][run][BLOCK_RUN]";
    // java.util.logging: `warn` cannot cover this - the required `(` makes the
    // engine backtrack on "ing(", and `LOG.` is not the bare `logger.` prefix.
    expect(hasRuntimeMarkerEvidence(`LOG.warning("${marker} ok")`, marker)).toBe(true);
    // C# ILogger, same spelling capitalised
    expect(hasRuntimeMarkerEvidence(`LOG.Warning("${marker} ok")`, marker)).toBe(true);
    // Go zap, sugared key/value form
    expect(hasRuntimeMarkerEvidence(`zap.Infow("${marker} ok", "k", v)`, marker)).toBe(true);
    // Go glog, println form
    expect(hasRuntimeMarkerEvidence(`glog.Infoln("${marker} ok")`, marker)).toBe(true);
  });

  it("credits the declaration forms the targeted languages actually use", () => {
    const marker = "[Example][run][BLOCK_RUN]";
    const emit = `\nlog.Info(prefix + "[run][BLOCK_RUN] ok")`;
    // Go short declaration - its primary form, matched only by the `:?=` clause
    expect(hasRuntimeMarkerEvidence(`prefix := "[Example]"${emit}`, marker)).toBe(true);
    // Go const, the idiomatic form for a log prefix
    expect(hasRuntimeMarkerEvidence(`const prefix = "[Example]"${emit}`, marker)).toBe(true);
    // Go untyped var
    expect(hasRuntimeMarkerEvidence(`var prefix = "[Example]"${emit}`, marker)).toBe(true);
    // TypeScript with a type annotation, which `:?=` was written for
    expect(hasRuntimeMarkerEvidence(`const prefix: string = "[Example]";${emit}`, marker)).toBe(true);
    // Go `:=` holding the WHOLE marker. Credited only by the empty-remainder
    // branch of the concatenation path: the identifier path's assignment pattern
    // ends in a bare `=` and rejects `:=`. Restricting concatenation to proper
    // prefixes, on the view that whole markers "belong" to the identifier check,
    // would silently drop Go's primary full-marker form.
    expect(hasRuntimeMarkerEvidence(`marker := "${marker}"\nlog.Info(marker)`, marker)).toBe(true);

    // Go TYPED var - still unsupported, but it must now bind NOTHING rather than
    // bind the type token `string`. The second case is the one that mattered: a
    // line using that token for anything else would otherwise credit the marker.
    expect(hasRuntimeMarkerEvidence(`var prefix string = "[Example]"${emit}`, marker)).toBe(false);
    expect(
      hasRuntimeMarkerEvidence(`var modulePrefix string = "[Example]"\nlog.Info("[run][BLOCK_RUN] " + string(body))`, marker),
    ).toBe(false);
  });

  it("requires the remainder to adjoin the constant, not merely share its line", () => {
    const marker = "[Example][run][BLOCK_RUN]";
    const decl = `const logModule = "[Example]"\n`;
    // Genuine assembly, in the forms real code uses.
    expect(hasRuntimeMarkerEvidence(`${decl}log.Info(logModule+"[run][BLOCK_RUN] ok")`, marker)).toBe(true);
    expect(hasRuntimeMarkerEvidence(`${decl}log.Info(logModule + "[run][BLOCK_RUN] ok")`, marker)).toBe(true);
    expect(hasRuntimeMarkerEvidence(`${decl}logger.info(\`\${logModule}[run][BLOCK_RUN] ok\`)`, marker)).toBe(true);

    // Both halves present, never concatenated: the marker is not emitted here.
    expect(
      hasRuntimeMarkerEvidence(`${decl}logger.Warn("unrelated " + logModule + " text [run][BLOCK_RUN] not the marker")`, marker),
    ).toBe(false);
    expect(hasRuntimeMarkerEvidence(`${decl}log.Info(logModule + "[deploy] then [run][BLOCK_RUN] later")`, marker)).toBe(false);
  });

  it("does not read obj.name as a use of a constant called name", () => {
    const marker = "[Example][run][BLOCK_RUN]";
    // The marker is bound to `logger` but never emitted; `obj.logger.Info(...)`
    // is an unrelated call. Without `.` in the identifier lookbehind this is
    // credited, and a module passes its required-marker check without emitting.
    expect(hasRuntimeMarkerEvidence(`const logger = "${marker}";\nobj.logger.Info("unrelated")`, marker)).toBe(false);
    expect(hasRuntimeMarkerEvidence(`const log = "${marker}";\nobj.log.Warning("unrelated")`, marker)).toBe(false);
  });

  it("credits a marker assembled from a module-prefix constant", () => {
    const marker = "[Example][run][BLOCK_RUN]";
    const emitted = [`const logModule = "[Example]"`, `log.Info(logModule+"[run][BLOCK_RUN] ok")`].join("\n");
    expect(hasRuntimeMarkerEvidence(emitted, marker)).toBe(true);

    // A different block in the same family must not be credited.
    const other = [`const logModule = "[Example]"`, `log.Info(logModule+"[run][BLOCK_OTHER] ok")`].join("\n");
    expect(hasRuntimeMarkerEvidence(other, marker)).toBe(false);

    // An unknown prefix identifier resolves to nothing.
    const unknown = [`const logModule = "[Example]"`, `log.Info(otherModule+"[run][BLOCK_RUN] ok")`].join("\n");
    expect(hasRuntimeMarkerEvidence(unknown, marker)).toBe(false);

    // A property access must not resolve a constant of the same name.
    const shadowed = [`const log = "[Example]"`, `d.log.Info("unrelated")`].join("\n");
    expect(hasRuntimeMarkerEvidence(shadowed, marker)).toBe(false);
  });

  it("emits bounded-confidence diagnostics for heuristic Python analysis", () => {
    const hasPython = ["python3", "python"].some((binary) => {
      const result = spawnSync(binary, ["--version"], { stdio: "ignore" });
      return !result.error && result.status === 0;
    });
    if (!hasPython) {
      return;
    }
    const root = mkdtempSync(path.join(os.tmpdir(), "grace-python-markup-"));
    const file = path.join(root, "example.py");
    const text = `# START_MODULE_CONTRACT
# PURPOSE: Python fixture.
# SCOPE: Export one function.
# DEPENDS: none
# LINKS: M-EXAMPLE
# ROLE: RUNTIME
# MAP_MODE: EXPORTS
# END_MODULE_CONTRACT
# START_MODULE_MAP
# greet - Public greeting.
# END_MODULE_MAP
def greet():
    return "hello"
`;
    const analysis = analyzeGovernedFile(root, file, text);
    expect(analysis.language?.exportConfidence).toBe("heuristic");
    expect(analysis.issues.map((issue) => issue.code)).toContain("analysis.heuristic-confidence");
    expect(analysis.issues.map((issue) => issue.code)).not.toContain("markup.module-map-mismatch");
  });

  it("preserves Unicode identifiers in exact Python MODULE_MAP parity", () => {
    const hasPython = ["python3", "python"].some((binary) => {
      const result = spawnSync(binary, ["--version"], { stdio: "ignore" });
      return !result.error && result.status === 0;
    });
    if (!hasPython) return;

    const root = mkdtempSync(path.join(os.tmpdir(), "grace-python-unicode-map-"));
    const file = path.join(root, "example.py");
    const text = `# START_MODULE_CONTRACT
# PURPOSE: Unicode Python fixture.
# SCOPE: Export one Unicode function.
# DEPENDS: none
# LINKS: M-EXAMPLE
# ROLE: RUNTIME
# MAP_MODE: EXPORTS
# END_MODULE_CONTRACT
# START_MODULE_MAP
# привет - Public greeting.
# END_MODULE_MAP
__all__ = ["привет"]
def привет():
    return "hello"
`;
    const analysis = analyzeGovernedFile(root, file, text);
    expect(analysis.record.moduleMap[0]?.symbolName).toBe("привет");
    expect(analysis.language?.exportConfidence).toBe("exact");
    expect(analysis.issues.map((issue) => issue.code)).not.toContain("markup.module-map-mismatch");
  });

  test("missing required language runtimes surface an actionable dedicated diagnostic without crashing", () => {
    const script = `import { analyzeGovernedFile } from "./src/project-utils.ts";
const text = ${JSON.stringify(`${contract("EXPORTS", "# greet - Greeting.").replaceAll("//", "#")}def greet():\n    return "hi"\n`)};
const result = analyzeGovernedFile(process.cwd(), process.cwd() + "/example.py", text);
console.log(JSON.stringify(result.issues));`;
    const run = Bun.spawnSync({
      cmd: [process.execPath, "-e", script],
      cwd: path.resolve(import.meta.dir, ".."),
      env: { ...process.env, PATH: mkdtempSync(path.join(os.tmpdir(), "grace-empty-path-")) },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(run.exitCode).toBe(0);
    const issues = JSON.parse(Buffer.from(run.stdout).toString("utf8")) as Array<{ code: string; message: string }>;
    expect(issues.map((issue) => issue.code)).toContain("analysis.runtime-missing");
    expect(issues.find((issue) => issue.code === "analysis.runtime-missing")?.message).toContain("Install Python");
  });

  // The fixture below stands a deliberately failing interpreter on PATH as a `#!/bin/sh` script.
  // Windows cannot execute one, so the spawn reports ENOENT and the adapter reaches its
  // runtime-missing branch instead of the adapter-failed branch this asserts.
  const shellShimsUnsupported = process.platform === "win32";

  test.skipIf(shellShimsUnsupported)("present but failing language runtimes surface analysis.adapter-failed without fallback", () => {
    const runtimeDir = mkdtempSync(path.join(os.tmpdir(), "grace-broken-python-"));
    const python = path.join(runtimeDir, "python3");
    writeFileSync(python, "#!/bin/sh\nexit 17\n");
    chmodSync(python, 0o755);
    const script = `import { analyzeGovernedFile } from "./src/project-utils.ts";
const text = ${JSON.stringify(`${contract("EXPORTS", "# greet - Greeting.").replaceAll("//", "#")}def greet():\n    return "hi"\n`)};
const result = analyzeGovernedFile(process.cwd(), process.cwd() + "/example.py", text);
console.log(JSON.stringify(result.issues));`;
    const run = Bun.spawnSync({
      cmd: [process.execPath, "-e", script],
      cwd: path.resolve(import.meta.dir, ".."),
      env: { ...process.env, PATH: runtimeDir },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(run.exitCode).toBe(0);
    const issues = JSON.parse(Buffer.from(run.stdout).toString("utf8")) as Array<{ code: string }>;
    expect(issues.map((issue) => issue.code)).toContain("analysis.adapter-failed");
    expect(issues.map((issue) => issue.code)).not.toContain("analysis.runtime-missing");
  });

  it("governs adapter-less C sources structurally without export analysis", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "grace-c-markup-"));
    const file = path.join(root, "src", "driver.c");
    const text = `// START_MODULE_CONTRACT
// PURPOSE: Bring up the example driver.
// SCOPE: C fixture without a language adapter.
// DEPENDS: none
// LINKS: M-EXAMPLE
// MAP_MODE: SUMMARY
// END_MODULE_CONTRACT
// START_MODULE_MAP
// driver_init - Initialize the driver.
// END_MODULE_MAP
#include <stdint.h>
void driver_init(void) {}
`;
    const analysis = analyzeGovernedFile(root, file, text);
    expect(analysis.record.linkedModuleIds).toEqual(["M-EXAMPLE"]);
    expect(analysis.language).toBeNull();
    expect(analysis.issues.filter((issue) => issue.severity === "error")).toHaveLength(0);
    expect(analysis.issues.map((issue) => issue.code)).not.toContain("analysis.heuristic-confidence");
  });

  it("parses C block-comment markers with asterisk continuation lines", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "grace-h-markup-"));
    const file = path.join(root, "src", "driver.h");
    const text = `/*
 * START_MODULE_CONTRACT
 * PURPOSE: Declare the example driver API.
 * SCOPE: C header fixture.
 * DEPENDS: none
 * LINKS: M-EXAMPLE
 * MAP_MODE: SUMMARY
 * END_MODULE_CONTRACT
 * START_MODULE_MAP
 * driver_init - Initialize the driver.
 * END_MODULE_MAP
 */
void driver_init(void);
`;
    const analysis = analyzeGovernedFile(root, file, text);
    expect(analysis.record.moduleContract?.fields.PURPOSE).toBe("Declare the example driver API.");
    expect(analysis.language).toBeNull();
    expect(analysis.issues.filter((issue) => issue.severity === "error")).toHaveLength(0);
  });

  it("governs adapter-less C# sources structurally without export analysis", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "grace-cs-markup-"));
    const file = path.join(root, "src", "SessionStore.cs");
    const text = `// START_MODULE_CONTRACT
// PURPOSE: Persist operator sessions.
// SCOPE: C# fixture without a language adapter.
// DEPENDS: none
// LINKS: M-EXAMPLE
// MAP_MODE: SUMMARY
// END_MODULE_CONTRACT
// START_MODULE_MAP
// SessionStore - Store and retrieve sessions.
// END_MODULE_MAP
namespace Example;

public sealed class SessionStore
{
    public void Clear() { }
}
`;
    const analysis = analyzeGovernedFile(root, file, text);
    expect(analysis.record.linkedModuleIds).toEqual(["M-EXAMPLE"]);
    expect(analysis.language).toBeNull();
    expect(analysis.issues.filter((issue) => issue.severity === "error")).toHaveLength(0);
    expect(analysis.issues.map((issue) => issue.code)).not.toContain("analysis.heuristic-confidence");
  });

  it("parses PowerShell markers behind the hash comment prefix", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "grace-ps1-markup-"));
    const file = path.join(root, "scripts", "Publish.ps1");
    const text = `# START_MODULE_CONTRACT
# PURPOSE: Publish the release artifacts.
# SCOPE: PowerShell fixture without a language adapter.
# DEPENDS: none
# LINKS: M-EXAMPLE
# ROLE: SCRIPT
# MAP_MODE: LOCALS
# END_MODULE_CONTRACT
# START_MODULE_MAP
# Publish-Artifacts - Copy artifacts to the release share.
# END_MODULE_MAP
function Publish-Artifacts {
  Write-Output 'published'
}
`;
    const analysis = analyzeGovernedFile(root, file, text);
    expect(analysis.record.moduleContract?.fields.PURPOSE).toBe("Publish the release artifacts.");
    expect(analysis.record.linkedModuleIds).toEqual(["M-EXAMPLE"]);
    expect(analysis.language).toBeNull();
    expect(analysis.issues.filter((issue) => issue.severity === "error")).toHaveLength(0);
  });
});

describe("code file collection", () => {
  it("collects newly recognized sources while skipping unrecognized extensions", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "grace-collect-"));
    mkdirSync(path.join(root, "src"), { recursive: true });
    for (const relative of ["src/main.c", "src/main.h", "src/util.cpp", "src/util.hpp", "src/Store.cs", "src/Build.ps1", "src/Helpers.psm1", "src/Module.psd1", "src/notes.txt", "README.md"]) {
      writeFileSync(path.join(root, relative), "\n");
    }

    const collected = collectCodeFiles(root, []).map((file) => path.relative(root, file).replaceAll(path.sep, "/")).sort();

    expect(collected).toEqual(["src/Build.ps1", "src/Helpers.psm1", "src/Store.cs", "src/main.c", "src/main.h", "src/util.cpp", "src/util.hpp"]);
  });

  it("prunes .NET intermediate output while leaving bin to project configuration", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "grace-dotnet-collect-"));
    for (const relative of ["src/Store.cs", "src/obj/Debug/Store.AssemblyInfo.cs", "src/bin/Debug/Tool.cs"]) {
      mkdirSync(path.join(root, path.dirname(relative)), { recursive: true });
      writeFileSync(path.join(root, relative), "\n");
    }

    const withDefaults = collectCodeFiles(root, []).map((file) => path.relative(root, file).replaceAll(path.sep, "/")).sort();
    expect(withDefaults).toEqual(["src/Store.cs", "src/bin/Debug/Tool.cs"]);

    const withBinIgnored = collectCodeFiles(root, ["bin"]).map((file) => path.relative(root, file).replaceAll(path.sep, "/"));
    expect(withBinIgnored).toEqual(["src/Store.cs"]);
  });
});

describe("unreadable directory walking", () => {
  const permissionsUnsupported = process.platform === "win32" || process.getuid?.() === 0;

  it("describes walk failures with the directory and errno code", () => {
    const errno = Object.assign(new Error("EPERM: operation not permitted"), { code: "EACCES" });
    expect(describeUnreadableDirectory("/project/blocked", errno)).toBe(
      "Directory '/project/blocked' could not be listed (EACCES); its contents were not checked.",
    );
    expect(describeUnreadableDirectory("/project/blocked", new Error("boom"))).toBe(
      "Directory '/project/blocked' could not be listed (unknown); its contents were not checked.",
    );
  });

  it.skipIf(permissionsUnsupported)("skips unreadable directories instead of throwing", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "grace-walk-"));
    writeFileSync(path.join(root, "visible.ts"), "export const visible = true;\n");
    mkdirSync(path.join(root, "readable"));
    writeFileSync(path.join(root, "readable", "other.ts"), "export const other = true;\n");
    mkdirSync(path.join(root, "blocked"));
    writeFileSync(path.join(root, "blocked", "hidden.ts"), "export const hidden = true;\n");
    chmodSync(path.join(root, "blocked"), 0o000);

    try {
      const reported: Array<{ directory: string; error: unknown }> = [];
      const files = collectCodeFiles(root, [], root, (directory, error) => reported.push({ directory, error }));

      expect(files.sort()).toEqual([path.join(root, "readable", "other.ts"), path.join(root, "visible.ts")].sort());
      expect(reported).toHaveLength(1);
      expect(reported[0]?.directory).toBe(path.join(root, "blocked"));

      // Without a handler the walk still must not abort.
      expect(collectCodeFiles(root, []).sort()).toEqual([path.join(root, "readable", "other.ts"), path.join(root, "visible.ts")].sort());
    } finally {
      chmodSync(path.join(root, "blocked"), 0o755);
    }
  });

  it.skipIf(permissionsUnsupported)("still throws nothing for readable roots when a handler is attached", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "grace-walk-ok-"));
    mkdirSync(path.join(root, "src"));
    writeFileSync(path.join(root, "src", "example.ts"), "export const example = true;\n");

    const reported: string[] = [];
    const files = collectCodeFiles(root, [], root, (directory) => reported.push(directory));

    expect(files).toEqual([path.join(root, "src", "example.ts")]);
    expect(reported).toEqual([]);
  });
});

describe("default ignored directories", () => {
  const defaultIgnored = [
    ".git", ".svn", ".hg",
    "node_modules", "dist", "build", "coverage", ".next", ".nuxt", ".output", "out", ".turbo",
    ".vite", ".parcel-cache", ".svelte-kit", ".astro", "storybook-static", ".cache", ".yarn",
    ".nyc_output", "bower_components", "jspm_packages", ".stryker-tmp", ".serverless",
    ".docusaurus",
    "__pycache__", "venv", ".venv", ".tox", ".nox", ".pytest_cache", ".mypy_cache", ".ruff_cache",
    ".pyre", ".pytype", "htmlcov", ".eggs", ".hypothesis", ".ipynb_checkpoints", "__pypackages__",
    ".pixi", "cover",
    "test-results", "test-reports", "playwright-report", "blob-report", "allure-results",
    "allure-report", "test-output", "newman", "cucumber-report", "cucumber-reports",
    "target", ".gradle", ".idea",
    "vendor",
    ".build", "Pods", "Carthage", "DerivedData",
    ".dart_tool",
    "tmp", ".bundle",
    ".vscode",
  ];

  it("prunes well-known ecosystem directories by default", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "grace-ignore-"));
    for (const dir of defaultIgnored) {
      mkdirSync(path.join(root, dir));
      writeFileSync(path.join(root, dir, "generated.ts"), "export const generated = true;\n");
    }
    writeFileSync(path.join(root, "source.ts"), "export const source = true;\n");

    expect(collectCodeFiles(root, [])).toEqual([path.join(root, "source.ts")]);
  });

  it("prunes default-ignored names at any depth", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "grace-ignore-depth-"));
    mkdirSync(path.join(root, "src", "__pycache__"), { recursive: true });
    writeFileSync(path.join(root, "src", "__pycache__", "cached.ts"), "export const cached = true;\n");
    writeFileSync(path.join(root, "src", "main.ts"), "export const main = true;\n");

    expect(collectCodeFiles(root, [])).toEqual([path.join(root, "src", "main.ts")]);
  });
});

describe("cache skipping is scoped to Go's degradation, not to heuristic confidence", () => {
  const hasPython = ["python3", "python"].some((binary) => {
    const probe = spawnSync(binary, ["--version"], { stdio: "ignore" });
    return !probe.error && probe.status === 0;
  });

  test.skipIf(!hasPython)("a Python heuristic analysis is still written to the cache", () => {
    // REGRESSION GUARD, driven through analyzeGovernedFile rather than through
    // writeCachedAnalysis, so it actually exercises the skip decision. A first
    // version of this test called the cache directly and passed against the bug
    // it was meant to catch.
    //
    // An earlier fix skipped the cache for EVERY heuristic result, to stop Go's
    // degraded scan sticking after `go` is installed. Python and Dart report
    // heuristic confidence as a stable conclusion about the CONTENT - Python
    // when a file has no static __all__ - not because a toolchain was missing.
    // Skipping those made Dart pay a `dart run` per governed file on every
    // lint, where before it paid once.
    const cacheDir = mkdtempSync(path.join(os.tmpdir(), "grace-py-cache-scope-"));
    const previous = process.env.GRACE_CACHE_DIR;
    process.env.GRACE_CACHE_DIR = cacheDir;
    try {
      const root = mkdtempSync(path.join(os.tmpdir(), "grace-py-cache-root-"));
      mkdirSync(path.join(root, "src"), { recursive: true });
      const file = path.join(root, "src", "example.py");
      const text = `${contract("EXPORTS", "# greet - Greeting.").replaceAll("//", "#")}def greet():\n    return "hi"\n`;

      const analysis = analyzeGovernedFile(root, file, text);
      expect(analysis.language?.exportConfidence).toBe("heuristic");

      const written = readdirSync(cacheDir, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"));
      expect(written.length).toBeGreaterThan(0);
    } finally {
      if (previous === undefined) {
        delete process.env.GRACE_CACHE_DIR;
      } else {
        process.env.GRACE_CACHE_DIR = previous;
      }
      rmSync(cacheDir, { recursive: true, force: true });
    }
describe("symbol completeness (issue #9, Go exact backend only)", () => {
  test.skipIf(!hasGo)("flags a MODULE_MAP-named func with no doc comment as analysis.undocumented-symbol (warning)", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "grace-symbol-completeness-"));
    const file = path.join(root, "src", "example.go");
    const text = `${contract("EXPORTS", "// DoWork - performs the work.")}package example

func DoWork() int {
	return compute()
}
`;

    const analysis = analyzeGovernedFile(root, file, text);
    const finding = analysis.issues.find((issue) => issue.code === "analysis.undocumented-symbol");
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe("warning");
    expect(analysis.issues.map((issue) => issue.code)).not.toContain("analysis.stub-implementation");
  });

  test.skipIf(!hasGo)("flags a MODULE_MAP-named func with an unambiguous stub body as analysis.stub-implementation (warning)", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "grace-symbol-completeness-"));
    const file = path.join(root, "src", "example.go");
    const text = `${contract("EXPORTS", "// NotDone - performs the work.")}package example

// NotDone performs the work.
func NotDone() {
	panic("TODO")
}
`;

    const analysis = analyzeGovernedFile(root, file, text);
    const finding = analysis.issues.find((issue) => issue.code === "analysis.stub-implementation");
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe("warning");
    expect(analysis.issues.map((issue) => issue.code)).not.toContain("analysis.undocumented-symbol");
  });

  test.skipIf(!hasGo)("does not flag a documented, fully-implemented func named in MODULE_MAP", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "grace-symbol-completeness-"));
    const file = path.join(root, "src", "example.go");
    const text = `${contract("EXPORTS", "// Add - adds two numbers.")}package example

// Add returns the sum of a and b.
func Add(a, b int) int {
	return a + b
}
`;

    const analysis = analyzeGovernedFile(root, file, text);
    const codes = analysis.issues.map((issue) => issue.code);
    expect(codes).not.toContain("analysis.undocumented-symbol");
    expect(codes).not.toContain("analysis.stub-implementation");
  });

  test.skipIf(!hasGo)("credits a START_CONTRACT: <name> block as documentation even when it is not adjacent to the declaration", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "grace-symbol-completeness-"));
    const file = path.join(root, "src", "example.go");
    const text = `${contract("EXPORTS", "// DoWork - performs the work.")}package example

// START_CONTRACT: DoWork
//   PURPOSE: Perform the work.
// END_CONTRACT: DoWork
// START_CONTRACT: Unrelated
//   PURPOSE: Something else entirely.
// END_CONTRACT: Unrelated
func Unrelated() {}

func DoWork() int {
	return compute()
}
`;

    const analysis = analyzeGovernedFile(root, file, text);
    const codes = analysis.issues.map((issue) => issue.code);
    expect(codes).not.toContain("analysis.undocumented-symbol");
  });

  test.skipIf(!hasGo)("resolves a dotted Type.Method MODULE_MAP entry to the real method declaration and checks it", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "grace-symbol-completeness-"));
    const file = path.join(root, "src", "example.go");
    const text = `${contract(
      "EXPORTS",
      "// AccountsHandler - the handler\n// AccountsHandler.List - GET /api/accounts/:id: one account's config",
    )}package example

type AccountsHandler struct{}

func (h *AccountsHandler) List() {
	panic("not implemented")
}
`;

    const analysis = analyzeGovernedFile(root, file, text);
    const stubFinding = analysis.issues.find((issue) => issue.code === "analysis.stub-implementation");
    const docFinding = analysis.issues.find((issue) => issue.code === "analysis.undocumented-symbol");
    expect(stubFinding).toBeDefined();
    expect(stubFinding?.message).toContain("AccountsHandler.List");
    expect(docFinding).toBeDefined();
    expect(docFinding?.message).toContain("AccountsHandler.List");
  });

  test.skipIf(!hasGo)("a dotted Type.Method entry pointing at a documented, real method is not flagged", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "grace-symbol-completeness-"));
    const file = path.join(root, "src", "example.go");
    const text = `${contract(
      "EXPORTS",
      "// AccountsHandler - the handler\n// AccountsHandler.List - GET /api/accounts/:id: one account's config",
    )}package example

type AccountsHandler struct{}

// List returns one account's config.
func (h *AccountsHandler) List() {
	h.render()
}
`;

    const analysis = analyzeGovernedFile(root, file, text);
    const codes = analysis.issues.map((issue) => issue.code);
    expect(codes).not.toContain("analysis.undocumented-symbol");
    expect(codes).not.toContain("analysis.stub-implementation");
  });

  test("no-ops when language.symbolDetails is absent (e.g. TypeScript files)", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "grace-symbol-completeness-ts-"));
    const file = path.join(root, "src", "example.ts");
    const text = `${contract("EXPORTS", "// value - Runtime value.")}export const value = 1;\n`;

    const analysis = analyzeGovernedFile(root, file, text);
    const codes = analysis.issues.map((issue) => issue.code);
    expect(codes).not.toContain("analysis.undocumented-symbol");
    expect(codes).not.toContain("analysis.stub-implementation");
  });
});

describe("MODULE_MAP entry recognition and duplicate detection, issue #16", () => {
  const header = `// START_MODULE_CONTRACT
// PURPOSE: Exercise entry recognition.
// SCOPE: Test-only fixture.
// DEPENDS: none
// LINKS: M-EXAMPLE
// ROLE: SCRIPT
// MAP_MODE: LOCALS
// END_MODULE_CONTRACT
// START_MODULE_MAP`;

  function analyze(mapLines: string, body: string) {
    const root = mkdtempSync(path.join(os.tmpdir(), "grace-entry-recognition-"));
    const file = path.join(root, "example.ts");
    return analyzeGovernedFile(root, file, `${header}\n${mapLines}\n// END_MODULE_MAP\n${body}`);
  }

  it("flags a duplicated dotted Type.Method entry", () => {
    // extractMapEntrySymbolNames returns [] for dotted entries by design, so
    // these contributed nothing to the tally and shipped lint-clean - the same
    // add/add-merge artifact the duplicate check exists to catch, on a
    // recognised entry form.
    const issues = analyze(
      "//   Store.Get - reads one row.\n//   Store.Get - reads one row, again.",
      "function unrelated() {}\n",
    ).issues;

    const duplicates = issues.filter((issue) => issue.code === "markup.duplicate-module-map-entry");
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]?.message).toContain("Store.Get");
  });

  it("does not flag two DIFFERENT dotted methods on the same type", () => {
    // Negative control: the tally keys on the whole dotted name, not the type.
    const issues = analyze(
      "//   Store.Get - reads one row.\n//   Store.Put - writes one row.",
      "function unrelated() {}\n",
    ).issues;

    expect(issues.map((issue) => issue.code)).not.toContain("markup.duplicate-module-map-entry");
  });

  it("reads a colon-form entry as its own entry, not as the previous one's wrap", () => {
    // validateMapShape sanctions `symbol: description`, so parseListSection must
    // agree. While it recognised only " - ", a colon-form line was folded into
    // the previous entry's label and never became an item at all.
    const record = analyze(
      "//   first - the first entry.\n//   second: the second entry.",
      "function unrelated() {}\n",
    ).record;

    expect(record.moduleMap.map((item) => item.symbolName)).toEqual(["first", "second"]);
  });

  it("still folds a genuinely wrapped description into the previous entry", () => {
    // Negative control for the change above: a continuation carries no
    // separator, so it must NOT be promoted to an entry.
    const record = analyze(
      "//   only - a description that runs on and\n//     wraps onto a second line",
      "function unrelated() {}\n",
    ).record;

    expect(record.moduleMap).toHaveLength(1);
    expect(record.moduleMap[0]?.label).toContain("wraps onto a second line");
  });
});
