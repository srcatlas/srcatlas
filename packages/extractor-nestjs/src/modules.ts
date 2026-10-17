import type { Site } from "@srcatlas/core";
import {
  type ClassDeclaration,
  type FunctionDeclaration,
  type MethodDeclaration,
  Node,
  type Project,
  SyntaxKind,
} from "ts-morph";
import { type EvalContext, evaluate, type Result, unwrap } from "./evaluate.js";
import { isFromModule } from "./origin.js";

const NEST_COMMON = "@nestjs/common";
const KEYS = ["imports", "controllers", "providers", "exports"] as const;
/** nestjs.md N-M5: helper functions followed from a static factory. */
const MAX_HELPER_HOPS = 2;

/** One element of a metadata array. `site` is the element, or the spread expression it came from. */
export interface ModuleRef {
  result: Result;
  site: Site;
}

export interface ModuleInfo {
  name: string;
  /** Repository-relative. */
  file: string;
  /** First decorator line of the class. */
  line: number;
  /** `@Global()` or a returned literal with `global: true`. */
  global: boolean;
  /** The class has a static factory that returns a dynamic module literal (N-M5). */
  dynamic: boolean;
  declaration: ClassDeclaration;
  imports: ModuleRef[];
  controllers: ModuleRef[];
  providers: ModuleRef[];
  exports: ModuleRef[];
  /** Sites where the metadata, or a whole key of it, could not be evaluated (N-M6, N-M7). */
  problems: Site[];
  /** True when `problems` is not empty. */
  unresolved: boolean;
}

type ObjectResult = Extract<Result, { kind: "object" }>;
type Callable = MethodDeclaration | FunctionDeclaration;

export function siteOf(node: Node, ctx: EvalContext): Site {
  return {
    file: ctx.relative(node.getSourceFile().getFilePath()),
    line: node.getStartLineNumber(),
  };
}

/** The one `return` expression of a function body; nested functions do not count. */
function soleReturn(fn: Callable): Node | undefined {
  const body = fn.getBody();
  if (!body || !Node.isBlock(body)) return undefined;
  const returns = body
    .getDescendantsOfKind(SyntaxKind.ReturnStatement)
    .filter((r) => r.getFirstAncestor(Node.isFunctionLikeDeclaration) === fn);
  return returns.length === 1 ? returns[0]?.getExpression() : undefined;
}

/**
 * N-M5: the object literal a function returns, either written there, held by a `const` in the
 * same function, or returned by a helper function of the repository (at most two hops).
 */
function returnedLiteral(
  fn: Callable,
  ctx: EvalContext,
  hops = 0,
): ObjectResult | undefined {
  const expr = soleReturn(fn);
  if (!expr) return undefined;
  const inner = unwrap(expr);
  if (Node.isCallExpression(inner)) {
    const callee = inner.getExpression();
    if (hops >= MAX_HELPER_HOPS || !Node.isIdentifier(callee)) return undefined;
    const symbol = callee.getSymbol();
    const decl = (
      symbol?.isAlias() ? symbol.getAliasedSymbol() : symbol
    )?.getDeclarations()[0];
    if (!decl || !Node.isFunctionDeclaration(decl)) return undefined;
    const sf = decl.getSourceFile();
    if (sf.isInNodeModules() || sf.isDeclarationFile()) return undefined;
    return returnedLiteral(decl, ctx, hops + 1);
  }
  const value = evaluate(expr, ctx);
  return value.kind === "object" ? value : undefined;
}

const sameClass = (
  r: Result | undefined,
  cls: { name?: string; file: string },
): boolean => r?.kind === "class" && r.name === cls.name && r.file === cls.file;

/** Adds the four metadata arrays of `props` to `info`; a key that is not an array is a problem. */
function addMetadata(
  info: ModuleInfo,
  props: Record<string, Result>,
  ctx: EvalContext,
): void {
  for (const key of KEYS) {
    const value = props[key];
    if (!value) continue;
    if (value.kind === "array") {
      info[key].push(
        ...value.items.map((r) => ({ result: r, site: siteOf(r.node, ctx) })),
      );
    } else info.problems.push(siteOf(value.node, ctx));
  }
}

