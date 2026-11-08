
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type UserDocument = HydratedDocument<User>;

@Schema({ timestamps: true })
export class User {
    @Prop({
        required: true,
        unique: true,
        lowercase: true,
        trim: true,
    })
    email!: string;

    @Prop({ required: true })
    passwordHash!: string;

    @Prop({
        type: Types.ObjectId,
        ref: 'Company',
        required: true,
        index: true,
    })
    companyId!: Types.ObjectId;

    @Prop({ default: true })
    isActive!: boolean;
}

export const UserSchema = SchemaFactory.createForClass(User);
