import {
  type ClassDeclaration,
  ModuleResolutionKind,
  Project,
  ScriptTarget,
} from "ts-morph";
import { describe, expect, it } from "vitest";
import type { Result } from "./evaluate.js";
import { isInjectable, readInjections, roleOf, scopeOf } from "./providers.js";

// nestjs.md N-P1, N-P2, N-P5 to N-P8: what is read from one class. Sources are in memory.

const ctx = { relative: (p: string) => p.replace(/^\//, "") };

function classes(text: string, extra: Record<string, string> = {}) {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: {
      target: ScriptTarget.ES2022,
      moduleResolution: ModuleResolutionKind.Bundler,
      experimentalDecorators: true,
    },
  });
  for (const [path, src] of Object.entries(extra))
    project.createSourceFile(path, src);
  const sf = project.createSourceFile("/src/m.ts", text);
  const byName = (n: string): ClassDeclaration => sf.getClassOrThrow(n);
  return { byName };
}

const NEST =
  "import { Injectable, Inject, Optional, Self, SkipSelf, Scope, forwardRef } from '@nestjs/common';\n";

/** A short form of a token result for comparison. */
function tok(r: Result): string {
  switch (r.kind) {
    case "class":
      return `class:${r.name}`;
    case "string":
      return `string:${r.value}`;
    case "symbol":
      return `symbol:${r.name}`;
    case "external":
      return `external:${r.module}#${r.name}`;
    case "unresolved":
      return `unresolved:${r.reason}`;
    default:
      return r.kind;
  }
}

describe("isInjectable and roleOf (N-P1)", () => {
  const src = `${NEST}
import { CanActivate, NestInterceptor, PipeTransform, ExceptionFilter } from '@nestjs/common';
interface Local { x(): void }
@Injectable() class Plain {}
@Injectable() class G implements CanActivate {}
@Injectable() class I implements NestInterceptor {}
@Injectable() class P implements PipeTransform {}
@Injectable() class F implements ExceptionFilter {}
@Injectable() class Several implements Local, CanActivate {}
@Injectable() class LocalOnly implements Local {}
class Undecorated {}
`;
  const { byName } = classes(src);

  it("maps the NestJS interfaces to roles, service by default", () => {
    expect(
      ["Plain", "G", "I", "P", "F", "Several", "LocalOnly"].map((n) =>
        roleOf(byName(n)),
      ),
    ).toEqual([
      "service",
      "guard",
      "interceptor",
      "pipe",
      "filter",
      "guard",
      "service",
    ]);
  });

  it("a class without @Injectable has role other", () => {
    expect(isInjectable(byName("Undecorated"))).toBe(false);
    expect(roleOf(byName("Undecorated"))).toBe("other");
  });

  it("matches @Injectable and the interfaces by import origin", () => {
    const { byName: by } = classes(
      `import { Injectable } from 'some-other-lib';
function CanActivate() {}
@Injectable() class Foreign {}
`,
    );
    expect(isInjectable(by("Foreign"))).toBe(false);
  });
});

describe("scopeOf (N-P8)", () => {
  it("reads Scope.REQUEST and Scope.TRANSIENT from @nestjs/common, installed or not", () => {
    const { byName } = classes(`${NEST}
@Injectable({ scope: Scope.REQUEST }) class R {}
@Injectable({ scope: Scope.TRANSIENT }) class T {}
@Injectable({ scope: Scope.DEFAULT }) class D {}
@Injectable() class None {}
@Injectable({}) class Empty {}
`);
    expect(
      ["R", "T", "D", "None", "Empty"].map((n) => scopeOf(byName(n), ctx)),
    ).toEqual([
      { scope: "request" },
      { scope: "transient" },
      { scope: "default" },
      { scope: "default" },
      { scope: "default" },
    ]);
  });

  it("any other value, or one that cannot be evaluated, is default plus the site of the expression", () => {
    const { byName } = classes(`${NEST}
declare function pick(): Scope;
@Injectable({
  scope: pick(),
})
class A {}
@Injectable({ scope: 3 }) class B {}
`);
    expect(scopeOf(byName("A"), ctx)).toEqual({
      scope: "default",
      problem: { file: "src/m.ts", line: 5 },
    });
    expect(scopeOf(byName("B"), ctx).scope).toBe("default");
    expect(scopeOf(byName("B"), ctx).problem).toBeDefined();
  });

  it("decoy: a Scope that is not the NestJS one is not recognised", () => {
    const { byName } = classes(`import { Injectable } from '@nestjs/common';
const Scope = { REQUEST: 'request' };
@Injectable({ scope: Scope.REQUEST }) class A {}
`);
    expect(scopeOf(byName("A"), ctx).scope).toBe("default");
  });
});

