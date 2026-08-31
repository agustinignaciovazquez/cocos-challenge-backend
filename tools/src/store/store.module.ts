import { Module } from '@nestjs/common';
import { AttemptsStore } from './attempts.store';

// The recorder on its own, so both the gateway that fills it and the chaos engine that writes
// its own events into it can have it without either having to import the other.
@Module({
  providers: [AttemptsStore],
  exports: [AttemptsStore],
})
export class StoreModule {}
