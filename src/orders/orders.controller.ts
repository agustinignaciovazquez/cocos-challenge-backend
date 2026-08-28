import {
  Body,
  Controller,
  Headers,
  HttpStatus,
  Param,
  Patch,
  Post,
  Res,
} from '@nestjs/common';
import { ApiHeader, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { ParseIdPipe } from '../parse-id.pipe';
import { idempotencyKey } from './idempotency-key';
import { OrderView, OrdersService } from './orders.service';
import { PlaceOrderDto } from './place-order.dto';

@ApiTags('orders')
@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description:
      'Required, 1-64 characters of A-Z, a-z, 0-9, _ or -. Names the logical order, not ' +
      'the attempt: generate it once and resend it on every retry.',
  })
  @ApiResponse({ status: 201, description: 'The order this request created.' })
  @ApiResponse({
    status: 400,
    description:
      'The order is malformed, or the Idempotency-Key is missing or outside 1-64 ' +
      'characters of A-Z, a-z, 0-9, _ or -.',
  })
  @ApiResponse({
    status: 200,
    description:
      'The order an earlier request with this Idempotency-Key created, returned ' +
      'unchanged and executed nothing a second time.',
  })
  @ApiResponse({
    status: 503,
    description:
      'The placement never got its turn. Retry it with the same Idempotency-Key: the key ' +
      'settles the shed request and the retry into one order.',
  })
  @Post()
  async place(
    @Body() order: PlaceOrderDto,
    @Headers('Idempotency-Key') key: string | undefined,
    // Passthrough because only the status changes: the body is returned as usual.
    @Res({ passthrough: true }) response: Response,
  ): Promise<OrderView> {
    const placed = await this.orders.place(order, idempotencyKey(key));
    if (placed.replayed) {
      response.status(HttpStatus.OK);
    }
    return placed.order;
  }

  @Patch(':id/cancel')
  cancel(@Param('id', ParseIdPipe) id: number): Promise<OrderView> {
    return this.orders.cancel(id);
  }
}
