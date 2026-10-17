// A decorator called Injectable that is not the NestJS one.
function Injectable(): ClassDecorator {
  return () => undefined;
}

@Injectable()
export class LocalInjectable {}
