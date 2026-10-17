import {
  classId,
  type Edge,
  type Extractor,
  type ExtractorContext,
  type ExtractorResult,
  type Node,
  type ReportEntry,
  withCollisionSuffix,
} from "@srcatlas/core";
import type { Project } from "ts-morph";
import {
  followModuleCall,
  isThirdPartyCall,
  type ModuleInfo,
  readModules,
} from "./modules.js";
import { buildProviders } from "./provider-graph.js";

const NAME = "nestjs";
const DEPENDENCIES = ["dependencies", "devDependencies", "peerDependencies"];

const byCodeUnit = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;

/** nestjs.md 1.3: runs when `@nestjs/core` or `@nestjs/common` is a dependency. */
function detect(packageJson: Record<string, unknown> | null): boolean {
  return DEPENDENCIES.some((field) => {
    const deps = packageJson?.[field];
    return (
      typeof deps === "object" &&
      deps !== null &&
      ("@nestjs/core" in deps || "@nestjs/common" in deps)
    );
  });
}

const dirOf = (file: string): string => file.slice(0, file.lastIndexOf("/"));

function extract(ctx: ExtractorContext<Project>): ExtractorResult {
  const pkg = ctx.package.name;
  const modules = readModules(ctx.project, ctx);

  // Section 5.2: equal names in one package get the directory as a suffix, on both.
  const ids = withCollisionSuffix(
    modules.map((m) => ({
      id: classId("module", pkg, m.name),
      dir: dirOf(m.file),
    })),
  );
  const idOf = new Map<string, string>();
  modules.forEach((m, i) => {
    idOf.set(`${m.file}#${m.name}`, ids[i] ?? "");
  });

  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const report: ReportEntry[] = [];
  let thirdParty = 0;

  modules.forEach((m: ModuleInfo, i) => {
    const id = ids[i] ?? "";
    let unresolved = m.unresolved;
    const unresolvedAt = [...m.problems];
    const reexports = new Set<string>();

    for (const ref of m.imports) {
      // N-M5: a call to a static factory of a module class stands for that class.
      const followed =
        ref.result.kind === "unresolved"
          ? followModuleCall(ref.result.node, ctx)
          : ref.result;
      const r = followed.kind === "class" ? followed : ref.result;
      if (r.kind === "class") {
        const to = idOf.get(`${r.file}#${r.name}`);
        // A class without @Module is not a module: nothing to point at.
        if (to && to !== id) {
          edges.push({
            from: id,
            to,
            kind: "imports",
            sites: [ref.site],
            extractor: NAME,
            confidence: "certain",
            meta: {},
          });
        }
      } else if (r.kind === "external" || isThirdPartyCall(r.node, ctx)) {
        thirdParty++; // N-M9: counted, no node, no entry
      } else {
        unresolved = true;
        unresolvedAt.push(ref.site);
      }
    }

    for (const ref of m.exports) {
      const r = ref.result;
      const to =
        r.kind === "class" ? idOf.get(`${r.file}#${r.name}`) : undefined;
      if (to) reexports.add(to); // N-M8; exports of providers come with the provider pattern
    }

    for (const site of unresolvedAt) {
      report.push({
        level: "warning",
        code: "nest.unresolved-dynamic-module",
        message: `module ${m.name}: metadata could not be evaluated statically`,
        extractor: NAME,
        site,
      });
    }

    nodes.push({
      id,
      kind: "module",
      name: m.name,
      language: "typescript",
      framework: "nestjs",
      package: `package:${pkg}`,
      module: null,
      source: { file: m.file, line: m.line },
      extractor: NAME,
      confidence: unresolved ? "unresolved" : "certain",
      meta: {
        dynamic: m.dynamic,
        global: m.global,
        ...(reexports.size > 0
          ? { "nestjs.reexports": [...reexports].sort(byCodeUnit) }
          : {}),
      },
    });
  });

  const importsOf = new Map<string, string[]>();
  for (const e of edges) {
    if (e.kind === "imports") {
      importsOf.set(e.from, [...(importsOf.get(e.from) ?? []), e.to]);
    }
  }
  const providers = buildProviders({
    pkg,
    project: ctx.project,
    ctx,
    modules,
    moduleIds: ids,
    importsOf,
  });
  nodes.push(...providers.nodes);
  edges.push(...providers.edges);
  report.push(...providers.report);

  const summary: Record<string, number> = { ...providers.summary };
  if (thirdParty > 0) summary["nest.ignored-third-party-modules"] = thirdParty;

  return {
    nodes,
    edges,
    facts: [],
    report,
    ...(Object.keys(summary).length > 0 ? { summary } : {}),
  };
}

export const nestjsExtractor: Extractor<Project> = {
  name: NAME,
  detect,
  extract,
};
