/** Pushes feed items to a spawn server over an authenticated webhook. */

/**
 * The webhook payload. The id is stable per item, so the receiver upserts
 * and redelivery is harmless.
 */
export interface Message {
  id: string;
  kind: string;
  title: string;
  summary_md: string;
  agent_summary: unknown;
  source_url: string;
  published_at: string;
}

export class WebhookClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  /**
   * Posts one message. 200 and 201 both mean the receiver has it; any other
   * status throws so the caller schedules a retry.
   */
  async send(msg: Message): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/v1/watcher/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.token}`,
      },
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify(msg),
    });
    if (res.status === 200 || res.status === 201) {
      await res.arrayBuffer();
      return;
    }
    const detail = (await res.text()).slice(0, 200);
    throw new Error(`deliver ${msg.id}: status ${res.status}: ${detail}`);
  }
}

const MINUTE = 60_000;
const CAP = 6 * 60 * MINUTE;

/**
 * The wait before the next attempt: exponential from one minute, capped at
 * six hours, never terminal — a long outage on either side heals by itself.
 */
export function backoff(attempts: number): number {
  let d = MINUTE;
  for (let i = 0; i < attempts && d < CAP; i++) d *= 2;
  return Math.min(d, CAP);
}
