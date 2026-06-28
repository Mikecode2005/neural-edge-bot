/**
 * Shared Deriv WebSocket client (browser-only).
 * Handles req_id correlation, subscriptions, auto-reconnect, authorize state.
 * Replaces the previous ad-hoc src/lib/deriv-ws.ts.
 */

const APP_ID =
  (typeof import.meta !== "undefined" && (import.meta as any).env?.VITE_DERIV_APP_ID) ||
  "1089"; // public fallback for read-only public feeds

export interface DerivTick {
  symbol: string;
  quote: number;
  epoch: number;
  pip_size: number;
}

export interface DerivCandle {
  epoch: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

type Handler = (msg: any) => void;

class DerivWS {
  private url: string;
  private ws: WebSocket | null = null;
  private nextReqId = 1;
  private pending = new Map<number, (msg: any) => void>();
  private subs = new Map<string, Handler>(); // subscription id -> handler
  private waiters: Array<() => void> = [];
  private connecting = false;
  private authorizedToken: string | null = null;
  private appId: string;

  constructor(appId: string) {
    this.appId = appId;
    this.url = `wss://ws.derivws.com/websockets/v3?app_id=${appId}`;
  }

  private async ensure() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    if (this.connecting) {
      await new Promise<void>((r) => this.waiters.push(r));
      return;
    }
    this.connecting = true;
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.onopen = () => {
        this.connecting = false;
        this.waiters.splice(0).forEach((w) => w());
        resolve();
      };
      ws.onerror = (e) => {
        this.connecting = false;
        reject(e);
      };
      ws.onclose = () => {
        this.ws = null;
        this.authorizedToken = null;
        // Drop pending; subs require resubscribe by caller
        this.pending.forEach((cb) =>
          cb({ error: { message: "ws closed" } })
        );
        this.pending.clear();
        this.subs.clear();
      };
      ws.onmessage = (ev) => {
        let data: any;
        try {
          data = JSON.parse(ev.data);
        } catch {
          return;
        }
        const reqId = data.req_id as number | undefined;
        if (reqId && this.pending.has(reqId)) {
          const cb = this.pending.get(reqId)!;
          // Streaming responses keep being delivered via subs map below
          if (!data.subscription) this.pending.delete(reqId);
          cb(data);
        }
        const subId = data.subscription?.id;
        if (subId && this.subs.has(subId)) {
          this.subs.get(subId)!(data);
        }
      };
    });
  }

  async send<T = any>(payload: Record<string, any>): Promise<T> {
    await this.ensure();
    const req_id = this.nextReqId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(req_id, (msg) => {
        if (msg.error) reject(new Error(msg.error.message || "Deriv error"));
        else resolve(msg as T);
      });
      this.ws!.send(JSON.stringify({ ...payload, req_id }));
    });
  }

  /** Subscribe; returns unsubscribe fn. `onMessage` is called on every update. */
  async subscribe(payload: Record<string, any>, onMessage: Handler): Promise<() => void> {
    await this.ensure();
    const req_id = this.nextReqId++;
    let subId: string | null = null;
    const first = await new Promise<any>((resolve, reject) => {
      this.pending.set(req_id, (msg) => {
        if (msg.error) {
          reject(new Error(msg.error.message));
          return;
        }
        if (msg.subscription?.id && !subId) {
          subId = msg.subscription.id;
          this.subs.set(subId, onMessage);
        }
        resolve(msg);
      });
      this.ws!.send(JSON.stringify({ ...payload, subscribe: 1, req_id }));
    });
    // Deliver the first frame too
    onMessage(first);
    return () => {
      if (subId) {
        this.subs.delete(subId);
        this.send({ forget: subId }).catch(() => {});
      }
    };
  }

  async authorize(token: string) {
    if (this.authorizedToken === token) return;
    const res = await this.send({ authorize: token });
    this.authorizedToken = token;
    return res;
  }

  isAuthorized() {
    return !!this.authorizedToken;
  }

  // ---- High-level helpers ----

  async fetchCandles(symbol: string, granularity = 60, count = 200): Promise<DerivCandle[]> {
    const res = await this.send<any>({
      ticks_history: symbol,
      adjust_start_time: 1,
      count,
      end: "latest",
      granularity,
      style: "candles",
    });
    return (res.candles ?? []).map((c: any) => ({
      epoch: c.epoch,
      open: +c.open,
      high: +c.high,
      low: +c.low,
      close: +c.close,
    }));
  }

  async subscribeTicks(symbol: string, cb: (t: DerivTick) => void) {
    return this.subscribe({ ticks: symbol }, (msg) => {
      if (msg.tick) {
        cb({
          symbol: msg.tick.symbol,
          quote: +msg.tick.quote,
          epoch: msg.tick.epoch,
          pip_size: msg.tick.pip_size,
        });
      }
    });
  }

  async subscribeBalance(cb: (b: { balance: number; currency: string; loginid: string }) => void) {
    return this.subscribe({ balance: 1, account: "all" }, (msg) => {
      if (msg.balance) {
        cb({
          balance: +msg.balance.balance,
          currency: msg.balance.currency,
          loginid: msg.balance.loginid,
        });
      }
    });
  }

  async proposal(args: {
    symbol: string;
    amount: number;
    contract_type: "CALL" | "PUT" | "MULTUP" | "MULTDOWN";
    duration?: number;
    duration_unit?: "t" | "s" | "m" | "h" | "d";
    basis?: "stake" | "payout";
    currency?: string;
    multiplier?: number;
    limit_order?: { take_profit?: number; stop_loss?: number };
  }) {
    return this.send<any>({
      proposal: 1,
      amount: args.amount,
      basis: args.basis ?? "stake",
      contract_type: args.contract_type,
      currency: args.currency ?? "USD",
      duration: args.duration,
      duration_unit: args.duration_unit,
      symbol: args.symbol,
      multiplier: args.multiplier,
      limit_order: args.limit_order,
    });
  }

  async buy(proposal_id: string, price: number) {
    return this.send<any>({ buy: proposal_id, price });
  }

  async subscribeOpenContract(contract_id: number, cb: Handler) {
    return this.subscribe({ proposal_open_contract: 1, contract_id }, cb);
  }

  async portfolio() {
    return this.send<any>({ portfolio: 1 });
  }
}

let _instance: DerivWS | null = null;
export function getDerivWS() {
  if (typeof window === "undefined") {
    // Server-side stub: do not actually connect; callers should use server fns instead.
    return null as unknown as DerivWS;
  }
  if (!_instance) _instance = new DerivWS(APP_ID);
  return _instance;
}

export const DERIV_APP_ID = APP_ID;
