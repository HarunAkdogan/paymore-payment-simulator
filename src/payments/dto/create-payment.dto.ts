import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsMongoId, IsOptional, IsString, Matches, Max, Min, IsInt } from 'class-validator';
export class CreatePaymentDto {
    @ApiProperty() @IsMongoId() companyId!: string;
    @ApiProperty() @IsMongoId() terminalId!: string;
    @ApiProperty({ example: 'ORDER-10001' }) @IsString() @Matches(/^[A-Za-z0-9_-]{3,64}$/) merchantReference!: string;
    @ApiProperty({ example: 12500, description: 'Minor units; 12500 = 125.00 TRY' }) @IsInt() @Min(1) @Max(100000000) amount!: number;
    @ApiProperty({ example: 'TRY' }) @IsIn(['TRY', 'USD', 'EUR']) currency!: string;
    @ApiProperty({ required: false, enum: ['SUCCESS', 'DECLINED', 'PENDING', 'TIMEOUT'] }) @IsOptional() @IsIn(['SUCCESS', 'DECLINED', 'PENDING', 'TIMEOUT']) scenario?: 'SUCCESS' | 'DECLINED' | 'PENDING' | 'TIMEOUT';
}
