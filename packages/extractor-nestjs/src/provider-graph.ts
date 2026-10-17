import {
  classId,
  type Edge,
  type Node,
  type ReportEntry,
  type Site,
  withCollisionSuffix,
} from "@srcatlas/core";
import type { ClassDeclaration, Project } from "ts-morph";
import { type EvalContext, type Result, tokenKeyOf } from "./evaluate.js";
import { type ModuleInfo, siteOf } from "./modules.js";
import {
  isInjectable,
  type Role,
  readInjections,
  roleOf,
  type Scope,
  scopeOf,
} from "./providers.js";
import { buildTokenTable, type Resolution, resolveToken } from "./tokens.js";

// nestjs.md sections 3 and 4.2: provider nodes, their registrations in modules, and what they
// inject. Needs the module graph first: the injecting module decides how a token is resolved.

const NAME = "nestjs";
const FORMS = {
  useValue: "value",
  useClass: "class",
  useFactory: "factory",
  useExisting: "existing",
} as const;
type Form = keyof typeof FORMS;

interface Entry {
  form: Form;
  props: Record<string, Result>;
}

interface Registration {
  /** Index into the module list. */
  module: number;
  site: Site;
  /** Present for `{ provide, use... }`, absent for a class listed directly. */
  entry?: Entry;
}

interface ProviderNode {
  key: string;
  name: string;
  decl?: ClassDeclaration;
  classSite?: Site;
  regs: Registration[];
  /** Modules whose custom provider instantiates this class with `useClass`. */
  viaUseClass: Set<number>;
}

export interface ProviderGraph {
  nodes: Node[];
  edges: Edge[];
  report: ReportEntry[];
  summary: Record<string, number>;
}

const byCodeUnit = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;

const bySite = (a: Site, b: Site): number =>
  byCodeUnit(a.file, b.file) || a.line - b.line;

const dirOf = (file: string): string => file.slice(0, file.lastIndexOf("/"));

/** The name a token is known by: the class, the string value, or the symbol constant. */
function tokenName(r: Result): string | undefined {
  switch (r.kind) {
    case "class":
    case "external":
    case "symbol":
      return r.name;
    case "string":
      return r.value;
    default:
      return undefined;
  }
}

/** Several modules can register a class; their answers are combined, never silently picked. */
function combine(results: Resolution[]): Resolution {
  const found = results.filter((r) => r.found);
  if (found.length === 0) {
    return results.find((r) => !r.found && r.code) ?? { found: false };
  }
  const first = found[0];
  if (found.length === 1 && first) return first;
  const providers = [
    ...new Set(found.flatMap((r) => (r.found ? r.providers : []))),
  ].sort(byCodeUnit);
  const agree = found.every(
    (r) =>
      r.found &&
      r.confidence === "certain" &&
      !r.code &&
      r.providers.join("\0") === providers.join("\0"),
  );
  const ambiguous =
    !agree && (found.some((r) => r.found && r.code) || providers.length > 1);
  return {
    found: true,
    step: first?.found ? first.step : "anywhere",
    providers,
    confidence: agree ? "certain" : "inferred",
    ...(ambiguous ? { code: "nest.ambiguous-token" as const } : {}),
  };
}