/**
 * Reads every class decorated with `@Module` from `@nestjs/common` (matched by import origin)
 * (N-M1 to N-M6). Metadata is evaluated by the rules of nestjs.md section 2; what cannot be
 * evaluated is recorded, never guessed. Output is in file path order, then source order.
 */
export function readModules(project: Project, ctx: EvalContext): ModuleInfo[] {
  const out: ModuleInfo[] = [];
  const files = [...project.getSourceFiles()].sort((a, b) =>
    a.getFilePath() < b.getFilePath()
      ? -1
      : a.getFilePath() > b.getFilePath()
        ? 1
        : 0,
  );
  for (const sf of files) {
    for (const cls of sf.getClasses()) {
      const name = cls.getName();
      const decorators = cls.getDecorators();
      const moduleCall = decorators
        .map((d) => d.getCallExpression())
        .find(
          (c) => c && isFromModule(c.getExpression(), NEST_COMMON, "Module"),
        );
      if (!name || !moduleCall) continue;

      const file = ctx.relative(sf.getFilePath());
      const info: ModuleInfo = {
        name,
        file,
        line: cls.getStartLineNumber(),
        global: decorators.some((d) => {
          const call = d.getCallExpression();
          return (
            !!call && isFromModule(call.getExpression(), NEST_COMMON, "Global")
          );
        }),
        dynamic: false,
        declaration: cls,
        imports: [],
        controllers: [],
        providers: [],
        exports: [],
        problems: [],
        unresolved: false,
      };

      const arg = moduleCall.getArguments()[0];
      if (arg) {
        const meta = evaluate(arg, ctx);
        if (meta.kind === "object") addMetadata(info, meta.props, ctx);
        else info.problems.push(siteOf(arg, ctx));
      }

      // N-M5, N-M6: every static factory that returns a literal naming this class adds to the
      // one node of the class. `global` is never reduced (decorator or any literal).
      for (const method of cls.getStaticMethods()) {
        const literal = returnedLiteral(method, ctx);
        if (!literal || !sameClass(literal.props.module, { name, file })) {
          continue;
        }
        info.dynamic = true;
        const flag = literal.props.global;
        if (flag?.kind === "boolean" && flag.value) info.global = true;
        addMetadata(info, literal.props, ctx);
      }

      info.unresolved = info.problems.length > 0;
      out.push(info);
    }
  }
  return out;
}

/**
 * N-M5: `Class.method(...)` where `method` is a static factory of `Class` resolves to `Class`.
 * Anything else (a plain function, a missing or instance method, a literal naming another
 * module) is unresolved: the caller reports it, nothing is guessed.
 */
export function followModuleCall(node: Node, ctx: EvalContext): Result {
  const fail: Result = { kind: "unresolved", reason: "call", node };
  if (!Node.isCallExpression(node)) return fail;
  const callee = node.getExpression();
  if (!Node.isPropertyAccessExpression(callee)) return fail;
  const receiver = evaluate(callee.getExpression(), ctx);
  if (receiver.kind !== "class") return fail;
  const method = receiver.declaration.getStaticMethod(callee.getName());
  if (!method) return fail;
  const literal = returnedLiteral(method, ctx);
  return sameClass(literal?.props.module, receiver)
    ? { ...receiver, node }
    : fail;
}

/** `ConfigModule.forRoot()` where the receiver is imported from outside the repository (N-M9). */
export function isThirdPartyCall(node: Node, ctx: EvalContext): boolean {
  if (!Node.isCallExpression(node)) return false;
  let callee: Node = node.getExpression();
  // A plain function call (`buildModule(x)`) is not a module reference we can name: N-M7.
  if (!Node.isPropertyAccessExpression(callee)) return false;
  while (Node.isPropertyAccessExpression(callee)) {
    callee = callee.getExpression();
  }
  return Node.isIdentifier(callee) && evaluate(callee, ctx).kind === "external";
}
