import {
  type ClassDeclaration,
  Node,
  type SourceFile,
  SyntaxKind,
  type VariableDeclaration,
} from "ts-morph";
import { isFromModule, originOf } from "./origin.js";

// docs/extractors/nestjs.md section 2. Anything outside the listed forms is `unresolved` with a
// reason; the caller decides which report code that becomes. Nothing here guesses.

export interface EvalContext {
  /** Absolute path to repository-relative path with `/` separators. */
  relative(absolutePath: string): string;
}

/** `node` is the expression where the value is written; for items of a spread, the spread expression. */
interface Base {
  node: Node;
}

export type Evaluated =
  | (Base & { kind: "string"; value: string })
  | (Base & { kind: "number"; value: number })
  | (Base & { kind: "boolean"; value: boolean })
  | (Base & { kind: "array"; items: Result[] })
  | (Base & { kind: "object"; props: Record<string, Result> })
  /** A `const X = Symbol('...')` token; `name` is the identifier `X`. */
  | (Base & { kind: "symbol"; name: string; file: string })
  | (Base & {
      kind: "class";
      name: string;
      file: string;
      declaration: ClassDeclaration;
    })
  /** A name imported from outside the repository. Usable as a token; its value is unknown. */
  | (Base & { kind: "external"; name: string; module: string })
  | (Base & {
      kind: "enum";
      enumName: string;
      member: string;
      value: string | number | undefined;
      /** The package the enum is imported from, absent for an enum of the repository. */
      module?: string;
    })
  /**
   * `Owner.member` where `Owner` is a name imported from outside the repository and its types
   * are not available (`Scope.REQUEST` with @nestjs/common not installed). Whether `Owner` is
   * an enum is unknown, so callers check `module` and `owner`.
   */
  | (Base & {
      kind: "externalMember";
      module: string;
      owner: string;
      member: string;
    });

export type Reason =
  | "mutable" // let, var, reassigned
  | "call" // a function call
  | "external" // declared outside the repository
  | "env" // process.env.*
  | "unsupported" // a form section 2 does not list
  | "unknown" // an unresolved name, a parameter, a missing property
  | "cycle";

export interface Unresolved extends Base {
  kind: "unresolved";
  reason: Reason;
}

export type Result = Evaluated | Unresolved;

const NEST_COMMON = "@nestjs/common";

const bad = (node: Node, reason: Reason): Unresolved => ({
  kind: "unresolved",
  reason,
  node,
});

const isScalar = (r: Result): r is Result & { kind: "string" | "number" } =>
  r.kind === "string" || r.kind === "number";

const isOutside = (sf: SourceFile): boolean =>
  sf.isInNodeModules() || sf.isDeclarationFile();

/** `Symbol` resolves to the standard library, not to a local binding that shadows it. */
function isGlobalSymbol(id: Node): boolean {
  if (!Node.isIdentifier(id) || id.getText() !== "Symbol") return false;
  const decls = id.getSymbol()?.getDeclarations() ?? [];
  const program = id.getProject().getProgram().compilerObject;
  return (
    decls.length > 0 &&
    decls.every((d) =>
      program.isSourceFileDefaultLibrary(d.getSourceFile().compilerNode),
    )
  );
}

function isSymbolCall(call: Node): boolean {
  if (!Node.isCallExpression(call)) return false;
  const callee = call.getExpression();
  if (isGlobalSymbol(callee)) return true;
  return (
    Node.isPropertyAccessExpression(callee) &&
    callee.getName() === "for" &&
    isGlobalSymbol(callee.getExpression())
  );
}

/** Looks through parentheses and type-only wrappers (`as const`, `satisfies`, `!`). */
export function unwrap(node: Node): Node {
  let n = node;
  while (
    Node.isParenthesizedExpression(n) ||
    Node.isAsExpression(n) ||
    Node.isSatisfiesExpression(n) ||
    Node.isNonNullExpression(n) ||
    Node.isTypeAssertion(n)
  ) {
    n = n.getExpression();
  }
  return n;
}

