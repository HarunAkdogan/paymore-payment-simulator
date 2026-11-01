import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
export type CompanyDocument = HydratedDocument<Company>;
@Schema({ timestamps: true })
export class Company {
  @Prop({ required: true, trim: true }) name!: string;
  @Prop({ required: true, unique: true, trim: true }) code!: string;
  @Prop({ default: true }) isActive!: boolean;
}
export const CompanySchema = SchemaFactory.createForClass(Company);
CompanySchema.index({ code: 1 }, { unique: true });
