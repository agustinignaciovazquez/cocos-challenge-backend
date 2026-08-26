import {
  ArgumentMetadata,
  BadRequestException,
  ParseIntPipe,
} from '@nestjs/common';
import { MAX_INT4 } from './int4';

export class ParseIdPipe extends ParseIntPipe {
  async transform(value: string, metadata: ArgumentMetadata): Promise<number> {
    const id = await super.transform(value, metadata);
    if (id < 1 || id > MAX_INT4) {
      throw new BadRequestException(
        `id must be an integer between 1 and ${MAX_INT4}`,
      );
    }
    return id;
  }
}
