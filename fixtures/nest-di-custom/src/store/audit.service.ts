import { forwardRef, Inject, Injectable } from "@nestjs/common";
import { StoreService } from "./store.service";

@Injectable()
export class AuditService {
  constructor(
    @Inject(forwardRef(() => StoreService))
    private readonly store: StoreService,
  ) {}
}
