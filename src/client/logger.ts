import { ClientBuffer } from './buffer.js';

export interface LogEntry {
  timestamp: number;
  channel: string;
  data: unknown;
}

export class StructuredLogger {
  channels = new Map<string, ClientBuffer<LogEntry>>();

  log(channel: string, data: unknown): void {
    let buf = this.channels.get(channel);
    if (!buf) {
      buf = new ClientBuffer<LogEntry>(200);
      this.channels.set(channel, buf);
    }
    buf.push({ timestamp: Date.now(), channel, data });
  }

  getChannel(channel: string): LogEntry[] {
    return this.channels.get(channel)?.getAll() || [];
  }

  getAllChannels(): string[] {
    return Array.from(this.channels.keys());
  }

  clear(channel?: string): void {
    if (channel) {
      this.channels.get(channel)?.clear();
    } else {
      this.channels.clear();
    }
  }
}
