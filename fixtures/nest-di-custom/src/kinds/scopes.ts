import { Injectable, Scope } from "@nestjs/common";

declare function pickScope(): Scope;

@Injectable({ scope: Scope.REQUEST })
export class RequestContext {}

@Injectable({ scope: Scope.TRANSIENT })
export class TransientThing {}

@Injectable({ scope: pickScope() })
export class WeirdScope {}

@Injectable({ scope: Scope.DEFAULT })
export class ExplicitDefault {}
