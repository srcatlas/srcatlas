import {
  type CanActivate,
  type ExceptionFilter,
  Injectable,
  type NestInterceptor,
  type PipeTransform,
} from "@nestjs/common";

@Injectable()
export class AuthGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}

@Injectable()
export class LogInterceptor implements NestInterceptor {
  intercept(_context: unknown, next: { handle(): unknown }): unknown {
    return next.handle();
  }
}

@Injectable()
export class UpperPipe implements PipeTransform {
  transform(value: unknown): unknown {
    return value;
  }
}

@Injectable()
export class HttpFilter implements ExceptionFilter {
  catch(): void {}
}

// Not decorated: registered in providers, so its role is "other".
export class PlainRegistered {}

// Decoy: this CanActivate is a local interface, not the NestJS one.
interface CanActivate_ {
  canActivate(): boolean;
}

@Injectable()
export class LocalGuardish implements CanActivate_ {
  canActivate(): boolean {
    return true;
  }
}

@Injectable()
export class SharedUtil {}

// Not listed in any module: node with module null and an info report.
@Injectable()
export class LooseService {}
