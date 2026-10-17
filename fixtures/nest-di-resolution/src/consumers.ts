import { Inject, Injectable } from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";

export interface Shape {
  area(): number;
}

export class OrphanThing {}

@Injectable()
export class UsesOwn {
  constructor(@Inject("TOKEN_OWN") private readonly own: string) {}
}

@Injectable()
export class UsesImported {
  constructor(@Inject("TOKEN_IMPORTED") private readonly imported: string) {}
}

@Injectable()
export class UsesGlobal {
  constructor(@Inject("TOKEN_GLOBAL") private readonly global: string) {}
}

@Injectable()
export class UsesFar {
  constructor(@Inject("TOKEN_FAR") private readonly far: string) {}
}

@Injectable()
export class UsesTwice {
  constructor(@Inject("TOKEN_TWICE") private readonly twice: string) {}
}

@Injectable()
export class UsesDeep {
  constructor(@Inject("TOKEN_DEEP") private readonly deep: string) {}
}

@Injectable()
export class UsesMissing {
  constructor(
    @Inject("TOKEN_MISSING") private readonly missing: string,
    private readonly shape: Shape,
    private readonly orphan: OrphanThing,
    private readonly config: ConfigService,
  ) {}
}
