import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';
import { Model } from 'mongoose';
import { Company, CompanyDocument } from './company.schema';
import { RateLimitGuard } from '../common/rate-limit.guard';
class CreateCompanyDto { @IsString() @MinLength(2) name!: string; @IsString() @MinLength(2) code!: string; }
@ApiTags('companies')
@Controller('companies')
export class CompaniesController {
    constructor(@InjectModel(Company.name) private readonly companies: Model<CompanyDocument>) { }
    @Post() @ApiOperation({ summary: 'Create a company' }) create(@Body() dto: CreateCompanyDto) { return this.companies.create(dto); }
    @Get() @UseGuards(RateLimitGuard) findAll() { return this.companies.find().sort({ createdAt: -1 }).lean(); }
}
