import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Company, CompanySchema } from './company.schema';
import { CompaniesController } from './companies.controller';
@Module({ imports: [MongooseModule.forFeature([{ name: Company.name, schema: CompanySchema }])], controllers: [CompaniesController] })
export class CompaniesModule {}
