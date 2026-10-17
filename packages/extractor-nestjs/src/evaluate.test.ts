import { ModuleResolutionKind, Project, ScriptTarget } from "ts-morph";
import { describe, expect, it } from "vitest";
import { evaluate, type Result, tokenKeyOf } from "./evaluate.js";

// docs/extractors/nestjs.md section 2. Sources are in memory: no node_modules unless a test adds a stub.

const ctx = { relative: (p: string) => p.replace(/^\//, "") };

function project(files: Record<string, string> = {}): Project {
  const p = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: {
      target: ScriptTarget.ES2022,
      moduleResolution: ModuleResolutionKind.Bundler,
      strict: true,
    },
  });
  for (const [path, text] of Object.entries(files))
    p.createSourceFile(path, text);
  return p;
}

/** Evaluates `expr` written as `export const TARGET = <expr>` after `header` in /src/main.ts. */
function ev(
  expr: string,
  header = "",
  files: Record<string, string> = {},
): Result {
  const p = project(files);
  const main = p.createSourceFile(
    "/src/main.ts",
    `${header}\nexport const TARGET = ${expr};\n`,
  );
  return evaluate(
    main.getVariableDeclarationOrThrow("TARGET").getInitializerOrThrow(),
    ctx,
  );
}

/** A plain value for comparison: scalars as themselves, other kinds as tagged strings. */
function show(r: Result): unknown {
  switch (r.kind) {
    case "string":
    case "number":
    case "boolean":
      return r.value;
    case "array":
      return r.items.map(show);
    case "object":
      return Object.fromEntries(
        Object.entries(r.props).map(([k, v]) => [k, show(v)]),
      );
    case "symbol":
      return `symbol:${r.name}`;
    case "class":
      return `class:${r.name}`;
    case "external":
      return `external:${r.module}#${r.name}`;
    case "enum":
      return `enum:${r.enumName}.${r.member}=${r.value}`;
    case "externalMember":
      return `member:${r.module}#${r.owner}.${r.member}`;
    case "unresolved":
      return { unresolved: r.reason };
  }
}

const NEST_COMMON_STUB = `
export declare function forwardRef<T>(fn: () => T): { forwardRef: () => T };
export declare enum RequestMethod { GET = 0, POST = 1 }
export declare const SOME_CONSTANT: string;
export declare class Injectable {}
`;

describe("evaluate: literals, templates, concatenation", () => {
  it("evaluates string, numeric and no-substitution template literals", () => {
    expect(show(ev("'orders'"))).toBe("orders");
    expect(show(ev("3000"))).toBe(3000);
    expect(show(ev("`orders`"))).toBe("orders");
  });

  it("evaluates a template whose substitutions are allowed", () => {
    const header = "const PREFIX = 'api'; const V = 2;";
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the string is TypeScript source under test
    expect(show(ev("`${PREFIX}/x`", header))).toBe("api/x");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the string is TypeScript source under test
    expect(show(ev("`v${V}`", header))).toBe("v2");
  });

  it("a template with an unevaluable substitution is unresolved", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the string is TypeScript source under test
    expect(show(ev("`${process.env.P}/x`"))).toEqual({
      unresolved: "env",
    });
  });

  it("concatenates strings, and strings with numbers", () => {
    const header = "const BASE = '/api'; const N = 2;";
    expect(show(ev("BASE + '/orders'", header))).toBe("/api/orders");
    expect(show(ev("BASE + '/a' + '/b'", header))).toBe("/api/a/b");
    expect(show(ev("'v' + N", header))).toBe("v2");
  });

  it("does not do arithmetic", () => {
    expect(show(ev("1 + 2"))).toEqual({ unresolved: "unsupported" });
  });

  it("looks through parentheses, assertions and non-null", () => {
    expect(show(ev("('a' as string)"))).toBe("a");
    expect(show(ev("'a' satisfies string"))).toBe("a");
    expect(show(ev("({ a: 'x' } as const).a"))).toBe("x");
  });
});

