import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Terminal, TerminalSchema } from './terminal.schema';
import { TerminalsController } from './terminals.controller';
@Module({ imports: [MongooseModule.forFeature([{ name: Terminal.name, schema: TerminalSchema }])], controllers: [TerminalsController] })
export class TerminalsModule {}
