import { Inject, Injectable, Self, SkipSelf } from "@nestjs/common";
import type { ClockService } from "../clock/clock.service";
import type { AuditService } from "../store/audit.service";
import { StoreService } from "../store/store.service";

@Injectable()
export class ReportService {
  @Inject(StoreService) private readonly store!: StoreService;
  @Inject() private readonly clock!: ClockService;

  constructor(@Self() @SkipSelf() private readonly audit: AuditService) {}
}