const withNode = <T extends Result>(r: T, node: Node): T =>
  r.node === node ? r : { ...r, node };

/** Evaluates `node` by the rules of nestjs.md section 2. */
export function evaluate(node: Node, ctx: EvalContext): Result {
  return ev(node, ctx, new Set());
}

function ev(node: Node, ctx: EvalContext, seen: Set<Node>): Result {
  return withNode(evInner(unwrap(node), ctx, seen), node);
}

function evInner(node: Node, ctx: EvalContext, seen: Set<Node>): Result {
  if (
    Node.isStringLiteral(node) ||
    Node.isNoSubstitutionTemplateLiteral(node)
  ) {
    return { kind: "string", value: node.getLiteralValue(), node };
  }
  if (Node.isNumericLiteral(node)) {
    return { kind: "number", value: node.getLiteralValue(), node };
  }
  if (Node.isTrueLiteral(node) || Node.isFalseLiteral(node)) {
    return { kind: "boolean", value: Node.isTrueLiteral(node), node };
  }
  if (Node.isTemplateExpression(node)) {
    let value = node.getHead().getLiteralText();
    for (const span of node.getTemplateSpans()) {
      const part = ev(span.getExpression(), ctx, seen);
      if (part.kind === "unresolved") return part;
      if (!isScalar(part)) return bad(node, "unsupported");
      value += String(part.value) + span.getLiteral().getLiteralText();
    }
    return { kind: "string", value, node };
  }
  if (Node.isBinaryExpression(node)) {
    if (node.getOperatorToken().getKind() !== SyntaxKind.PlusToken) {
      return bad(node, "unsupported");
    }
    const left = ev(node.getLeft(), ctx, seen);
    if (left.kind === "unresolved") return left;
    const right = ev(node.getRight(), ctx, seen);
    if (right.kind === "unresolved") return right;
    // Only concatenation: at least one side is a string. Number + number is arithmetic.
    if (!isScalar(left) || !isScalar(right)) return bad(node, "unsupported");
    if (left.kind === "number" && right.kind === "number") {
      return bad(node, "unsupported");
    }
    return { kind: "string", value: `${left.value}${right.value}`, node };
  }
  if (Node.isArrayLiteralExpression(node)) return evArray(node, ctx, seen);
  if (Node.isObjectLiteralExpression(node)) return evObject(node, ctx, seen);
  if (Node.isIdentifier(node)) return evIdentifier(node, ctx, seen);
  if (
    Node.isPropertyAccessExpression(node) ||
    Node.isElementAccessExpression(node)
  ) {
    return evAccess(node, ctx, seen);
  }
  if (Node.isCallExpression(node)) return evCall(node, ctx, seen);
  return bad(node, "unsupported");
}

function evArray(
  node: import("ts-morph").ArrayLiteralExpression,
  ctx: EvalContext,
  seen: Set<Node>,
): Result {
  const items: Result[] = [];
  for (const el of node.getElements()) {
    if (Node.isSpreadElement(el)) {
      const spread = ev(el.getExpression(), ctx, seen);
      if (spread.kind === "array") {
        // Sites of spread items point at the spread expression (N-M2).
        for (const item of spread.items) items.push({ ...item, node: el });
      } else {
        items.push(
          spread.kind === "unresolved"
            ? { ...spread, node: el }
            : bad(el, "unsupported"),
        );
      }
    } else if (!Node.isOmittedExpression(el)) {
      items.push(ev(el, ctx, seen));
    }
  }
  return { kind: "array", items, node };
}

function propertyKey(
  name: Node,
  ctx: EvalContext,
  seen: Set<Node>,
): string | undefined {
  if (Node.isIdentifier(name)) return name.getText();
  if (Node.isStringLiteral(name) || Node.isNumericLiteral(name)) {
    return String(name.getLiteralValue());
  }
  if (Node.isComputedPropertyName(name)) {
    const k = ev(name.getExpression(), ctx, seen);
    return isScalar(k) ? String(k.value) : undefined;
  }
  return undefined;
}

