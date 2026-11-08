import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
export type TerminalDocument = HydratedDocument<Terminal>;
@Schema({ timestamps: true })
export class Terminal {
  @Prop({ type: Types.ObjectId, ref: 'Company', required: true, index: true }) companyId!: Types.ObjectId;
    @Prop({ required: true, trim: true })
    terminalCode!: string;
  @Prop({ default: true }) isActive!: boolean;
}
export const TerminalSchema = SchemaFactory.createForClass(Terminal);
TerminalSchema.index({ companyId: 1, terminalCode: 1 }, { unique: true });
