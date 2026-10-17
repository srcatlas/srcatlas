import { Injectable } from "@nestjs/common";

export abstract class Mailer {
  abstract send(to: string): void;
}

@Injectable()
export class SmtpMailer extends Mailer {
  send(_to: string): void {}
}
