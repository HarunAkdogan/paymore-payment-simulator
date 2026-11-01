import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Min } from 'class-validator';
export class RefundDto { @ApiProperty({ example: 2500, description: 'Minor units' }) @IsInt() @Min(1) amount!: number; }
