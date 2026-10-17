# srcatlas: report file and core report codes

Status: draft 1, 2026-10-17. Contract for `srcatlas.report.json`, written next to the graph file (`docs/schema.md` section 11, `docs/cli.md` section 1). The report is **not** deterministic: it carries timings. Everything about the analysed code that the graph cannot say goes here.

## 1. File format

```ts
interface ReportFile {
  reportVersion: 1;
  counts: {
    errors: number;       // entries with level 'error'
    warnings: number;
    infos: number;
    parseErrors: number;  // entries with code 'core.parse-error'
    unresolved: number;   // entries whose code is marked "unresolved construct" (section 2)
  };
  entries: ReportEntry[]; // shape in docs/schema.md section 11
  summary: Record<string, number>; // counters, section 3; keys in code-unit order, empty when none
  timings: Record<string, Record<string, number>>; // package name -> extractor name -> milliseconds
}
```

- `entries` are sorted by `extractor`, `code`, `site.file` (empty when there is no site), `site.line`, `message`, in code-unit order, so two runs differ only in `timings`.
- Paths in `site` are repository-relative with `/` separators, as in the graph.
- `docs/cli.md` `--strict` exits 1 when `counts.parseErrors + counts.unresolved > 0`.
- An entry whose code is not in the registry is kept and counted by level. It is never an error: extractors from outside the repository may add codes.

## 2. Code registry

Codes are constants in `packages/core/src/report.ts` (`REPORT_CODES`). A test compares them with the tables in this file and in every `docs/extractors/*.md` section "Report codes": a code in one place and not the other fails the build. Codes are stable; changing a code's meaning needs an ADR; new codes may be added.

Codes marked **unresolved** in the registry count towards `counts.unresolved`: the construct was noticed but could not be named or followed. Today these are the `*.unresolved-*` codes of the NestJS extractor and the Prisma codes for an access whose target model cannot be named: `prisma.unknown-model-access` and `prisma.dynamic-model-access`. Ambiguity (`*.ambiguous-*`) is not unresolved: the element is emitted as `inferred`.

### Core codes

| Code | Level | Raised by |
|---|---|---|
| `core.parse-error` | error | A file with a syntax error. It is skipped; other files are still analysed |
| `core.file-too-large` | warning | A file over `analysis.maxFileSizeKb`. It is skipped |
| `core.extractor-failed` | error | An extractor threw or returned malformed facts. Its output for that package is dropped; other extractors are unaffected |
| `core.package-failed` | error | The analysis of a whole package failed (worker crash, unreadable tsconfig). Other packages are unaffected |
| `core.unknown-extractor` | warning | An extractor named in `packages[].extractors` is not available |

Extractor codes are in `docs/extractors/nestjs.md` and `docs/extractors/prisma.md`, section "Report codes".

## 3. Summary counters

Some things are noticed on purpose and not worth an entry each. They are counted, and the totals over all packages appear in `summary`. A counter that is zero is absent.

| Key | Counts |
|---|---|
| `nest.ignored-third-party-modules` | Items of a NestJS `imports` array that are third-party modules (`ConfigModule.forRoot()`, `HttpModule`), which have no node in v1 (N-M9) |
| `nest.ignored-third-party-injections` | Injections of a class imported from outside the repository that no provider of the package satisfies (section 3 step 5 of the NestJS extractor), which have no node in v1 |
