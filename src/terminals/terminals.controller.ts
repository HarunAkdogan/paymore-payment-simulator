import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ApiTags } from '@nestjs/swagger';
import { IsMongoId, IsString, MinLength } from 'class-validator';
import { Model, Types } from 'mongoose';
import { Terminal, TerminalDocument } from './terminal.schema';
class CreateTerminalDto { @IsMongoId() companyId!: string; @IsString() @MinLength(2) terminalCode!: string; }
@ApiTags('terminals')
@Controller('terminals')
export class TerminalsController {
  constructor(@InjectModel(Terminal.name) private readonly terminals: Model<TerminalDocument>) {}
  @Post() create(@Body() dto: CreateTerminalDto) { return this.terminals.create({ ...dto, companyId: new Types.ObjectId(dto.companyId) }); }
  @Get() findByCompany(@Query('companyId') companyId: string) { return this.terminals.find(companyId ? { companyId } : {}).lean(); }
}
