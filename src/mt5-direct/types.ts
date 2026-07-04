// ── MT5 Direct – Shared Types ──

export interface Mt5Credentials {
  login: number;
  password: string;
  server: string;
}

export interface Mt5AccountInfo {
  login: number;
  balance: number;
  equity: number;
  margin: number;
  marginFree: number;
  marginLevel: number;
  currency: string;
  server: string;
  name: string;
  company: string;
  leverage: number;
}

export interface Mt5Position {
  ticket: number;
  symbol: string;
  type: "buy" | "sell";
  volume: number;
  priceOpen: number;
  priceCurrent: number;
  sl: number;
  tp: number;
  profit: number;
  swap: number;
  comment: string;
  magic: number;
  time: number;
}

export interface Mt5Deal {
  ticket: number;
  order?: number;
  positionId?: number;
  symbol: string;
  type: number;
  entry?: number;
  volume: number;
  price: number;
  profit: number;
  commission?: number;
  swap?: number;
  time: number;
  comment: string;
  magic: number;
}

export interface Mt5HistoryOrder {
  ticket: number;
  positionId?: number;
  symbol: string;
  type: number;
  state?: number;
  volumeInitial?: number;
  volumeCurrent?: number;
  priceOpen?: number;
  priceCurrent?: number;
  sl?: number;
  tp?: number;
  timeSetup?: number;
  timeDone?: number;
  comment?: string;
  magic?: number;
}

export interface Mt5TradeAudit {
  positionId: number;
  symbol: string;
  type: "BUY" | "SELL";
  volume: number;
  entryPrice: number;
  exitPrice: number;
  stopLoss: number | null;
  takeProfit: number | null;
  actualRisk: number | null;
  actualReward: number | null;
  riskRewardRatio: number | null;
  mfe: number | null;
  mae: number | null;
  durationSeconds: number;
  exitReason: string;
  profit: number;
  diagnosis: string[];
}

export interface Mt5PerformanceReport {
  source: "mt5";
  account: Mt5AccountInfo;
  openPositions: Mt5Position[];
  trades: Mt5TradeAudit[];
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  netProfit: number;
  profitFactor: number | null;
  averageWin: number;
  averageLoss: number;
  expectancy: number;
  drawdown: number;
  averageHoldingSeconds: number;
  largestWin: number;
  largestLoss: number;
}

export interface Mt5OrderRequest {
  symbol: string;
  type: "buy" | "sell";
  volume: number;
  price?: number;
  sl?: number;
  tp?: number;
  comment?: string;
  magic?: number;
  deviation?: number;
  typeFilling?: "fok" | "ioc" | "return";
}

export interface Mt5OrderResult {
  retcode: number;
  ticket: number;
  volume: number;
  price: number;
  comment: string;
}

export interface Mt5SymbolInfo {
  symbol: string;
  digits: number;
  point: number;
  spread: number;
  bid: number;
  ask: number;
  volumeMin: number;
  volumeMax: number;
  volumeStep: number;
  tradeMode: "disabled" | "enabled" | "closeonly" | "longonly" | "shortonly";
  description: string;
  path: string;
  marginInitial: number;
  marginMaintenance: number;
}

export interface Mt5Tick {
  time: number;
  bid: number;
  ask: number;
  last: number;
  volume: number;
}

export interface Mt5Rate {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  tickVolume: number;
  realVolume: number;
  spread: number;
}

export interface Mt5ConnectionStatus {
  connected: boolean;
  account?: Mt5AccountInfo;
  error?: string;
}

export type Mt5LibraryMode = "node-sdk" | "python-bridge";

// Bot types (lightweight, match bridge in-memory bot schema)
export interface Mt5Bot {
  id: string;
  symbol: string;
  timeframe: string;
  interval_seconds: number;
  enable_trading: boolean;
  status: "running" | "stopped";
  last_loop_at?: string | null;
}

export interface Mt5BotActivityEntry {
  timestamp: number;
  action: string;
  details?: unknown;
}
