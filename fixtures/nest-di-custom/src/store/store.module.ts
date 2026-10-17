import { Module } from "@nestjs/common";
import { API_KEY, ORDERS_REPO } from "../tokens";
import { AuditService } from "./audit.service";
import { Mailer, SmtpMailer } from "./mailer";
import { PgOrdersRepo } from "./orders-repo";
import { Settings } from "./settings";
import { StoreService } from "./store.service";

declare function connect(settings: unknown): unknown;

@Module({
  providers: [
    StoreService,
    AuditService,
    Settings,
    { provide: ORDERS_REPO, useClass: PgOrdersRepo },
    { provide: API_KEY, useValue: "secret" },
    { provide: Mailer, useClass: SmtpMailer },
    { provide: "DB", useFactory: connect, inject: [Settings, API_KEY] },
    { provide: "LEGACY_MAIL", useExisting: Mailer },
  ],
  exports: [StoreService, ORDERS_REPO],
})
export class StoreModule {}
