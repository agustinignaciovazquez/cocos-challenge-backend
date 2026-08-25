import { Body, Controller, Post } from '@nestjs/common';
import { OrdersService, PlacedOrder } from './orders.service';
import { PlaceOrderDto } from './place-order.dto';

@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post()
  place(@Body() order: PlaceOrderDto): Promise<PlacedOrder> {
    return this.orders.place(order);
  }
}