describe("evaluate: members of third-party names", () => {
  const h = "import { Scope } from '@nestjs/common';";

  it("Scope.REQUEST with the package not installed is a member of the imported name", () => {
    expect(show(ev("Scope.REQUEST", h))).toBe(
      "member:@nestjs/common#Scope.REQUEST",
    );
  });

  it("with the package installed it is an enum member that remembers its package", () => {
    const files = {
      "/node_modules/@nestjs/common/index.d.ts":
        "export declare enum Scope { DEFAULT = 0, TRANSIENT = 1, REQUEST = 2 }",
    };
    const r = ev("Scope.REQUEST", h, files);
    expect(show(r)).toBe("enum:Scope.REQUEST=2");
    expect(r.kind === "enum" && r.module).toBe("@nestjs/common");
  });

  it("a local enum has no package", () => {
    const r = ev("E.A", "enum E { A }");
    expect(r.kind === "enum" && r.module).toBeUndefined();
  });

  it("a member of a local object is still read from the object, not treated as third-party", () => {
    expect(
      show(ev("Scope.REQUEST", "const Scope = { REQUEST: 'r' } as const;")),
    ).toBe("r");
  });
});

describe("evaluate: boolean literals", () => {
  it("evaluates true and false, also through a const", () => {
    expect(show(ev("true"))).toBe(true);
    expect(show(ev("false"))).toBe(false);
    expect(show(ev("FLAG", "const FLAG = true;"))).toBe(true);
    expect(show(ev("{ global: true }"))).toEqual({ global: true });
  });

  it("a boolean is not a string or a number: no concatenation, no template substitution", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the string is TypeScript source under test
    expect(show(ev("`x${true}`"))).toEqual({ unresolved: "unsupported" });
    expect(show(ev("'a' + true"))).toEqual({ unresolved: "unsupported" });
  });

  it("null and undefined stay unresolved", () => {
    expect(show(ev("null"))).toEqual({ unresolved: "unsupported" });
    expect(show(ev("undefined"))).toEqual({ unresolved: "unknown" });
  });
});

describe("evaluate: variables", () => {
  it("follows const variables, including chains and across files", () => {
    expect(show(ev("B", "const A = 'x'; const B = A;"))).toBe("x");
    expect(
      show(
        ev("QUEUE", "import { QUEUE } from './consts';", {
          "/src/consts.ts": "export const QUEUE = 'email';",
        }),
      ),
    ).toBe("email");
  });

  it("follows a re-export barrel", () => {
    expect(
      show(
        ev("QUEUE", "import { QUEUE } from './barrel';", {
          "/src/barrel.ts": "export { QUEUE } from './consts';",
          "/src/consts.ts": "export const QUEUE = 'email';",
        }),
      ),
    ).toBe("email");
  });

  it("rejects let, var, parameters and unknown names", () => {
    expect(show(ev("L", "let L = 'x';"))).toEqual({ unresolved: "mutable" });
    expect(show(ev("V", "var V = 'x';"))).toEqual({ unresolved: "mutable" });
    expect(show(ev("missing"))).toEqual({ unresolved: "unknown" });
    const p = project();
    const f = p.createSourceFile(
      "/src/fn.ts",
      "export function f(ttl: number) { return ttl; }",
    );
    const id = f
      .getFunctionOrThrow("f")
      .getBodyOrThrow()
      .getDescendants()
      .find((d) => d.getText() === "ttl");
    if (!id) throw new Error("no identifier");
    expect(show(evaluate(id, ctx))).toEqual({ unresolved: "unknown" });
  });

  it("rejects calls, conditionals and process.env", () => {
    expect(
      show(ev("compute()", "declare function compute(): string;")),
    ).toEqual({
      unresolved: "call",
    });
    expect(show(ev("c ? 'a' : 'b'", "declare const c: boolean;"))).toEqual({
      unresolved: "unsupported",
    });
    expect(show(ev("process.env.PREFIX"))).toEqual({ unresolved: "env" });
  });

  it("detects a cycle instead of looping", () => {
    const p = project();
    const f = p.createSourceFile(
      "/src/cycle.ts",
      "export const A: string = B as string; export const B: string = A as string; export const T = A;",
    );
    expect(
      show(
        evaluate(
          f.getVariableDeclarationOrThrow("T").getInitializerOrThrow(),
          ctx,
        ),
      ),
    ).toEqual({ unresolved: "cycle" });
  });
});

