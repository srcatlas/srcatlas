import { Inject, Injectable } from "some-other-lib";

@Injectable()
export class ForeignProvider {
  constructor(@Inject("API_KEY") private readonly key: string) {}
}
