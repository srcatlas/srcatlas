import { Module } from "@nestjs/common";
import { StoreModule } from "../store/store.module";
import { ReportService } from "./report.service";

@Module({
  imports: [StoreModule],
  providers: [ReportService],
})
export class ReportModule {}
