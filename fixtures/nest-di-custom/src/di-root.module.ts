import { Module } from "@nestjs/common";
import { ClockModule } from "./clock/clock.module";
import { ExtrasModule } from "./kinds/extras.module";
import { KindsModule } from "./kinds/kinds.module";
import { ReportModule } from "./report/report.module";
import { StoreModule } from "./store/store.module";

@Module({
  imports: [StoreModule, ReportModule, ClockModule, KindsModule, ExtrasModule],
})
export class DiRootModule {}
