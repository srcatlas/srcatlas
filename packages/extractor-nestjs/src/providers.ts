import type { Site } from "@srcatlas/core";
import {
  type ClassDeclaration,
  type Decorator,
  Node,
  type ParameterDeclaration,
  type PropertyDeclaration,
} from "ts-morph";
import { type EvalContext, evaluate, type Result } from "./evaluate.js";
import { siteOf } from "./modules.js";
import { isFromModule } from "./origin.js";

// nestjs.md N-P1, N-P2, N-P5 to N-P8: what is read from one class. Decorators and interfaces
// are matched by import origin (hard rule 1).

const NEST_COMMON = "@nestjs/common";

export type Role =
  | "service"
  | "guard"
  | "interceptor"
  | "pipe"
  | "filter"
  | "other";
export type Scope = "default" | "request" | "transient";

/** In priority order: a class that implements several gets the first. */
const ROLE_INTERFACES: [string, Role][] = [
  ["CanActivate", "guard"],
  ["NestInterceptor", "interceptor"],
  ["PipeTransform", "pipe"],
  ["ExceptionFilter", "filter"],
];

function decoratorCall(
  decorators: Decorator[],
  name: string,
): ReturnType<Decorator["getCallExpression"]> {
  for (const d of decorators) {
    const call = d.getCallExpression();
    if (call && isFromModule(call.getExpression(), NEST_COMMON, name)) {
      return call;
    }
  }
  return undefined;
}

export const isInjectable = (cls: ClassDeclaration): boolean =>
  decoratorCall(cls.getDecorators(), "Injectable") !== undefined;

/** N-P1: `other` only for a class that is registered but not `@Injectable`. */
export function roleOf(cls: ClassDeclaration): Role {
  if (!isInjectable(cls)) return "other";
  const implemented = cls.getImplements().map((i) => i.getExpression());
  for (const [name, role] of ROLE_INTERFACES) {
    if (implemented.some((e) => isFromModule(e, NEST_COMMON, name)))
      return role;
  }
  return "service";
}

const SCOPES: Record<string, Scope> = {
  DEFAULT: "default",
  REQUEST: "request",
  TRANSIENT: "transient",
};

function nestScopeMember(r: Result): string | undefined {
  if (r.kind === "enum" && r.module === NEST_COMMON && r.enumName === "Scope") {
    return r.member;
  }
  if (
    r.kind === "externalMember" &&
    r.module === NEST_COMMON &&
    r.owner === "Scope"
  ) {
    return r.member;
  }
  return undefined;
}

/**
 * N-P8: `@Injectable({ scope: Scope.REQUEST })`. Any other value, or one that cannot be
 * evaluated, is `default` plus the site of the expression for the caller to report.
 */
export function scopeOf(
  cls: ClassDeclaration,
  ctx: EvalContext,
): { scope: Scope; problem?: Site } {
  const call = decoratorCall(cls.getDecorators(), "Injectable");
  const arg = call?.getArguments()[0];
  if (!arg) return { scope: "default" };
  const options = evaluate(arg, ctx);
  if (options.kind !== "object") {
    return { scope: "default", problem: siteOf(arg, ctx) };
  }
  const value = options.props.scope;
  if (!value) return { scope: "default" };
  const member = nestScopeMember(value);
  const scope = member === undefined ? undefined : SCOPES[member];
  return scope
    ? { scope }
    : { scope: "default", problem: siteOf(value.node, ctx) };
}

export interface Injection {
  /** The token as evaluated: a class, a string, a symbol, a third-party name, or unresolved. */
  token: Result;
  /** The parameter or property, decorators included. */
  site: Site;
  via: "constructor" | "property";
}

/** The class named by a declared type, or an unresolved result for interfaces and primitives. */
function tokenOfType(
  holder: ParameterDeclaration | PropertyDeclaration,
  ctx: EvalContext,
): Result {
  const type = holder.getTypeNode();
  if (type && Node.isTypeReference(type)) {
    const name = type.getTypeName();
    if (Node.isIdentifier(name)) return evaluate(name, ctx);
  }
  return { kind: "unresolved", reason: "unsupported", node: holder };
}

function injection(
  holder: ParameterDeclaration | PropertyDeclaration,
  via: Injection["via"],
  ctx: EvalContext,
): Injection | undefined {
  const call = decoratorCall(holder.getDecorators(), "Inject");
  // Property injection needs @Inject; constructor parameters are injected either way.
  if (!call && via === "property") return undefined;
  const arg = call?.getArguments()[0];
  const token = arg ? evaluate(arg, ctx) : tokenOfType(holder, ctx);
  return { token, site: siteOf(holder, ctx), via };
}

/**
 * N-P2, N-P3, N-P5, N-P6, N-P7: the constructor parameters and the `@Inject` properties of a
 * class. `@Inject(token)` wins over the declared type; `@Optional`, `@Self` and `@SkipSelf`
 * change nothing; `forwardRef` is looked through by the evaluator.
 */
export function readInjections(
  cls: ClassDeclaration,
  ctx: EvalContext,
): Injection[] {
  const out: Injection[] = [];
  for (const p of cls.getConstructors()[0]?.getParameters() ?? []) {
    const found = injection(p, "constructor", ctx);
    if (found) out.push(found);
  }
  for (const p of cls.getProperties()) {
    if (p.isStatic()) continue;
    const found = injection(p, "property", ctx);
    if (found) out.push(found);
  }
  return out;
}
