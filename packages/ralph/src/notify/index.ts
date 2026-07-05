import type { NotificationSinkConfig } from "../config/schema";
import { log } from "../util/logger";

/**
 * Notification hub — lets the operator supervise by exception. Webhook sinks
 * POST a generic JSON body (fields cover Slack `text`, Discord `content`, and
 * plain `message` for ntfy.sh); desktop uses node-notifier if installed.
 * Failures never interrupt the run.
 */
export class NotificationHub {
  constructor(private readonly sinks: NotificationSinkConfig[]) {}

  get enabled(): boolean {
    return this.sinks.length > 0;
  }

  /** Deliver an event to every sink subscribed to it. Returns delivered sinks. */
  async notify(event: string, message: string): Promise<string[]> {
    const delivered: string[] = [];
    for (const sink of this.sinks) {
      if (sink.events && !sink.events.includes(event)) continue;
      try {
        if (sink.type === "webhook") {
          await this.webhook(sink.url, event, message);
        } else if (sink.type === "desktop") {
          this.desktop(event, message);
        }
        delivered.push(sink.type);
      } catch (e) {
        log.warn(`notify ${sink.type} failed: ${(e as Error).message}`);
      }
    }
    return delivered;
  }

  private async webhook(url: string, event: string, message: string): Promise<void> {
    const title = `Ralph: ${event}`;
    const body = JSON.stringify({ event, title, message, text: `${title}\n${message}`, content: `${title}\n${message}` });
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10_000);
    try {
      await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(t);
    }
  }

  private desktop(event: string, message: string): void {
    let notifier: { notify: (o: object) => void } | undefined;
    try {
      // Optional dependency; absent installs simply skip desktop toasts.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      notifier = require("node-notifier");
    } catch {
      return;
    }
    notifier?.notify({ title: `Ralph: ${event}`, message });
  }
}
