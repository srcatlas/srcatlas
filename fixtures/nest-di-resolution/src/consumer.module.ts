import { Module } from "@nestjs/common";
import {
  UsesDeep,
  UsesFar,
  UsesGlobal,
  UsesImported,
  UsesMissing,
  UsesOwn,
  UsesTwice,
} from "./consumers";
import {
  DeepMidModule,
  SideAModule,
  SideBModule,
  SideModule,
} from "./side.modules";

@Module({
  imports: [SideModule, SideAModule, SideBModule, DeepMidModule],
  providers: [
    { provide: "TOKEN_OWN", useValue: "own" },
    UsesOwn,
    UsesImported,
    UsesGlobal,
    UsesFar,
    UsesTwice,
    UsesDeep,
    UsesMissing,
  ],
})
export class ConsumerModule {}
