import type { LintIssue } from "./types";

type LintIssueGuide = {
  code: string;
  title: string;
  explanation: string;
  remediation: string[];
};

const EXACT_GUIDES: Record<string, Omit<LintIssueGuide, "code">> = {
  "config.invalid-json": {
    title: "Invalid Lint Config JSON",
    explanation: "The repository-level .grace-lint.json file could not be parsed as JSON.",
    remediation: ["Fix the JSON syntax in .grace-lint.json.", "If the file is accidental, remove it."],
  },
  "config.invalid-shape": {
    title: "Invalid Lint Config Shape",
    explanation: ".grace-lint.json must be a JSON object.",
    remediation: ["Replace the file contents with a JSON object.", "Keep only supported keys like ignoredDirs."],
  },
  "config.unknown-key": {
    title: "Unknown Lint Config Key",
    explanation: ".grace-lint.json contains a key the CLI does not understand.",
    remediation: ["Remove unsupported keys from .grace-lint.json.", "Use only documented keys such as ignoredDirs."],
  },
  "config.invalid-max-map-entry-words": {
    title: "Invalid maxMapEntryWords",
    explanation:
      "`maxMapEntryWords` in .grace-lint.json sets the word budget for a MODULE_MAP entry's description, so it must be a positive integer. The file itself parsed fine; only this value is unusable.",
    remediation: [
      "Set maxMapEntryWords to a positive integer, or remove it to take the default.",
      "A larger value buys headroom during a migration; a smaller one tightens the index.",
    ],
  },
  "markup.map-entry-too-long": {
    title: "MODULE_MAP Entry Too Long",
    explanation:
      "A MODULE_MAP entry is an index a reader uses to find a symbol, not documentation. Detail a reader must act on belongs in the symbol's own doc comment, which sits next to the code and moves with it.",
    remediation: [
      "Cut the entry to a short role: what the symbol is for, not how it behaves.",
      "Move conditions, guarantees, reasons and measurements into the symbol's doc comment.",
      "Do not restate the doc comment; one fact, one home.",
    ],
  },
  "analysis.adapter-failed": {
    title: "Language Adapter Failed",
    explanation: "The file-level export analysis adapter failed, so exact export/local parity could not be validated for this governed file.",
    remediation: ["Inspect the file for unusual syntax or unsupported language features.", "Simplify the export surface or improve the adapter if this language pattern should be supported."],
  },
  "analysis.runtime-missing": {
    title: "Language Runtime Missing",
    explanation: "The governed file uses a language adapter that requires its language runtime on PATH. GRACE fails closed instead of silently dropping export/local parity checks.",
    remediation: ["Install the runtime named in the issue message and ensure it is available on PATH.", "If the file should not be governed in this environment, exclude it explicitly rather than relying on incomplete analysis."],
  },
  "walk.unreadable-directory": {
    title: "Unreadable Directory Skipped",
    explanation: "A directory could not be listed while walking the project, so the files inside it were not checked. This usually means restrictive permissions or a leftover sandbox directory; it does not make the GRACE project itself invalid.",
    remediation: ["Restore read permission on the directory if it should be governed.", "If the directory is build output or a sandbox leftover, add it to ignoredDirs in .grace-lint.json or remove it."],
  },
  "scope.durable-overlap": {
    title: "Durable Scope Overlap",
    explanation: "Two or more active change scopes claim overlapping durable regions, which creates a data-contention risk if executed in parallel.",
    remediation: ["Review the overlapping durable scopes and decide whether they must be sequential or whether the overlap is acceptable.", "Treat durable overlap as a planning warning, not a blocker."],
  },
  "scope.observed-write-overlap": {
    title: "Observed Write Overlap",
    explanation: "Two or more active change scopes write to overlapping regions, which can cause unsafe concurrent execution.",
    remediation: ["Do not run overlapping observed writes in parallel-safe mode.", "Sequence the changes or split scopes to eliminate the overlap."],
  },
  "change.superseded-missing-replacement": {
    title: "Superseded Change Missing Replacement Reference",
    explanation: "A GraceChangeSpec or GraceChangePlan with status='superseded' should name the replacement C-* anchor via a <Replacement> or <ReplacementChange> child tag.",
    remediation: ["Add a <Replacement>C-REPLACEMENT-ID</Replacement> child to the superseded wrapper.", "Or add a direct <C-REPLACEMENT-ID /> child tag as the replacement reference."],
  },
  "analysis.undocumented-symbol": {
    title: "Undocumented MODULE_MAP Symbol",
    explanation: "A symbol named in a MODULE_MAP entry has no doc comment on its own declaration. It may be documented in the MODULE_MAP table of contents, but not where the declaration itself lives.",
    remediation: ["Add a doc comment directly above the symbol's declaration.", "Keep the MODULE_MAP description too — this check only requires a doc comment to exist, not that it repeat the same words."],
  },
  "analysis.stub-implementation": {
    title: "MODULE_MAP Symbol Is An Unimplemented Stub",
    explanation: "A symbol named in a MODULE_MAP entry has an unambiguous stub body: empty, a bare panic(...) call, or a bare return/return nil and nothing else.",
    remediation: ["Implement the symbol, or remove the MODULE_MAP entry until it is implemented.", "If the stub is intentional (e.g. a work-in-progress interface seam), track it outside MODULE_MAP so this warning does not mask real drift elsewhere."],
  },
  "assertion.phase-incompatible-command": {
    title: "Phase-Incompatible Assertion Command",
    explanation: "A target command assertion invokes current-mode lifecycle lint. Current mode evaluates active approved baselines, so it is a pre-implementation check and cannot serve as target or final evidence after writes begin.",
    remediation: ["Keep MustPassCommand entries as leaf project evidence such as tests, typecheck, build, format, or package checks.", "Run selected target or final GRACE lint as the outer execution gate instead of nesting it inside the plan."],
  },
};

