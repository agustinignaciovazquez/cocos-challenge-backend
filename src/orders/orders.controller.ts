import {
  Body,
  Controller,
  Param,
  ParseIntPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { OrderView, OrdersService } from './orders.service';
import { PlaceOrderDto } from './place-order.dto';

@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post()
  place(@Body() order: PlaceOrderDto): Promise<OrderView> {
    return this.orders.place(order);
  }

  @Patch(':id/cancel')
  cancel(@Param('id', ParseIntPipe) id: number): Promise<OrderView> {
    return this.orders.cancel(id);
  }
}
