# NestJS extractor: pattern catalogue

Status: draft for implementation (milestone M1, with P1 items finished in M2/M4). Package: `packages/extractor-nestjs`.

This document defines **what the extractor must emit for each NestJS pattern**. It is the specification the fixtures are written from. Output shapes follow `docs/schema.md`; read that first.

Each pattern has an ID (`N-<group><number>`), a priority and a snippet, followed by the expected graph elements. A pattern is done when its fixture exists, the golden file matches, and any report codes it lists are produced.

Priorities: **P0** = needed for the first release. **P1** = planned for the first release if time allows. **P2** = after launch.

## 1. Conventions

### 1.1 Shorthand in this document

- Package is `api` in every example, so `provider:api/OrdersService` is written in full and `module` fields are written as the module's class name.
- "Node" means a graph node, "edge" a graph edge, with `kind` as in the schema.
- Expected output lists only the elements the pattern is about. Other elements (for example the `package:api` node) are always present and omitted here.

### 1.2 Hard rules

1. **Decorators are matched by origin, not by name.** `@Get()` counts only if the identifier resolves, through the type checker, to an export of `@nestjs/common` (or another package named in the pattern). A local function called `Get`, or a decorator from another library with the same name, must not produce output. Every fixture set includes decoys for this.
2. **Static evaluation is limited and explicit.** See section 2. Anything outside it is `unresolved` and reported, never guessed.
3. **No code execution.** The extractor reads syntax and types only.
4. **Test and build files are excluded by default** (the list is in `docs/config.md` section 2.1). `analysis.includeTests: true` re-includes test files.
5. **One node per class.** A class registered in several modules is one node. `node.module` is `null` and each module has a `contains` edge (schema section 3).
6. **Stable ordering is the core's job.** The extractor emits in any order; `packages/core` sorts.

### 1.3 Detection

The extractor runs for a package when its `package.json` lists `@nestjs/core` or `@nestjs/common` in `dependencies`, `devDependencies` or `peerDependencies`. Otherwise it emits nothing.

## 2. Static value evaluation

Many patterns need a value from an expression: a route path, a queue name, a token, a version. The extractor evaluates only the following forms, using the type checker for identifier resolution.

