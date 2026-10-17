import { Module } from "@nestjs/common";
import { SharedUtil } from "./roles";

@Module({ providers: [SharedUtil] })
export class ExtrasModule {}