describe("evaluate: as const objects and enums", () => {
  const header =
    "const Queues = { EMAIL: 'email', NESTED: { A: 'a' } } as const;";

  it("reads properties by dot and by string index, and nested", () => {
    expect(show(ev("Queues.EMAIL", header))).toBe("email");
    expect(show(ev("Queues['EMAIL']", header))).toBe("email");
    expect(show(ev("Queues.NESTED.A", header))).toBe("a");
  });

  it("a missing property is unresolved", () => {
    expect(show(ev("Queues.NOPE", header))).toEqual({ unresolved: "unknown" });
  });

  it("reads local enum members, numeric and string, with initializers and auto values", () => {
    const h = "enum E { A, B = 5, C } enum S { X = 'x' }";
    expect(show(ev("E.A", h))).toBe("enum:E.A=0");
    expect(show(ev("E.B", h))).toBe("enum:E.B=5");
    expect(show(ev("E.C", h))).toBe("enum:E.C=6");
    expect(show(ev("S.X", h))).toBe("enum:S.X=x");
  });

  it("reads enum members declared outside the repository (RequestMethod.GET)", () => {
    const files = {
      "/node_modules/@nestjs/common/index.d.ts": NEST_COMMON_STUB,
    };
    expect(
      show(
        ev(
          "RequestMethod.POST",
          "import { RequestMethod } from '@nestjs/common';",
          files,
        ),
      ),
    ).toBe("enum:RequestMethod.POST=1");
  });
});

describe("evaluate: arrays and objects", () => {
  it("evaluates arrays and spreads of arrays", () => {
    expect(
      show(ev("['a', ...OTHERS, 'z']", "const OTHERS = ['b', 'c'];")),
    ).toEqual(["a", "b", "c", "z"]);
  });

  it("items from a spread point at the spread expression (N-M2)", () => {
    const r = ev("[...SHARED, 'x']", "const SHARED = ['a', 'b'];");
    if (r.kind !== "array") throw new Error("not an array");
    expect(r.items.map((i) => i.node.getText())).toEqual([
      "...SHARED",
      "...SHARED",
      "'x'",
    ]);
  });

  it("keeps resolvable items when one item is unresolved", () => {
    const r = ev(
      "['a', compute(), 'c']",
      "declare function compute(): string;",
    );
    expect(show(r)).toEqual(["a", { unresolved: "call" }, "c"]);
  });

  it("a spread of a non-array is one unresolved item", () => {
    expect(show(ev("['a', ...NOT]", "const NOT = 'str';"))).toEqual([
      "a",
      { unresolved: "unsupported" },
    ]);
  });

  it("evaluates objects: values, shorthand, computed keys and spreads", () => {
    const header =
      "const path = 'x'; const K = 'dyn'; const BASE = { version: '1' };";
    expect(show(ev("{ path, [K]: 2, ...BASE, other: 'o' }", header))).toEqual({
      path: "x",
      dyn: 2,
      version: "1",
      other: "o",
    });
  });

  it("keeps resolvable properties when one is unresolved", () => {
    const r = ev(
      "{ module: 'm', imports: opts.imports, f: () => 1 }",
      "declare const opts: { imports: unknown[] };",
    );
    expect(show(r)).toEqual({
      module: "m",
      imports: { unresolved: "unknown" },
      f: { unresolved: "unsupported" },
    });
  });
});