const PREFIX_GUIDES: Array<{ prefix: string; title: string; explanation: string; remediation: string[] }> = [
  {
    prefix: "project.",
    title: "GRACE 4 Project Detection Issue",
    explanation: "The CLI could not identify a valid GRACE 4 .grace project state, or it detected legacy GRACE 3 artifacts instead.",
    remediation: ["Run $grace-init for a new GRACE 4 project or $grace-migrate for legacy GRACE 3 projects.", "Do not rely on dual-mode docs/*.xml validation."],
  },
  {
    prefix: "artifact.",
    title: "GRACE 4 Artifact Grammar Issue",
    explanation: "A .grace XML artifact violates the GRACE 4 root, metadata, version, or semantic-anchor grammar.",
    remediation: ["Use approved GRACE 4 root tags with graceVersion=\"4.0\".", "Keep semantic anchors as XML tags, never attributes."],
  },
  {
    prefix: "change.",
    title: "GRACE 4 Change Lifecycle Issue",
    explanation: "A change spec or plan has an invalid status, wrapper shape, or active/archive location for the GRACE 4 lifecycle.",
    remediation: ["Keep draft and approved bundles under .grace/changes/active.", "Move applied, rejected, cancelled, or superseded bundles to archive with matching statuses."],
  },
  {
    prefix: "context.",
    title: "GRACE 4 Context Artifact Issue",
    explanation: "A required .grace/context artifact is missing, has the wrong root, or has invalid applicability metadata.",
    remediation: ["Create all five context artifacts from the GRACE 4 init template.", "If deployment or UX is not applicable, include a concrete reason."],
  },
  {
    prefix: "projection.",
    title: "GRACE 4 Projection Integrity Issue",
    explanation: "Graph or verification index routes do not match the logical projection built from .grace documents.",
    remediation: ["Synchronize GD-* and VD-* index ownership with document wrappers.", "Ensure every M-* has deterministic V-M-* coverage."],
  },
  {
    prefix: "assertion.",
    title: "GRACE 4 Assertion Failure",
    explanation: "A BaselineAssertions or TargetAssertions entry failed against current graph, verification, or filesystem state.",
    remediation: ["Reconcile the current state with the approved plan assertions.", "If the approved plan is stale, supersede and replan rather than editing it silently."],
  },
  {
    prefix: "scope.",
    title: "GRACE 4 Scope Conflict",
    explanation: "Active change scopes overlap in durable or observed write surfaces.",
    remediation: ["Treat durable overlap as a planning warning.", "Do not run overlapping observed writes in parallel-safe mode."],
  },
  {
    prefix: "xml.generic-",
    title: "Generic XML Tag Used Instead Of Unique GRACE Tag",
    explanation: "GRACE shared artifacts rely on unique ID-based XML tags such as M-*, Phase-*, and step-* so agents can reference them deterministically.",
    remediation: ["Replace the generic XML tag with the corresponding unique GRACE tag.", "Keep the unique tag and any verification-ref/module references synchronized across shared artifacts."],
  },
  {
    prefix: "markup.",
    title: "Semantic Markup Integrity Issue",
    explanation: "The governed file markup is incomplete, mismatched, or out of sync with the intended export or local symbol surface.",
    remediation: ["Repair the MODULE_CONTRACT, MODULE_MAP, CHANGE_SUMMARY, or semantic block markers in the file.", "Keep file-local markup aligned with the actual code surface and semantic block boundaries."],
  },
  {
    prefix: "graph.",
    title: "Knowledge Graph Drift",
    explanation: "The .grace/graph index references modules or entries that do not align with the current verification or filesystem state.",
    remediation: ["Synchronize GD-* index entries with the actual .grace/graph documents.", "Run $grace-refresh if the drift came from real code changes."],
  },
  {
    prefix: "plan.",
    title: "Change Plan Drift",
    explanation: "A GraceChangePlan is missing assertions, scopes, or verification refs needed for governed execution.",
    remediation: ["Update the GraceChangeSpec and GraceChangePlan so modules, assertions, and verification refs match the current .grace state.", "Use $grace-spec or $grace-plan when the architecture changed."],
  },
  {
    prefix: "analysis.",
    title: "Export Surface Analysis Warning",
    explanation: "The language adapter could not prove the exact export surface or detected a shape that weakens precise linting.",
    remediation: ["Prefer clearer export declarations or explicit ROLE/MAP_MODE overrides when necessary.", "Treat heuristic or wildcard-export warnings as cues to simplify or document the file surface."],
  },
];