export function buildProviders(input: {
  pkg: string;
  project: Project;
  ctx: EvalContext;
  modules: ModuleInfo[];
  moduleIds: string[];
  importsOf: Map<string, string[]>;
}): ProviderGraph {
  const { pkg, project, ctx, modules, moduleIds, importsOf } = input;
  const report: ReportEntry[] = [];
  const summary: Record<string, number> = {};
  const nodes = new Map<string, ProviderNode>();

  const warn = (
    code: ReportEntry["code"],
    message: string,
    site: Site,
    level: ReportEntry["level"] = "warning",
  ) => {
    report.push({ level, code, message, extractor: NAME, site });
  };

  const classNode = (r: Extract<Result, { kind: "class" }>): ProviderNode => {
    let n = nodes.get(tokenKeyOf(r) ?? "");
    if (!n) {
      n = {
        key: tokenKeyOf(r) ?? "",
        name: r.name,
        decl: r.declaration,
        classSite: siteOf(r.declaration, ctx),
        regs: [],
        viaUseClass: new Set(),
      };
      nodes.set(n.key, n);
    }
    return n;
  };

  // Every @Injectable class is a provider node, registered or not (N-P11).
  for (const sf of project.getSourceFiles()) {
    for (const cls of sf.getClasses()) {
      const name = cls.getName();
      if (!name || !isInjectable(cls)) continue;
      classNode({
        kind: "class",
        name,
        file: ctx.relative(sf.getFilePath()),
        declaration: cls,
        node: cls,
      });
    }
  }

  // Registrations: classes listed in `providers` and `{ provide, use... }` entries.
  modules.forEach((m, idx) => {
    for (const ref of m.providers) {
      const r = ref.result;
      if (r.kind === "class") {
        classNode(r).regs.push({ module: idx, site: ref.site });
        continue;
      }
      if (r.kind === "external") continue; // third-party providers have no node in v1
      const provide = r.kind === "object" ? r.props.provide : undefined;
      const forms =
        r.kind === "object"
          ? (Object.keys(FORMS) as Form[]).filter((f) => f in r.props)
          : [];
      const key = provide ? tokenKeyOf(provide) : undefined;
      const form = forms.length === 1 ? forms[0] : undefined;
      if (r.kind !== "object" || !provide || !key || !form) {
        warn(
          "nest.unresolved-provider-token",
          `module ${m.name}: a provider could not be named statically`,
          ref.site,
        );
        continue;
      }
      let node: ProviderNode | undefined;
      if (provide.kind === "class") node = classNode(provide);
      else {
        node = nodes.get(key);
        if (!node) {
          node = {
            key,
            name: tokenName(provide) ?? key,
            regs: [],
            viaUseClass: new Set(),
          };
          nodes.set(key, node);
        }
      }
      node.regs.push({
        module: idx,
        site: ref.site,
        entry: { form, props: r.props },
      });
      const target = form === "useClass" ? r.props.useClass : undefined;
      if (target?.kind === "class") classNode(target).viaUseClass.add(idx);
    }
  });

  // Ids: the class or token name, with the directory on both when two nodes share a name.
  const ordered = [...nodes.values()].sort((a, b) => byCodeUnit(a.key, b.key));
  const sourceOf = (n: ProviderNode): Site =>
    n.classSite ??
    [...n.regs].map((r) => r.site).sort(bySite)[0] ?? { file: "", line: 1 };
  const idList = withCollisionSuffix(
    ordered.map((n) => ({
      id: classId("provider", pkg, n.name),
      dir: dirOf(sourceOf(n).file),
    })),
  );
  const idOfKey = new Map<string, string>();
  ordered.forEach((n, i) => {
    idOfKey.set(n.key, idList[i] ?? "");
  });
  const idOf = (n: ProviderNode): string => idOfKey.get(n.key) ?? "";

  const out: ProviderGraph = { nodes: [], edges: [], report, summary };

  // Nodes.
  for (const n of ordered) {
    const entries = n.regs
      .filter((r) => r.entry)
      .sort((a, b) => bySite(a.site, b.site));
    const injectable = n.decl ? isInjectable(n.decl) : false;
    const role: Role = n.decl
      ? injectable
        ? roleOf(n.decl)
        : entries.length > 0
          ? "service"
          : "other"
      : "service";
    let scope: Scope = "default";
    if (n.decl && injectable) {
      const s = scopeOf(n.decl, ctx);
      scope = s.scope;
      if (s.problem) {
        warn(
          "nest.unresolved-scope",
          `${n.name}: scope could not be evaluated statically`,
          s.problem,
          "info",
        );
      }
    }
    if (
      n.decl &&
      injectable &&
      n.regs.length === 0 &&
      n.viaUseClass.size === 0
    ) {
      warn(
        "nest.unregistered-provider",
        `${n.name} is not listed in any module`,
        sourceOf(n),
        "info",
      );
    }
    const owners = [...new Set(n.regs.map((r) => r.module))];
    const first = entries[0]?.entry;
    out.nodes.push({
      id: idOf(n),
      kind: "provider",
      name: n.name,
      language: "typescript",
      framework: "nestjs",
      package: `package:${pkg}`,
      module:
        owners.length === 1 && owners[0] !== undefined
          ? (moduleIds[owners[0]] ?? null)
          : null,
      source: sourceOf(n),
      extractor: NAME,
      confidence: "certain",
      meta: { providerType: first ? FORMS[first.form] : "class", role, scope },
    });
  }

  const edge = (
    kind: Edge["kind"],
    from: string,
    to: string,
    site: Site,
    confidence: Edge["confidence"] = "certain",
    meta: Edge["meta"] = {},
  ) => {
    if (from === to) return;
    out.edges.push({
      from,
      to,
      kind,
      sites: [site],
      extractor: NAME,
      confidence,
      meta,
    });
  };

  // contains / exports.
  modules.forEach((m, idx) => {
    const from = moduleIds[idx] ?? "";
    for (const n of ordered) {
      for (const reg of n.regs) {
        if (reg.module === idx) edge("contains", from, idOf(n), reg.site);
      }
    }
    for (const ref of m.exports) {
      const key = tokenKeyOf(ref.result);
      const target = key ? nodes.get(key) : undefined;
      if (target) edge("exports", from, idOf(target), ref.site);
    }
  });

  // Section 3.
  const table = buildTokenTable(
    modules.map((m, idx) => {
      const id = moduleIds[idx] ?? "";
      return {
        id,
        global: m.global,
        imports: importsOf.get(id) ?? [],
        providers: ordered.flatMap((n) =>
          n.regs
            .filter((r) => r.module === idx)
            .map(() => ({ token: n.key, provider: idOf(n) })),
        ),
      };
    }),
  );

  const inject = (
    from: string,
    token: Result,
    site: Site,
    contexts: string[],
  ): void => {
    const results = (contexts.length > 0 ? contexts : [""]).map((module) =>
      resolveToken(table, {
        token: tokenKeyOf(token),
        module,
        origin: token.kind === "external" ? "external" : "repo",
      }),
    );
    const res = combine(results);
    if (res.found) {
      const name = tokenName(token);
      const plain = token.kind === "class" || token.kind === "external";
      for (const to of res.providers) {
        edge(
          "injects",
          from,
          to,
          site,
          res.confidence,
          plain || !name ? {} : { tokens: [name] },
        );
      }
      if (res.code) {
        warn(
          res.code,
          `token ${name ?? "(unnamed)"} matches several providers`,
          site,
        );
      }
    } else if (res.code) {
      warn(
        res.code,
        `token ${tokenName(token) ?? "(unevaluable)"} has no provider`,
        site,
      );
    } else {
      summary["nest.ignored-third-party-injections"] =
        (summary["nest.ignored-third-party-injections"] ?? 0) + 1;
    }
  };

  for (const n of ordered) {
    const from = idOf(n);
    const contexts = [
      ...new Set([...n.regs.map((r) => r.module), ...n.viaUseClass]),
    ]
      .sort((a, b) => a - b)
      .map((i) => moduleIds[i] ?? "");

    // N-P2, N-P3, N-P5 to N-P7.
    if (n.decl && isInjectable(n.decl)) {
      for (const i of readInjections(n.decl, ctx))
        inject(from, i.token, i.site, contexts);
    }

    // N-P4: what each custom provider needs.
    for (const reg of n.regs) {
      if (!reg.entry) continue;
      const own = [moduleIds[reg.module] ?? ""];
      const { form, props } = reg.entry;
      if (form === "useClass") {
        const target = props.useClass;
        if (target?.kind === "class") {
          const t = nodes.get(tokenKeyOf(target) ?? "");
          if (t) edge("injects", from, idOf(t), siteOf(target.node, ctx));
        }
      } else if (form === "useFactory") {
        const list = props.inject;
        if (list?.kind === "array") {
          for (const item of list.items)
            inject(from, item, siteOf(item.node, ctx), own);
        }
      } else if (form === "useExisting") {
        const target = props.useExisting;
        if (target) inject(from, target, siteOf(target.node, ctx), own);
      }
    }
  }
  return out;
}
