import { Module } from "@nestjs/common";
import { ConsumerModule } from "./consumer.module";
import { FarModule, GlobalSideModule } from "./side.modules";

@Module({ imports: [ConsumerModule, GlobalSideModule, FarModule] })
export class ResRootModule {}