| Allowed | Example |
| --- | --- |
| String, numeric and boolean literals | `'orders'`, `3000`, `true` |
| No-substitution and static template literals | `` `orders` ``, `` `${PREFIX}/x` `` when `PREFIX` is allowed |
| Concatenation of allowed strings | `BASE + '/orders'` |
| `const` variables initialised with an allowed expression | `const QUEUE = 'email'` |
| Property access on `as const` objects and enum members | `Queues.EMAIL`, `RequestMethod.GET` |
| Array literals and spreads of allowed arrays | `['a', ...OTHERS]` |
| Object literals with allowed property values | `{ path: 'x', version: '1' }` |
| `Symbol('x')`, `Symbol.for('x')` assigned to a `const` (as tokens only; the token name is the constant's identifier) | `const REPO = Symbol('REPO')` |
| `forwardRef(() => X)` (as a reference to `X`) | |

Not allowed, so `unresolved`: function calls (other than those above), `process.env.*`, values from `let` or reassigned variables, constants declared outside the repository, conditionals, loops.

## 3. Token resolution (dependency injection)

Several patterns need to find which provider satisfies an injection. The resolver works per package.

1. Build a **token table** from every `providers` array of every module in the package: for a class entry the token is the class; for `{ provide: T, ... }` the token is `T` (class, string, or symbol constant).
2. For an injection site, compute the token: the `@Inject(T)` argument if present, otherwise the parameter's declared type if it is a class.
3. Choose the provider by this order: (a) registered in the injecting class's own module, (b) registered in a module that module imports (directly), (c) registered in a `@Global()` module, (d) registered anywhere in the package. Use the first match. A match from (a) to (c) gives `confidence: certain`; a match from (d) gives `inferred`.
4. If several candidates exist at the same step, use all of them, mark each edge `inferred`, and add `nest.ambiguous-token`.
5. If there is no candidate: when the token is a class declared in `node_modules` (for example `ConfigService` from `@nestjs/config`), emit no edge and no report entry, and count it in the report summary. Providers from third-party modules have no node in v1. In every other case (a class, string or symbol token declared in the repository, or a token that cannot be evaluated), emit no edge and add `nest.unresolved-provider-token`.

## 4. Patterns

### 4.1 Modules (group M)

#### N-M1 Static module (P0)

```ts
@Module({
  imports: [PrismaModule],
  controllers: [OrdersController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
```

Expected:
- Node `module:api/OrdersModule` with `meta.dynamic = false`, `meta.global = false`.
- Edges: `imports` OrdersModule to PrismaModule; `contains` OrdersModule to OrdersController and to OrdersService; `exports` OrdersModule to OrdersService. Each edge has the site of the array element.

Notes: the metadata argument may be an object literal only; a non-literal argument (`@Module(CONFIG)`) is evaluated through the allowed forms in section 2, else the module is `unresolved` (see N-M7).

#### N-M2 Metadata assembled from constants and spreads (P0)

```ts
const SHARED = [LoggerService, ClockService];

@Module({ providers: [...SHARED, OrdersService] })
export class OrdersModule {}
```

Expected: `contains` edges to LoggerService, ClockService and OrdersService. Sites point at the element's declaration site in the array where it is written, which for spread elements is the spread expression.

#### N-M3 Circular imports with `forwardRef` (P0)

```ts
@Module({ imports: [forwardRef(() => UsersModule)] })
export class AuthModule {}
```

Expected: `imports` AuthModule to UsersModule, `confidence: certain`.

#### N-M4 Global module (P0)

```ts
@Global()
@Module({ providers: [ConfigService], exports: [ConfigService] })
export class AppConfigModule {}
```

Expected: `meta.global = true`. Global modules take part in token resolution step (c).

#### N-M5 Dynamic module returning a literal (P0)

```ts
@Module({})
export class CacheModule {
  static forRoot(ttl: number): DynamicModule {
    return {
      module: CacheModule,
      providers: [CacheService, { provide: CACHE_TTL, useValue: ttl }],
      exports: [CacheService],
      global: true,
    };
  }
}

// elsewhere
@Module({ imports: [CacheModule.forRoot(30)] })
export class AppModule {}
```

Expected:
- Node `module:api/CacheModule` with `meta.dynamic = true`, `meta.global = true` (taken from the returned literal).
- `contains` CacheModule to CacheService and to the custom provider for `CACHE_TTL` (N-P4); `exports` CacheModule to CacheService.
- `imports` AppModule to CacheModule. The call expression `CacheModule.forRoot(30)` is resolved to the module class `CacheModule` through the method's declaring class.

Rules for following the method: the body must contain a single `return` of an object literal, or of an identifier initialised with an object literal in the same function. The extractor follows calls to helper functions defined in the same package up to two levels deep if they return such a literal. Anything else is N-M7.

#### N-M6 Async dynamic module (P1)

```ts
static forRootAsync(opts: { imports?: any[]; useFactory: (...a: any[]) => Options; inject?: any[] }): DynamicModule {
  return {
    module: QueueModule,
    imports: opts.imports ?? [],
    providers: [{ provide: OPTIONS, useFactory: opts.useFactory, inject: opts.inject ?? [] }],
  };
}
```

Expected: as N-M5 for the literal parts. The `imports` value `opts.imports ?? []` is not evaluable, so the module's `imports` edges from that key are not emitted and the module gets `confidence: unresolved` with report `nest.unresolved-dynamic-module` (warning). The provider for `OPTIONS` is emitted (N-P4, `factory`).

#### N-M7 Dynamic module that cannot be followed (P0)

```ts
@Module({ imports: [buildModule(config)] })   // buildModule defined in a library or computed
export class AppModule {}
```

Expected: no edge for the unknown import; `AppModule` gets `confidence: unresolved`; report `nest.unresolved-dynamic-module` with the site of the expression. The viewer shows a warning marker on the node.

#### N-M8 Module re-export (P1)

```ts
@Module({ imports: [UsersModule], exports: [UsersModule] })
export class AccountsModule {}
```

Expected: `imports` edge as usual. Because `exports` edges go only to providers, the re-export is recorded in `node.meta["nestjs.reexports"]` as a sorted array of module IDs.

#### N-M9 Third-party modules (P0)

```ts
imports: [ConfigModule.forRoot(), TypeOrmModule.forFeature([User])]
```

Expected: no node and no edge, no per-item report entry. The total count of ignored third-party module imports appears in the report summary. Exceptions that are handled by dedicated patterns: `BullModule.registerQueue` (N-Q1) and `BullModule.registerFlowProducer` (ignored, P2).

### 4.2 Providers and injection (group P)

#### N-P1 Class provider (P0)

```ts
@Injectable()
export class OrdersService {}
```

Expected: node `provider:api/OrdersService` with `providerType = "class"`, `scope = "default"`, `role = "service"`. `module` is set when exactly one module lists the class in `providers`.

Role assignment: `service` by default. `guard` if the class implements `CanActivate`, `interceptor` if it implements `NestInterceptor`, `pipe` for `PipeTransform`, `filter` for `ExceptionFilter`, `processor` when decorated with `@Processor` (N-Q4). Otherwise `other` is used only when the class is registered as a provider but has no `@Injectable`.

#### N-P2 Constructor injection by class type (P0)

```ts
@Injectable()
export class OrdersService {
  constructor(private readonly prisma: PrismaService, private readonly mail: MailService) {}
}
```

Expected: `injects` OrdersService to PrismaService and to MailService, resolved with section 3. The site is the parameter.

#### N-P3 Injection by token (P0)

```ts
export const ORDERS_REPO = Symbol('ORDERS_REPO');

@Module({ providers: [{ provide: ORDERS_REPO, useClass: PgOrdersRepo }] })
export class OrdersModule {}

constructor(@Inject(ORDERS_REPO) private readonly repo: OrdersRepo) {}   // OrdersRepo is an interface
```

Expected:
- Custom provider node `provider:api/ORDERS_REPO` (N-P4, type `class`), plus an `injects` edge from the custom provider to `provider:api/PgOrdersRepo` (it instantiates that class).
- `injects` edge from the injecting class to `provider:api/ORDERS_REPO` with `meta.tokens = ["ORDERS_REPO"]`.

Notes: interfaces are erased at runtime, so injection of an interface type without `@Inject` cannot work in NestJS and is not resolved; report `nest.unresolved-provider-token`.

#### N-P4 Custom provider forms (P0)

```ts
providers: [
  { provide: 'API_KEY', useValue: process.env.API_KEY },                 // value
  { provide: MailService, useClass: SmtpMailService },                   // class
  { provide: 'DB', useFactory: (cfg: Config) => connect(cfg), inject: [Config] },   // factory
  { provide: 'LEGACY_MAIL', useExisting: MailService },                  // existing (alias)
]
```

Expected: one node per `provide` token. Token name is the string value, the class name, or the identifier of a symbol constant. IDs: `provider:api/API_KEY`, `provider:api/MailService`, `provider:api/DB`, `provider:api/LEGACY_MAIL`.

| Form | `meta.providerType` | Extra edges |
| --- | --- | --- |
| `useValue` | `value` | none |
| `useClass` | `class` | `injects` to the class named in `useClass` |
| `useFactory` | `factory` | `injects` to each token in `inject: [...]` |
| `useExisting` | `existing` | `injects` to the aliased token |

When the token is a class that is also decorated `@Injectable` and registered with `useClass`, there is one node (the token's), and the `useClass` target gets its own node if it is a class declared in the repository.

#### N-P5 Property injection (P0)

```ts
@Inject(MailService) private readonly mail: MailService;
@Inject() private readonly clock: ClockService;
```

Expected: `injects` edges as in N-P2. `@Inject()` with no argument uses the property's declared type.

#### N-P6 Injection modifiers (P0)

`@Optional()`, `@Self()`, `@SkipSelf()` do not change the output. The `injects` edge is emitted as normal.

#### N-P7 `forwardRef` injection (P0)

```ts
constructor(@Inject(forwardRef(() => UsersService)) private readonly users: UsersService) {}
```

Expected: `injects` to UsersService.

#### N-P8 Scope (P0)

```ts
@Injectable({ scope: Scope.REQUEST })
export class RequestContext {}
```

Expected: `meta.scope = "request"`. `Scope.TRANSIENT` gives `"transient"`. Any other value, or a value that cannot be evaluated, gives `"default"` plus report `nest.unresolved-scope` (info).

#### N-P9 Inheritance of constructor injection (P1)

```ts
export class BaseRepo { constructor(protected readonly prisma: PrismaService) {} }

@Injectable()
export class OrdersRepo extends BaseRepo {}     // no own constructor
```

Expected: when a provider class has no constructor of its own, injections declared by its nearest ancestor with a constructor are attributed to it (as NestJS does at runtime). `injects` OrdersRepo to PrismaService. If the class has its own constructor that calls `super(...)`, only its own parameters count.

#### N-P10 Dynamic lookup through `ModuleRef` (P2)

```ts
const svc = this.moduleRef.get(OrdersService);
```

Expected: no edge in v1; report `nest.module-ref-lookup` (info) with the site.

#### N-P11 Unregistered provider (P0)

An `@Injectable` class that no module lists in `providers`.

Expected: node emitted with `module = null`, and report `nest.unregistered-provider` (info). Such classes are often used by third-party modules or tests; they still belong in the map.

### 4.3 Controllers and routes (group R)

#### N-R1 Basic controller and handlers (P0)

```ts
@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Get()        findAll() {}
  @Post()       create() {}
  @Get(':id')   findOne() {}
  @Put(':id')   replace() {}
  @Patch(':id') update() {}
  @Delete(':id') remove() {}
}
```

Expected:
- Node `controller:api/OrdersController` with `meta.basePath = "/orders"`.
- Route nodes `route:api/GET /orders`, `route:api/POST /orders`, `route:api/GET /orders/:id`, `route:api/PUT /orders/:id`, `route:api/PATCH /orders/:id`, `route:api/DELETE /orders/:id`, each with `meta.handlerName`, `meta.method`, `meta.path`, `meta.type = "handler"`.
- `handles` edge from the controller to each route.
- Routes get `node.module` equal to the controller's module.

Supported method decorators: `Get`, `Post`, `Put`, `Patch`, `Delete`, `Options`, `Head`, `All` (method `ALL`), `Sse` (method `GET`).

#### N-R2 Sub-paths and path arrays (P0)

```ts
@Get('search/:term')
@Get(['list', 'all'])      // two routes
@Controller(['orders', 'purchases'])    // controller with several base paths
```

Expected: path arrays produce one route per resulting path. For a controller with N base paths and a handler with M paths, N times M routes. Route `meta.handlerName` is the same for all of them.

#### N-R3 Controller options object (P0)

```ts
@Controller({ path: 'orders', version: '1', host: 'api.example.com' })
```

Expected: `basePath = "/orders"`. Host is ignored in v1 (stored as `meta["nestjs.host"]` on the controller). Version is handled by N-R6.

A controller declared as `@Controller()` has `basePath = "/"`.

#### N-R4 Wildcards (P1)

```ts
@Get('files/*')
@Get('files/*rest')
```

Expected: the path is kept as written after normalisation of `:` and `*` segments. An unnamed `*` stays `*`; a named wildcard is kept as `*name`. IDs: `route:api/GET /files/*`, `route:api/GET /files/*rest`.

#### N-R5 Global prefix (P0)

```ts
// main.ts
const app = await NestFactory.create(AppModule);
app.setGlobalPrefix('api', { exclude: [{ path: 'health', method: RequestMethod.GET }] });
```

Expected:
- Every route in the package gets the prefix: `route:api/GET /api/orders`. Prefix value is evaluated with section 2.
- Excluded entries (by exact normalised path and, if given, method) do not get the prefix. Entries that use patterns or wildcards are not matched; the route is prefixed and the report has `nest.unresolved-exclude` (info).
- The prefix is found by locating `NestFactory.create(...)` in the package (outside excluded files) and the `setGlobalPrefix` call on the resulting variable in the same function.

Failure modes:
- Value not evaluable (for example `process.env.PREFIX`): routes are emitted unprefixed with `confidence: inferred`, report `nest.unresolved-prefix` (warning).
- More than one `NestFactory.create` in the package: no prefix is applied, report `nest.ambiguous-app` (warning), routes `inferred`.

#### N-R6 Versioning (P1)

```ts
// main.ts
app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

@Controller({ path: 'orders', version: '1' })
export class OrdersV1Controller {}

@Controller('orders')
export class OrdersController {
  @Version('2') @Get() findAllV2() {}
  @Version(['1', '2']) @Get(':id') findOne() {}
  @Version(VERSION_NEUTRAL) @Get('health') health() {}
}
```

Expected, for URI versioning:
- The version segment is `v` followed by the version (`/v1/orders`) unless `prefix` is given. `prefix: false` removes the segment; a string prefix replaces `v`.
- A method-level `@Version` overrides the controller version. A list produces one route per version. `VERSION_NEUTRAL` produces a route without a version segment. `defaultVersion` applies to handlers with no version.
- `meta.version` on the route is the version string, or `"neutral"`.
- For `HEADER`, `MEDIA_TYPE` and `CUSTOM` versioning the path is not changed, `meta.version` is still set, and the report has `nest.non-uri-versioning` (info).
- Global prefix and version combine as `/<prefix>/<version>/<path>`.

#### N-R7 Route enhancers (P1)

```ts
@UseGuards(AuthGuard)
@Controller('orders')
export class OrdersController {
  @UseGuards(RolesGuard) @UseInterceptors(CacheInterceptor) @UsePipes(ValidationPipe)
  @Post() create() {}
}
```

Expected: route `meta.guards = ["AuthGuard", "RolesGuard"]` (class-level plus method-level, sorted, de-duplicated); `meta.interceptors = ["CacheInterceptor"]`; `meta.pipes = ["ValidationPipe"]`; `meta.filters` for `@UseFilters`. An argument that is a class gives its name. An argument that is `new Foo()` gives `Foo`. Anything else is skipped with report `nest.unnamed-enhancer` (info).

Global enhancers (`app.useGlobalGuards(...)`, `APP_GUARD` providers) are not applied to routes in v1; report `nest.global-enhancer-ignored` (info).

#### N-R8 Duplicate routes (P0)

Two handlers that normalise to the same `route` ID in one package.

Expected: one node, `meta.handlerName` from the handler that appears first in file order, report `nest.duplicate-route` (warning) naming both sites. The `handles` edge from each controller is kept.

#### N-R9 Unregistered controller (P0)

A `@Controller` class that no module lists in `controllers`.

Expected: node and routes are emitted, `module = null`, report `nest.unregistered-controller` (warning). NestJS will not serve these routes, so the viewer shows a warning.

#### N-R10 Controller-less and non-HTTP handlers (P0)

`@MessagePattern`, `@EventPattern` (microservices) and GraphQL `@Resolver`/`@Query` are not routes. Expected: nothing is emitted. Report `nest.microservice-pattern-ignored` (info) for `@MessagePattern`/`@EventPattern`. GraphQL is silently ignored in v1.

### 4.4 Calls between classes (group C)

#### N-C1 Call through an injected member (P0)

```ts
@Get() findAll() { return this.orders.findAll(); }
@Post() create(@Body() dto: CreateOrderDto) { return this.orders.create(dto); }
```

Expected: `calls` edge from `OrdersController` to `OrdersService` with `meta.methods = ["create", "findAll"]` and a site for each call. `confidence: certain`.

Mechanism: for each call expression `x.m(...)`, find the declared type of `x`. If its class declaration has a provider node in this package, emit the edge. This is type-based, so it works for `this.orders`, for a local variable that was assigned from `this.orders`, and for a parameter of that type.

#### N-C2 Call on a non-injected instance (P1)

```ts
const svc = new OrdersService(prisma);   // outside Nest's container
svc.findAll();
```

Expected: `calls` edge with `confidence: inferred`.

#### N-C3 Call through a token whose declared type is an interface (P1)

```ts
constructor(@Inject(ORDERS_REPO) private readonly repo: OrdersRepo) {}
this.repo.findAll();
```

Expected: `calls` edge to the provider node resolved from the token (here `provider:api/ORDERS_REPO`), `confidence: certain` if the token resolves to a single provider in the same module or an imported one, otherwise `inferred`.

#### N-C4 Calls that are not followed (P0)

- A call to a plain function or a static method of a non-provider class: no edge.
- A call chain that passes through other functions (`helper(this.orders)`): no edge. The call graph is class-to-class and one hop.
- A call on a type that has no provider node (third-party library client): no edge, unless it matches an external-service rule (not in this document; the externals document is not written yet and is planned as P1).

#### N-C5 Prisma client calls (P0)

```ts
return this.prisma.order.findMany();
```

Expected: **no** `calls` edge to `PrismaService`. The Prisma extractor emits `reads` or `writes` to `model:api/Order`. The decision is recorded in schema section 6.1.

### 4.5 Gateways and realtime events (group G, all P1)

#### N-G1 Gateway (P1)

```ts
@WebSocketGateway({ namespace: 'chat' })
export class ChatGateway {
  @WebSocketServer() server: Server;
}
```

Expected: node `gateway:api/ChatGateway` with `meta.namespace = "/chat"`. The namespace gets a leading `/`. No `namespace` option gives `"/"`. A numeric first argument sets `meta.port`.

#### N-G2 Handled events (P1)

```ts
@SubscribeMessage('chat:send')
handleSend(@MessageBody() data: SendDto) {}
```

Expected: node `event:/chat#chat:send` (namespace `/chat`, name `chat:send`); `listens` edge from `ChatGateway` to the event. A name that cannot be evaluated gives no node and report `nest.unresolved-event-name` (info).

#### N-G3 Emitted events (P1)

```ts
this.server.emit('chat:new', msg);
this.server.to(roomId).emit('chat:new', msg);
client.emit('chat:ack');
```

Expected: `emits` edge from the gateway to `event:/chat#chat:new` and `event:/chat#chat:ack`, using the gateway's namespace. Rooms are not modelled. A name that cannot be evaluated gives report `nest.unresolved-event-name`.

#### N-G4 Emitting from a provider through the gateway (P2)

```ts
this.chatGateway.server.emit('chat:new', msg);
```

Expected in a later version: `emits` edge from the calling provider. Not emitted in v1.

#### N-G5 Unregistered gateway (P1)

A gateway class not listed in any `providers` array. Expected: node emitted with `module = null`, report `nest.unregistered-gateway` (warning). Nest instantiates gateways only when they are listed as providers.

### 4.6 Queues (group Q, all P1)

Two libraries exist. `@nestjs/bullmq` is the current one. `@nestjs/bull` is the legacy one. The extractor supports both and records `meta.library` on the queue node.

#### N-Q1 Queue registration (P1)

```ts
@Module({
  imports: [BullModule.registerQueue({ name: 'email' }, { name: 'reports' })],
})
export class MailModule {}
```

Expected: nodes `queue:email` and `queue:reports` with `meta.name` and `meta.library`. The node's `package` is the smallest package name (by code-unit order) that registers it; `module` is the registering module if exactly one registers it in that package, else `null`. No edge. The queue name is evaluated with section 2; `registerQueueAsync` with a literal `name` property is handled the same way.

#### N-Q2 Queue injection (P1)

```ts
constructor(@InjectQueue('email') private readonly emailQueue: Queue) {}
```

Expected: `injects` from the class to `queue:email`.

#### N-Q3 Enqueueing (P1)

```ts
await this.emailQueue.add('send-welcome', { userId });
```

Expected: `enqueues` from the class to `queue:email`, `meta.jobNames = ["send-welcome"]`. The receiver must be a member whose injection is `@InjectQueue(...)` or whose type is `Queue` from `bullmq`/`bull` and which was injected that way. A job name that cannot be evaluated is omitted from `jobNames`, and the report has `nest.unresolved-job-name` (info). Methods recognised: `add`, `addBulk`.

#### N-Q4 Processor with BullMQ (P1)

```ts
@Processor('email')
export class EmailProcessor extends WorkerHost {
  async process(job: Job): Promise<void> {
    switch (job.name) {
      case 'send-welcome': return this.welcome(job);
      case 'send-reset':   return this.reset(job);
    }
  }
}
```

Expected: provider `provider:api/EmailProcessor` with `meta.role = "processor"`; `consumes` edge to `queue:email` with `meta.jobNames = ["send-reset", "send-welcome"]`. In `@nestjs/bullmq` named jobs are dispatched with a `switch` on `job.name` inside `process()`; the extractor reads literal `case` labels of that switch, including enum members and constants evaluable by section 2. If `process()` has no such switch, `jobNames` is omitted. `@Processor({ name: 'email' })` and a constant argument are supported.

#### N-Q5 Processor with legacy Bull (P1)

```ts
@Processor('email')
export class EmailConsumer {
  @Process('send-welcome') handleWelcome(job: Job) {}
  @Process() handleDefault(job: Job) {}
}
```

Expected: same shape as N-Q4. `jobNames` is built from the names given to `@Process`. `@Process()` with no argument contributes the name `"__default__"`. This applies only when `@Process` is imported from `@nestjs/bull`.

### 4.7 Event emitter (group E, P2)

`@OnEvent('order.created')` and `eventEmitter.emit('order.created')` from `@nestjs/event-emitter` would use events with the reserved namespace `emitter`: `event:emitter#order.created`. Not implemented in v1.

## 5. Report codes

| Code | Level | Raised by |
| --- | --- | --- |
| `core.parse-error` | error | A file that fails to parse (emitted by the core, listed here for completeness) |
| `nest.unresolved-dynamic-module` | warning | N-M6, N-M7 |
| `nest.unresolved-provider-token` | warning | N-P3, section 3 step 5 |
| `nest.ambiguous-token` | warning | Section 3 step 4 |
| `nest.unresolved-scope` | info | N-P8 |
| `nest.module-ref-lookup` | info | N-P10 |
| `nest.unregistered-provider` | info | N-P11 |
| `nest.unresolved-prefix` | warning | N-R5 |
| `nest.unresolved-exclude` | info | N-R5 |
| `nest.ambiguous-app` | warning | N-R5 |
| `nest.non-uri-versioning` | info | N-R6 |
| `nest.unnamed-enhancer` | info | N-R7 |
| `nest.global-enhancer-ignored` | info | N-R7 |
| `nest.duplicate-route` | warning | N-R8 |
| `nest.unregistered-controller` | warning | N-R9 |
| `nest.microservice-pattern-ignored` | info | N-R10 |
| `nest.unresolved-event-name` | info | N-G2, N-G3 |
| `nest.unregistered-gateway` | warning | N-G5 |
| `nest.unresolved-job-name` | info | N-Q3 |

Codes are stable. Changing a code's meaning needs an ADR. New codes may be added.

## 6. Fixture plan

Each fixture is a small, self-contained NestJS application under `fixtures/<name>/` with its own `package.json`, plus `expected.graph.json` and `expected.report.json` (codes, levels and sites only, no timings).

**Anti-hard-coding rules.** (1) No two fixtures use the same class names. (2) Every fixture folder contains at least one **decoy**: a class or decorator that looks like a NestJS pattern but is not (a local `@Get` function, a class named `Controller`, a `@Module` from another library). The golden file must show that the decoy produced nothing. (3) Golden files are written by hand from this document before the extractor exists, and are never regenerated from extractor output.

| Fixture | Patterns covered | Priority | Milestone |
| --- | --- | --- | --- |
| `nest-basic` | N-M1, N-P1, N-P2, N-R1, N-C1, N-C5 (with a minimal Prisma schema; the provider patterns are in the golden file since #23) | P0 | M1 |
| `nest-modules` | N-M2, N-M3, N-M4, N-M8, N-M9 | P0 | M1 |
| `nest-dynamic` | N-M5, N-M6, N-M7 | P0 | M1 |
| `nest-di-custom` | N-P3, N-P4, N-P5, N-P6, N-P7, N-P8, N-P11, roles (N-P1) | P0 | M1 |
| `nest-di-resolution` | Token resolution order, ambiguity and the three outcomes without a candidate (section 3) | P0 | M1 |
| `nest-routing` | N-R2, N-R3, N-R4, N-R5, N-R8, N-R9, N-R10 | P0 | M1 |
| `nest-versioning` | N-R6, N-R7 | P1 | M2 |
| `nest-calls` | N-C2, N-C3, N-C4, N-P9 | P1 | M2 |
| `nest-gateway` | N-G1, N-G2, N-G3, N-G5 | P1 | M2 |
| `nest-bullmq` | N-Q1, N-Q2, N-Q3, N-Q4 | P1 | M2 |
| `nest-bull-legacy` | N-Q5 | P1 | M2 |
| `nest-monorepo` | Two packages sharing `queue:email` (producer in one, processor in the other), `depends_on` between packages, routes with the same path in both packages (IDs differ by package) | P1 | M2 |
| `nest-decoys` | Only decoys and non-NestJS code. Expected output is only the `package` node | P0 | M1 |

## 7. Out of scope for v1

GraphQL resolvers and schemas, microservice transports (`@MessagePattern`, `@EventPattern`, `ClientProxy`), CQRS (`@CommandHandler`, `@QueryHandler`, `@EventsHandler`), scheduled tasks (`@Cron`), `@nestjs/event-emitter`, TypeORM, Mongoose and MikroORM repositories, Swagger metadata, request-scoped provider chains, module visibility checks (whether an import is allowed by `exports`). Each is a candidate for a later extractor or pattern group.

## 8. Open questions

Record answers as decisions in `docs/adr/`.

1. N-P3: should an alias or `useClass` custom provider be one node or two? The catalogue says one node per token plus an `injects` edge to the class. Check this against how the viewer reads for the common `{ provide: X, useClass: Y }` case.
2. N-R5: should `NestFactory.create` also be searched in files outside `src/main.ts` by default? Currently yes, excluding tests.
3. Section 3: is step (b) enough, or should visibility through `exports` and re-exports (N-M8) be applied? Cheap to start without; revisit if the fixtures show false matches.
4. Section 2: `null` and `undefined` are not allowed forms and stay unresolved. Booleans were added to section 2 because N-M5 reads `global: true` from a returned literal. Check whether any pattern needs `null`.
5. Section 2 and step 5 of section 3 tell a third-party class (`ConfigService`, a valid token with no node) from a third-party constant (not allowed). When the package is not installed, both are only a name imported from a module, so the evaluator returns a third-party reference for both; with the package's types available, a constant or function is `unresolved`. Decide whether a fixture without `node_modules` is enough, or whether the benchmark corpus must install dependencies.
6. N-M5: a module class can have several static factories (`forRoot`, `forFeature`). It is one node, so the extractor takes the union: `dynamic` is true if any static method qualifies, `global` is true if the decorator or any returned literal says so, and the registrations of all of them are merged. A call to a factory that does not qualify is unresolved at the call site. Check this against real repositories whose factories differ in `global`.
7. N-M5: a static method qualifies when it has exactly one `return` (nested functions ignored) whose value is an object literal with `module:` naming the same class, written there, held by a `const` in the function, or returned by a helper function of the repository at most two calls away. A literal naming a different class is unresolved. A plain repository function used directly in `imports` (`imports: [makeModule()]`) is not followed and is reported as N-M7; only `Class.method()` is.
8. N-P4: a token node has no `meta.token` (the node name is the token). A string token is named by its value, so `const OPTIONS = 'QUEUE_OPTIONS'` gives `provider:api/QUEUE_OPTIONS`; a symbol by its constant. A class that is only the target of `useClass` gets its own node with `module = null` and is not reported as unregistered. When a class is also the token of a custom provider, `providerType` comes from the custom entry (first by site), the role from the class if it is `@Injectable`, else `service`.
9. N-P4: `useClass` edges go straight to the class; `inject: [...]` and `useExisting` go through section 3 from the registering module. An `inject` value that cannot be evaluated as an array produces nothing and no report. A provider element that cannot be named (no `provide`, an unevaluable token, none or several of `useValue`/`useClass`/`useFactory`/`useExisting`) gives `nest.unresolved-provider-token`. A `scope` key inside a custom provider object is not read.
10. Section 3 when a class is registered by several modules (or only reached through `useClass`): the token is resolved from each registering module and the answers are combined; they are certain only if all agree, otherwise inferred with `nest.ambiguous-token` when they differ. Decide whether that is the right reading of "the injecting class's own module".
11. N-P8: `Scope.DEFAULT` is accepted without a report.
