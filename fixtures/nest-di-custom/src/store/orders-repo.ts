import { Injectable } from "@nestjs/common";

// Interfaces are erased at runtime: injection needs a token.
export interface OrdersRepo {
  find(): unknown[];
}

@Injectable()
export class PgOrdersRepo implements OrdersRepo {
  find(): unknown[] {
    return [];
  }
}
