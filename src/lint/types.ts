export type LintSeverity = "error" | "warning";

export type LintProfile = "standard";

/** Selected assertion section evaluated by grace lint. */
export type LintAssertionMode = "current" | "baseline" | "target" | "final";

export type ModuleRole = "RUNTIME" | "TEST" | "BARREL" | "CONFIG" | "TYPES" | "SCRIPT";
export type MapMode = "EXPORTS" | "LOCALS" | "SUMMARY" | "NONE";

export type LintIssue = {
  severity: LintSeverity;
  code: string;
  file: string;
  line?: number;
  message: string;
  title?: string;
  explanation?: string;
  remediation?: string[];
};

/** Machine-readable evidence for one --run-commands execution entry. */
export type CommandEvidence = {
  index: number;
  command: string;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  skipped: boolean;
  logFile: string | null;
};

export type LintResult = {
  schemaVersion: string;
  tool: "grace-lint";
  generatedAt: string;
  root: string;
  profile: LintProfile;
  assertionMode: LintAssertionMode;
  changeId?: string;
  commandsEnabled: boolean;
  /** Present when --run-commands executed at least one declared command. */
  commands?: CommandEvidence[];
  filesChecked: number;
  governedFiles: number;
  xmlFilesChecked: number;
  issues: LintIssue[];
  summary: {
    issues: number;
    errors: number;
    warnings: number;
  };
};

export type LintOptions = {
  profile?: LintProfile;
  assertionMode?: LintAssertionMode;
  changeId?: string;
  runCommands?: boolean;
  parallelPreflight?: boolean;
  /** Per-command timeout in ms for --run-commands; default 600000, 0 disables. */
  commandTimeoutMs?: number;
  /** Resolved by the CLI: compact for agents/pipes/json, live for interactive TTY. */
  commandVerbosity?: "compact" | "live";
  /** Progress sink for run-commands lines; default writes `[grace] ${line}` to process.stderr. */
  commandProgress?: (line: string) => void;
  /** Overrides the XDG cache root for run logs; used by tests and tools. */
  commandLogRoot?: string;
  /** Aborts a running command batch; the CLI wires SIGINT/SIGTERM here. */
  commandSignal?: AbortSignal;
};

export type GraceLintConfig = {
  ignoredDirs?: string[];
  /**
   * Word budget for a MODULE_MAP entry's description. Configurable because the
   * right number is house style, not a property of the format: a repo whose
   * maps are already terse may want it tighter, and one mid-migration may want
   * headroom rather than thousands of warnings it cannot act on yet.
   */
  maxMapEntryWords?: number;
};

export type MarkupSection = {
  content: string;
  startLine: number;
  endLine: number;
};

export type ModuleContractInfo = {
  fields: Record<string, string>;
  purpose?: string;
  scope?: string;
  depends?: string;
  links?: string;
  role?: ModuleRole;
  mapMode?: MapMode;
};

export type ModuleMapItem = {
  label: string;
  symbolName?: string;
  line: number;
};

export type LanguageAnalysis = {
  adapterId: string;
  exports: Set<string>;
  valueExports: Set<string>;
  typeExports: Set<string>;
  localSymbols: Set<string>;
  exportConfidence: "exact" | "heuristic";
  hasDefaultExport: boolean;
  hasWildcardReExport: boolean;
  hasMainEntrypoint: boolean;
  directReExportCount: number;
  localExportCount: number;
  localImplementationCount: number;
  usesTestFramework: boolean;
  /**
   * Per-symbol doc-comment/stub metadata, keyed by plain symbol name for
   * top-level funcs or "Type.Method" for methods (matching the MODULE_MAP
   * dotted-entry convention). Optional and additive: only the Go exact
   * go/ast backend populates this today (issue #9); every other adapter and
   * the Go heuristic fallback leave it undefined, and callers must treat
   * `undefined` as "no data available" rather than "nothing to report".
   */
  symbolDetails?: Map<string, { hasDocComment: boolean; isStub: boolean }>;
};

export type LanguageAdapter = {
  id: string;
  supports(filePath: string): boolean;
  analyze(filePath: string, text: string): LanguageAnalysis;
};

/** Actionable failure raised when an optional language runtime is unavailable. */
export class LanguageRuntimeMissingError extends Error {
  readonly adapterId: string;
  readonly runtimeCandidates: string[];

  constructor(adapterId: string, runtimeCandidates: string[], message: string) {
    super(message);
    this.name = "LanguageRuntimeMissingError";
    this.adapterId = adapterId;
    this.runtimeCandidates = runtimeCandidates;
  }
}