describe("evaluate: symbols, class references and forwardRef", () => {
  it("names a Symbol token after its const identifier", () => {
    expect(show(ev("REPO", "const REPO = Symbol('repository');"))).toBe(
      "symbol:REPO",
    );
    expect(show(ev("REPO", "const REPO = Symbol.for('x');"))).toBe(
      "symbol:REPO",
    );
  });

  it("a Symbol call that is not a const initializer is unresolved", () => {
    expect(show(ev("Symbol('x')"))).toEqual({ unresolved: "call" });
  });

  it("decoy: a local function called Symbol is not the global Symbol", () => {
    expect(
      show(ev("T", "const Symbol = (s: string) => s; const T = Symbol('x');")),
    ).toEqual({ unresolved: "call" });
  });

  it("resolves a class declared in the repository, across files", () => {
    const r = ev("UsersModule", "import { UsersModule } from './users';", {
      "/src/users.ts": "export class UsersModule {}",
    });
    expect(show(r)).toBe("class:UsersModule");
    if (r.kind !== "class") throw new Error("not a class");
    expect(r.file).toBe("src/users.ts");
  });

  it("an import from a third-party module is an external reference", () => {
    expect(
      show(
        ev("ConfigService", "import { ConfigService } from '@nestjs/config';"),
      ),
    ).toBe("external:@nestjs/config#ConfigService");
  });

  it("a third-party constant whose type is known is unresolved, a class stays external", () => {
    const files = {
      "/node_modules/@nestjs/common/index.d.ts": NEST_COMMON_STUB,
    };
    const h = "import { SOME_CONSTANT, Injectable } from '@nestjs/common';";
    expect(show(ev("SOME_CONSTANT", h, files))).toEqual({
      unresolved: "external",
    });
    expect(show(ev("Injectable", h, files))).toBe(
      "external:@nestjs/common#Injectable",
    );
  });

  const COMMON = {
    "/node_modules/@nestjs/common/index.d.ts": NEST_COMMON_STUB,
  };
  const USERS = { "/src/users.ts": "export class UsersModule {}" };

  it("forwardRef(() => X) from @nestjs/common is a reference to X", () => {
    const h =
      "import { forwardRef } from '@nestjs/common'; import { UsersModule } from './users';";
    expect(show(ev("forwardRef(() => UsersModule)", h, { ...USERS }))).toBe(
      "class:UsersModule",
    );
    // and with the package installed
    expect(
      show(ev("forwardRef(() => UsersModule)", h, { ...USERS, ...COMMON })),
    ).toBe("class:UsersModule");
  });

  it("matches forwardRef by import origin: alias, namespace import, barrel", () => {
    const users = "import { UsersModule } from './users';";
    expect(
      show(
        ev(
          "fr(() => UsersModule)",
          `import { forwardRef as fr } from '@nestjs/common'; ${users}`,
          USERS,
        ),
      ),
    ).toBe("class:UsersModule");
    expect(
      show(
        ev(
          "common.forwardRef(() => UsersModule)",
          `import * as common from '@nestjs/common'; ${users}`,
          USERS,
        ),
      ),
    ).toBe("class:UsersModule");
    expect(
      show(
        ev(
          "forwardRef(() => UsersModule)",
          `import { forwardRef } from './barrel'; ${users}`,
          {
            ...USERS,
            "/src/barrel.ts": "export { forwardRef } from '@nestjs/common';",
          },
        ),
      ),
    ).toBe("class:UsersModule");
  });

  it("decoys: a local forwardRef or one from another library is not forwardRef", () => {
    const users = "import { UsersModule } from './users';";
    expect(
      show(
        ev(
          "forwardRef(() => UsersModule)",
          `function forwardRef<T>(f: () => T) { return f(); } ${users}`,
          USERS,
        ),
      ),
    ).toEqual({ unresolved: "call" });
    expect(
      show(
        ev(
          "forwardRef(() => UsersModule)",
          `import { forwardRef } from 'some-other-lib'; ${users}`,
          USERS,
        ),
      ),
    ).toEqual({ unresolved: "call" });
  });
});

describe("tokenKeyOf", () => {
  it("keys classes and symbols by declaring file, strings by value, externals by module", () => {
    const files = {
      "/src/tokens.ts": "export const REPO = Symbol('r'); export class A {}",
    };
    const h =
      "import { REPO, A } from './tokens'; import { ConfigService } from '@nestjs/config';";
    expect(tokenKeyOf(ev("A", h, files))).toBe("class:src/tokens.ts#A");
    expect(tokenKeyOf(ev("REPO", h, files))).toBe("symbol:src/tokens.ts#REPO");
    expect(tokenKeyOf(ev("'orders'"))).toBe("string:orders");
    expect(tokenKeyOf(ev("ConfigService", h, files))).toBe(
      "external:@nestjs/config#ConfigService",
    );
  });

  it("has no key for values that cannot be tokens", () => {
    expect(
      tokenKeyOf(ev("compute()", "declare function compute(): string;")),
    ).toBeUndefined();
    expect(tokenKeyOf(ev("[1]"))).toBeUndefined();
    expect(tokenKeyOf(ev("3"))).toBeUndefined();
  });
});
