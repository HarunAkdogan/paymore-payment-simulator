import { Body, Controller, Get, Headers, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RateLimitGuard } from '../common/rate-limit.guard';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { RefundDto } from './dto/refund.dto';
import { PaymentsService } from './payments.service';
@ApiTags('payments')
@Controller('payments')
@UseGuards(RateLimitGuard)
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}
  @Post() @ApiHeader({ name: 'Idempotency-Key', required: true }) @ApiOperation({ summary: 'Create a simulated payment' }) create(@Body() dto: CreatePaymentDto, @Headers('idempotency-key') key: string) { return this.payments.create(dto, key); }
  @Get(':id') get(@Param('id') id: string) { return this.payments.findOne(id); }
  @Get() list(@Query('companyId') companyId: string) { return this.payments.listByCompany(companyId); }
  @Post(':id/inquiry') inquiry(@Param('id') id: string) { return this.payments.inquiry(id); }
  @Post(':id/void') void(@Param('id') id: string) { return this.payments.void(id); }
  @Post(':id/refund') refund(@Param('id') id: string, @Body() dto: RefundDto) { return this.payments.refund(id, dto.amount); }
}
