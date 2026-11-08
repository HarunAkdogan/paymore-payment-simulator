import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Min, Max } from 'class-validator';

export class RefundDto {
    @ApiProperty({
        example: 2500,
        description: 'Minor units; 2500 = 25.00 TRY',
    })
    @IsInt()
    @Min(1)
    @Max(100000000)
    amount!: number;
}