function toTitleFromCode(code: string) {
  return code
    .split(/[.-]/g)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function getLintIssueGuide(code: string): LintIssueGuide {
  const exact = EXACT_GUIDES[code];
  if (exact) {
    return { code, ...exact };
  }

  const prefixGuide = PREFIX_GUIDES.find((guide) => code.startsWith(guide.prefix));
  if (prefixGuide) {
    return { code, ...prefixGuide };
  }

  return {
    code,
    title: toTitleFromCode(code),
    explanation: "This issue code does not yet have a dedicated explanation entry, but it still signals drift or missing governance metadata.",
    remediation: ["Inspect the issue message and the referenced file.", "Repair the smallest relevant GRACE artifact or governed file section before rerunning lint."],
  };
}

export function withLintIssueGuide(issue: LintIssue): LintIssue {
  const guide = getLintIssueGuide(issue.code);
  return {
    ...issue,
    title: guide.title,
    explanation: guide.explanation,
    remediation: guide.remediation,
  };
}

export function formatLintExplanation(code: string) {
  const guide = getLintIssueGuide(code);
  return [
    "GRACE Lint Issue Guide",
    "======================",
    `Code: ${guide.code}`,
    `Title: ${guide.title}`,
    "",
    "Explanation",
    guide.explanation,
    "",
    "Remediation",
    ...guide.remediation.map((item) => `- ${item}`),
  ].join("\n");
}
