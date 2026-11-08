import { Body, Controller, Get, Post } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';
import { Model } from 'mongoose';
import { Company, CompanyDocument } from './company.schema';
class CreateCompanyDto { @IsString() @MinLength(2) name!: string; @IsString() @MinLength(2) code!: string; }
@ApiTags('companies')
@Controller('companies')
export class CompaniesController {
    constructor(@InjectModel(Company.name) private readonly companies: Model<CompanyDocument>) { }
    @Post() @ApiOperation({ summary: 'Create a company' }) create(@Body() dto: CreateCompanyDto) { return this.companies.create(dto); }
    @Get() findAll() { return this.companies.find().sort({ createdAt: -1 }).lean(); }
}
