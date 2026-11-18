import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsMongoId, IsOptional, IsString, Matches, Max, Min, IsInt } from 'class-validator';
export class CreatePaymentDto {
    @ApiProperty({ example: "6af587d512a1a510cc29b724"}) @IsMongoId() companyId!: string;
    @ApiProperty({ example: "6af71344b0c3506be0852853"}) @IsMongoId() terminalId!: string;
    @ApiProperty({ example: 'ORDER-10001' }) @IsString() @Matches(/^[A-Za-z0-9_-]{3,64}$/) merchantReference!: string;
    @ApiProperty({ example: 12500, description: 'Minor units; 12500 = 125.00 TRY' }) @IsInt() @Min(1) @Max(100000000) amount!: number;
    @ApiProperty({ example: 'TRY' }) @IsIn(['TRY', 'USD', 'EUR']) currency!: string;
    @ApiProperty({ required: false, enum: ['SUCCESS', 'DECLINED', 'PENDING', 'TIMEOUT'] }) @IsOptional() @IsIn(['SUCCESS', 'DECLINED', 'PENDING', 'TIMEOUT']) scenario?: 'SUCCESS' | 'DECLINED' | 'PENDING' | 'TIMEOUT';
}
