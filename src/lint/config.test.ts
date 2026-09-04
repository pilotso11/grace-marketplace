import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";

import { loadGraceLintConfig } from "./config";

function withConfig(contents: string) {
  const root = mkdtempSync(path.join(os.tmpdir(), "grace-lint-config-"));
  writeFileSync(path.join(root, ".grace-lint.json"), contents, "utf8");
  return loadGraceLintConfig(root);
}

describe("maxMapEntryWords validation", () => {
  it("accepts a positive integer and returns it", () => {
    const { config, issues } = withConfig(`{"maxMapEntryWords": 12}`);
    expect(config?.maxMapEntryWords).toBe(12);
    expect(issues).toHaveLength(0);
  });

  it("accepts the key being absent", () => {
    const { config, issues } = withConfig(`{"ignoredDirs": ["generated"]}`);
    expect(config?.maxMapEntryWords).toBeUndefined();
    expect(issues).toHaveLength(0);
  });

  it("rejects zero, negatives, fractions, and non-numbers", () => {
    // Zero would silence the rule entirely while looking like configuration
    // rather than suppression, and a fraction cannot be a word count.
    for (const value of ["0", "-1", "2.5", `"8"`, "null", "[]"]) {
      const { issues } = withConfig(`{"maxMapEntryWords": ${value}}`);
      const codes = issues.map((issue) => issue.code);
      expect(codes).toContain("config.invalid-max-map-entry-words");
    }
  });

  it("reports its own code, not the whole-file shape error", () => {
    // config.invalid-shape's guide says ".grace-lint.json must be a JSON
    // object" and tells the reader to replace the file contents - misdirection
    // for a file that parses fine and has one unusable value.
    const { issues } = withConfig(`{"maxMapEntryWords": 0}`);
    expect(issues.map((issue) => issue.code)).not.toContain("config.invalid-shape");
  });

  it("is a supported key, so it does not trip the unknown-key check", () => {
    const { issues } = withConfig(`{"maxMapEntryWords": 8}`);
    expect(issues.map((issue) => issue.code)).not.toContain("config.unknown-key");
  });
});
