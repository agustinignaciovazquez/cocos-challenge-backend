import { Body, Controller, Param, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ParseIdPipe } from '../parse-id.pipe';
import { OrderView, OrdersService } from './orders.service';
import { PlaceOrderDto } from './place-order.dto';

@ApiTags('orders')
@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post()
  place(@Body() order: PlaceOrderDto): Promise<OrderView> {
    return this.orders.place(order);
  }

  @Patch(':id/cancel')
  cancel(@Param('id', ParseIdPipe) id: number): Promise<OrderView> {
    return this.orders.cancel(id);
  }
}
