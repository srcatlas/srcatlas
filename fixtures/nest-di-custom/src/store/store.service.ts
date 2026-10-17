import { forwardRef, Inject, Injectable, Optional } from "@nestjs/common";
import { API_KEY, ORDERS_REPO } from "../tokens";
import { AuditService } from "./audit.service";
import type { Mailer } from "./mailer";
import type { OrdersRepo } from "./orders-repo";
import type { Settings } from "./settings";

@Injectable()
export class StoreService {
  constructor(
    @Inject(ORDERS_REPO) private readonly repo: OrdersRepo,
    @Inject(API_KEY) private readonly key: string,
    private readonly mailer: Mailer,
    @Optional() private readonly settings: Settings,
    @Inject(forwardRef(() => AuditService))
    private readonly audit: AuditService,
  ) {}
}
