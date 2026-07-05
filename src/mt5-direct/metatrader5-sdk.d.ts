declare module "metatrader5-sdk" {
  export class MetaTrader5 {
    initialize(): Promise<void>;
    shutdown(): Promise<void>;
    login(login: number, password: string, server: string): Promise<boolean>;
    accountInfo(): Promise<Record<string, unknown>>;
    positionsGet(): Promise<Record<string, unknown>[]>;
    orderSend(params: {
      symbol: string;
      type: number;
      volume: number;
      price: number;
      sl: number;
      tp: number;
      comment: string;
      magic: number;
      deviation: number;
      type_filling: number;
    }): Promise<Record<string, unknown>>;
    positionClose(ticket: number): Promise<Record<string, unknown>>;
    symbolInfo(symbol: string): Promise<Record<string, unknown>>;
    symbolInfoTick(symbol: string): Promise<Record<string, unknown>>;
    copyRatesFrom(
      symbol: string,
      timeframe: number,
      start: number,
      count: number,
    ): Promise<Record<string, unknown>[]>;
  }
}
