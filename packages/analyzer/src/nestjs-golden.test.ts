import { readFileSync } from "node:fs";
import { join } from "node:path";
import { analyzeTwice, fixturePath, goldenPair } from "@srcatlas/core/testing";
import { describe, expect, it } from "vitest";
import { analyzeRepo } from "./analyze-repo.js";
import { builtinExtractors } from "./registry.js";
import { runPackage } from "./run-package.js";

// CLAUDE.md section 8: golden files are written by hand from docs/extractors/nestjs.md and
// reviewed, never regenerated from extractor output. Decoys in each fixture must produce nothing.

const FIXTURES = [
  "nest-basic",
  "nest-modules",
  "nest-dynamic",
  "nest-di-custom",
  "nest-di-resolution",
];

// Runs in this thread: the worker file only exists after a build.
const run = (task: Parameters<typeof runPackage>[0]) =>
  runPackage(task, builtinExtractors);

const analyze = (root: string) =>
  analyzeRepo(root, {}, { generatorVersion: "0.0.0", run });

describe.each(FIXTURES)("%s", (name) => {
  const dir = fixturePath(name);

  it("matches the hand-written golden graph", async () => {
    const { graph } = await analyze(dir);
    const { expected, actual } = goldenPair(dir, graph);
    expect(actual).toBe(expected);
  });

  it("matches the expected report: codes, levels, sites and summary counters", async () => {
    const { report } = await analyze(dir);
    const expected = JSON.parse(
      readFileSync(join(dir, "expected.report.json"), "utf8"),
    );
    expect({
      entries: report.entries.map((e) => ({
        code: e.code,
        level: e.level,
        ...(e.site ? { site: e.site } : {}),
      })),
      summary: report.summary,
    }).toEqual(expected);
  });

  it("is byte-identical when analysed from different directories", async () => {
    const [a, b] = await analyzeTwice(
      dir,
      async (root) => (await analyze(root)).graph,
    );
    expect(a).toBe(b);
  });
});