function evObject(
  node: import("ts-morph").ObjectLiteralExpression,
  ctx: EvalContext,
  seen: Set<Node>,
): Result {
  const props: Record<string, Result> = Object.create(null) as Record<
    string,
    Result
  >;
  for (const p of node.getProperties()) {
    if (Node.isSpreadAssignment(p)) {
      const spread = ev(p.getExpression(), ctx, seen);
      if (spread.kind === "object") Object.assign(props, spread.props);
      else props[`...${p.getExpression().getText()}`] = bad(p, "unsupported");
      continue;
    }
    const nameNode =
      Node.isPropertyAssignment(p) ||
      Node.isShorthandPropertyAssignment(p) ||
      Node.isMethodDeclaration(p) ||
      Node.isGetAccessorDeclaration(p) ||
      Node.isSetAccessorDeclaration(p)
        ? p.getNameNode()
        : undefined;
    if (!nameNode) continue;
    const key = propertyKey(nameNode, ctx, seen) ?? `[${nameNode.getText()}]`;
    if (Node.isPropertyAssignment(p)) {
      const init = p.getInitializer();
      props[key] = init ? ev(init, ctx, seen) : bad(p, "unknown");
    } else if (Node.isShorthandPropertyAssignment(p)) {
      // The name of a shorthand property is also the property; the value is the variable.
      props[key] = evIdentifier(p.getNameNode(), ctx, seen, p.getValueSymbol());
    } else props[key] = bad(p, "unsupported");
  }
  return { kind: "object", props, node };
}

function classResult(
  decl: ClassDeclaration,
  ctx: EvalContext,
  node: Node,
): Result {
  const sf = decl.getSourceFile();
  const name = decl.getName() ?? "(anonymous)";
  return isOutside(sf)
    ? { kind: "external", name, module: ctx.relative(sf.getFilePath()), node }
    : {
        kind: "class",
        name,
        file: ctx.relative(sf.getFilePath()),
        declaration: decl,
        node,
      };
}

function evVariable(
  decl: VariableDeclaration,
  id: Node,
  ctx: EvalContext,
  seen: Set<Node>,
): Result {
  if (decl.getVariableStatement()?.getDeclarationKind() !== "const") {
    return bad(id, "mutable");
  }
  const sf = decl.getSourceFile();
  if (isOutside(sf)) return bad(id, "external");
  const init = decl.getInitializer();
  if (!init) return bad(id, "unknown");
  if (seen.has(decl)) return bad(id, "cycle");
  if (isSymbolCall(unwrap(init))) {
    return {
      kind: "symbol",
      name: decl.getName(),
      file: ctx.relative(sf.getFilePath()),
      node: id,
    };
  }
  seen.add(decl);
  try {
    return ev(init, ctx, seen);
  } finally {
    seen.delete(decl);
  }
}

function evIdentifier(
  id: import("ts-morph").Identifier,
  ctx: EvalContext,
  seen: Set<Node>,
  symbol = id.getSymbol(),
): Result {
  const decl = symbol?.getDeclarations()[0];
  if (!symbol || !decl) return bad(id, "unknown");

  // Imports: the repository's own modules are followed; anything else is external.
  const origin = Node.isImportSpecifier(decl) ? originOf(id) : undefined;
  if (Node.isImportSpecifier(decl)) {
    const target = decl.getImportDeclaration().getModuleSpecifierSourceFile();
    if (origin && (!target || isOutside(target))) {
      const real = symbol.getAliasedSymbol()?.getDeclarations()[0];
      // With the package installed, a constant or function is not a token.
      if (
        real &&
        (Node.isVariableDeclaration(real) || Node.isFunctionDeclaration(real))
      ) {
        return bad(id, "external");
      }
      return {
        kind: "external",
        name: origin.name,
        module: origin.module,
        node: id,
      };
    }
  }
  const real = symbol.isAlias() ? symbol.getAliasedSymbol() : symbol;
  const target = real?.getDeclarations()[0];
  if (!target) {
    return origin
      ? { kind: "external", name: origin.name, module: origin.module, node: id }
      : bad(id, "unknown");
  }
  if (Node.isVariableDeclaration(target))
    return evVariable(target, id, ctx, seen);
  if (Node.isClassDeclaration(target)) return classResult(target, ctx, id);
  if (Node.isParameterDeclaration(target)) return bad(id, "unknown");
  return bad(id, "unsupported");
}

