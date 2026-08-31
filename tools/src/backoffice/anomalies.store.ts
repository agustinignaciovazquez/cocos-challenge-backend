import { Injectable } from '@nestjs/common';
import { ChaosService } from '../chaos/chaos.service';
import { Anomaly, Finding } from './anomaly';

export const ANOMALIES_CAPACITY = 500;

@Injectable()
export class AnomaliesStore {
  private readonly buffer: Anomaly[] = [];
  private cursor = 0;
  private nextId = 1;
  private sink?: (anomaly: Anomaly) => void;

  constructor(private readonly chaos: ChaosService) {}

  // Where every finding is copied for the run history, which is the only place one survives a
  // clear or a restart.
  tap(sink: (anomaly: Anomaly) => void): void {
    this.sink = sink;
  }

  // Every anomaly is stamped with what chaos was being injected when it was found — the empty
  // list included, since "nothing was being done to the target" is the half that makes the
  // tag worth reading. It is stamped here rather than by each rule because a finding nobody
  // tagged would be the one a real bug hides behind.
  record(finding: Finding): Anomaly {
    const anomaly: Anomaly = {
      id: this.nextId++,
      at: new Date().toISOString(),
      ...finding,
      context: { chaosActive: this.chaos.active(), ...finding.context },
    };
    if (this.buffer.length < ANOMALIES_CAPACITY) {
      this.buffer.push(anomaly);
    } else {
      this.buffer[this.cursor] = anomaly;
    }
    this.cursor = (this.cursor + 1) % ANOMALIES_CAPACITY;
    this.sink?.(anomaly);
    return anomaly;
  }

  recent(limit: number): Anomaly[] {
    const size = this.buffer.length;
    const wanted = Math.min(limit, size);
    const newest: Anomaly[] = [];
    for (let back = 1; back <= wanted; back++) {
      newest.push(this.buffer[(this.cursor - back + size) % size]);
    }
    return newest;
  }

  size(): number {
    return this.buffer.length;
  }

  // Ids keep counting so a client that has already seen anomaly 12 cannot be handed a
  // different anomaly 12 after a clear.
  clear(): number {
    const dropped = this.buffer.length;
    this.buffer.length = 0;
    this.cursor = 0;
    return dropped;
  }
}
