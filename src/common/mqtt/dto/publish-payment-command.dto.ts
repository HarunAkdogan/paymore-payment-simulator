import { ApiProperty } from '@nestjs/swagger';
import {
    IsNumber,
    IsString,
    IsNotEmpty,
    IsPositive,
    Length,
    Matches,
} from 'class-validator';

export class PublishPaymentCommandDto {
    @ApiProperty({ example: 'test-001' })
    @IsString()
    @IsNotEmpty()
    @Length(1, 128)
    messageId: string;

    @ApiProperty({ example: 'TEST_PAYMENT' })
    @IsString()
    @IsNotEmpty()
    paymentId: string;

    @ApiProperty({ example: '6af71344b0c3506be0852853' })
    @IsString()
    @IsNotEmpty()
    terminalId: string;

    @ApiProperty({ example: 15000 })
    @IsNumber()
    @IsPositive()
    amount: number;

    @ApiProperty({ example: 'TRY' })
    @IsString()
    @Matches(/^[A-Z]{3}$/)
    currency: string;
}