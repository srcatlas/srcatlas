import { Module } from "@nestjs/common";
import {
  AuthGuard,
  HttpFilter,
  LocalGuardish,
  LogInterceptor,
  PlainRegistered,
  SharedUtil,
  UpperPipe,
} from "./roles";
import {
  ExplicitDefault,
  RequestContext,
  TransientThing,
  WeirdScope,
} from "./scopes";

@Module({
  providers: [
    RequestContext,
    TransientThing,
    WeirdScope,
    ExplicitDefault,
    AuthGuard,
    LogInterceptor,
    UpperPipe,
    HttpFilter,
    LocalGuardish,
    PlainRegistered,
    SharedUtil,
  ],
})
export class KindsModule {}
