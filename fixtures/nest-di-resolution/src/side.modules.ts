import { Global, Module } from "@nestjs/common";

@Module({ providers: [{ provide: "TOKEN_IMPORTED", useValue: "i" }] })
export class SideModule {}

@Module({ providers: [{ provide: "TOKEN_TWICE", useValue: "a" }] })
export class SideAModule {}

@Module({ providers: [{ provide: "TOKEN_TWICE", useValue: "b" }] })
export class SideBModule {}

@Global()
@Module({ providers: [{ provide: "TOKEN_GLOBAL", useValue: "g" }] })
export class GlobalSideModule {}

// Neither imported by the consumer nor global: found only by the last step.
@Module({ providers: [{ provide: "TOKEN_FAR", useValue: "f" }] })
export class FarModule {}

@Module({ providers: [{ provide: "TOKEN_DEEP", useValue: "d" }] })
export class DeepSideModule {}

// Imports are not followed transitively: the consumer imports this module, not DeepSideModule.
@Module({ imports: [DeepSideModule] })
export class DeepMidModule {}