describe("readInjections (N-P2, N-P3, N-P5, N-P6, N-P7)", () => {
  const files = {
    "/src/a.ts": "export class Imported {}",
    "/src/tokens.ts":
      "export const REPO = Symbol('r'); export const KEY = 'KEY';",
  };

  it("N-P2: constructor parameters by class type, one per parameter, at the parameter's line", () => {
    const { byName } = classes(
      `${NEST}
import { Imported } from './a';
import type { Config } from '@nestjs/config';
class Local {}
interface Shape {}
@Injectable()
class S {
  constructor(
    private readonly a: Local,
    private readonly b: Imported,
    private readonly c: Config,
    private readonly d: Shape,
    private readonly e: string,
  ) {}
}
`,
      files,
    );
    const found = readInjections(byName("S"), ctx);
    expect(found.map((i) => [tok(i.token), i.site.line, i.via])).toEqual([
      ["class:Local", 10, "constructor"],
      ["class:Imported", 11, "constructor"],
      ["external:@nestjs/config#Config", 12, "constructor"],
      ["unresolved:unsupported", 13, "constructor"],
      ["unresolved:unsupported", 14, "constructor"],
    ]);
  });

  it("N-P3, N-P7: @Inject(token) wins over the declared type; forwardRef is looked through", () => {
    const { byName } = classes(
      `${NEST}
import { REPO, KEY } from './tokens';
interface Repo {}
class Other {}
@Injectable()
class S {
  constructor(
    @Inject(REPO) private readonly r: Repo,
    @Inject(KEY) private readonly k: string,
    @Inject('LITERAL') private readonly l: string,
    @Inject(forwardRef(() => Other)) private readonly o: Other,
  ) {}
}
`,
      files,
    );
    expect(readInjections(byName("S"), ctx).map((i) => tok(i.token))).toEqual([
      "symbol:REPO",
      "string:KEY",
      "string:LITERAL",
      "class:Other",
    ]);
  });

  it("N-P6: @Optional, @Self and @SkipSelf change nothing", () => {
    const { byName } = classes(`${NEST}
class A {}
@Injectable()
class S {
  constructor(@Optional() @Self() @SkipSelf() private readonly a: A) {}
}
`);
    expect(readInjections(byName("S"), ctx).map((i) => tok(i.token))).toEqual([
      "class:A",
    ]);
  });

  it("N-P5: properties with @Inject; @Inject() uses the declared type; other properties are ignored", () => {
    const { byName } = classes(`${NEST}
class A {}
class B {}
@Injectable()
class S {
  @Inject(A) private readonly a!: A;
  @Inject() private readonly b!: B;
  private readonly notInjected!: B;
}
`);
    const found = readInjections(byName("S"), ctx);
    expect(found.map((i) => [tok(i.token), i.via, i.site.line])).toEqual([
      ["class:A", "property", 7],
      ["class:B", "property", 8],
    ]);
  });

  it("decoy: @Inject from another library is not an injection marker", () => {
    const { byName } = classes(`import { Inject } from 'some-other-lib';
class A {}
class S {
  constructor(@Inject('X') private readonly a: A) {}
}
`);
    // The parameter still has a class type, so it is read by type; the foreign token is ignored.
    expect(readInjections(byName("S"), ctx).map((i) => tok(i.token))).toEqual([
      "class:A",
    ]);
  });

  it("a class without a constructor and without injected properties has none", () => {
    const { byName } = classes(`${NEST}
@Injectable() class S {}
`);
    expect(readInjections(byName("S"), ctx)).toEqual([]);
  });
});