const isProcessEnv = (node: Node): boolean => {
  if (!/^process\s*\.\s*env\b/.test(node.getText())) return false;
  const root = node.getFirstDescendantByKind(SyntaxKind.Identifier);
  const decls = root?.getSymbol()?.getDeclarations() ?? [];
  return decls.every((d) => isOutside(d.getSourceFile()));
};

function evAccess(
  node:
    | import("ts-morph").PropertyAccessExpression
    | import("ts-morph").ElementAccessExpression,
  ctx: EvalContext,
  seen: Set<Node>,
): Result {
  if (isProcessEnv(node)) return bad(node, "env");

  // Enum members, local or from a package, by the type checker's constant value.
  const member = node.getSymbol()?.getDeclarations()[0];
  if (member && Node.isEnumMember(member)) {
    const receiver = node.getExpression();
    const pkg = Node.isIdentifier(receiver)
      ? originOf(receiver)?.module
      : undefined;
    return {
      kind: "enum",
      enumName: member.getParent().getName(),
      member: member.getName(),
      value: member.getValue(),
      ...(pkg ? { module: pkg } : {}),
      node,
    };
  }

  const target = ev(node.getExpression(), ctx, seen);
  if (target.kind === "unresolved") return target;
  if (target.kind === "external") {
    const name = Node.isPropertyAccessExpression(node)
      ? node.getName()
      : undefined;
    return name
      ? {
          kind: "externalMember",
          module: target.module,
          owner: target.name,
          member: name,
          node,
        }
      : bad(node, "external");
  }
  if (target.kind !== "object") return bad(node, "unsupported");

  let key: string | undefined;
  if (Node.isPropertyAccessExpression(node)) key = node.getName();
  else {
    const arg = ev(node.getArgumentExpression() ?? node, ctx, seen);
    key = isScalar(arg) ? String(arg.value) : undefined;
  }
  if (key === undefined) return bad(node, "unsupported");
  return target.props[key] ?? bad(node, "unknown");
}

function evCall(
  node: import("ts-morph").CallExpression,
  ctx: EvalContext,
  seen: Set<Node>,
): Result {
  if (!isFromModule(node.getExpression(), NEST_COMMON, "forwardRef")) {
    return bad(node, "call");
  }
  // forwardRef(() => X) is a reference to X.
  const fn = node.getArguments()[0];
  if (!fn || !(Node.isArrowFunction(fn) || Node.isFunctionExpression(fn))) {
    return bad(node, "unsupported");
  }
  const body = fn.getBody();
  const expr = Node.isBlock(body)
    ? body.getStatements().length === 1 &&
      Node.isReturnStatement(body.getStatements()[0])
      ? (
          body.getStatements()[0] as import("ts-morph").ReturnStatement
        ).getExpression()
      : undefined
    : body;
  return expr ? ev(expr, ctx, seen) : bad(node, "unsupported");
}

/**
 * A stable key for a value used as an injection token, or `undefined` if the value cannot be
 * a token. Classes and symbols are identified by their declaring file, so two classes with
 * the same name in different files are different tokens.
 */
export function tokenKeyOf(r: Result): string | undefined {
  switch (r.kind) {
    case "class":
      return `class:${r.file}#${r.name}`;
    case "symbol":
      return `symbol:${r.file}#${r.name}`;
    case "string":
      return `string:${r.value}`;
    case "external":
      return `external:${r.module}#${r.name}`;
    default:
      return undefined;
  }
}
