import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect, useCallback } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  Plug,
  PlugZap,
  Activity,
  Wallet,
  TrendingUp,
  TrendingDown,
  Clock,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  RefreshCw,
  Settings,
  BarChart3,
  Zap,
  ExternalLink,
  Info,
  Play,
  Square,
  Terminal,
  Shield,
} from "lucide-react";

import { AppNav } from "@/components/AppNav";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Toaster } from "@/components/ui/sonner";

import {
  mt5Connect,
  mt5Disconnect,
  mt5AccountInfo,
  mt5GetPositions,
  mt5PlaceOrder,
  mt5ClosePosition,
  mt5GetRates,
  mt5Status,
  botStart,
  botStop,
  botList,
  botActivity,
  botOpenPositions,
  tunnelRegister,
  tunnelInfo,
} from "@/mt5-direct/api";
import type { Mt5AccountInfo, Mt5Position, Mt5OrderResult } from "@/mt5-direct/types";

export const Route = createFileRoute("/_authenticated/mt5-direct")({
  head: () => ({ meta: [{ title: "MT5 Direct — MetaTrader 5 Trading" }] }),
  component: Mt5DirectPage,
});

function Mt5DirectPage() {
  const fnConnect = useServerFn(mt5Connect);
  const fnDisconnect = useServerFn(mt5Disconnect);
  const fnAccount = useServerFn(mt5AccountInfo);
  const fnPositions = useServerFn(mt5GetPositions);
  const fnPlaceOrder = useServerFn(mt5PlaceOrder);
  const fnClose = useServerFn(mt5ClosePosition);
  const fnRates = useServerFn(mt5GetRates);
  const fnStatus = useServerFn(mt5Status);

  const [connected, setConnected] = useState(false);
  const [account, setAccount] = useState<Mt5AccountInfo | null>(null);
  const [positions, setPositions] = useState<Mt5Position[]>([]);
  const [connecting, setConnecting] = useState(false);
  const [orderForm, setOrderForm] = useState({
    symbol: "Volatility 10 Index",
    type: "buy" as "buy" | "sell",
    volume: 0.01,
    sl: 0,
    tp: 0,
  });
  const [placing, setPlacing] = useState(false);

  const connect = useCallback(async () => {
    setConnecting(true);
    const status = await fnConnect();
    if (status.connected) {
      setConnected(true);
      setAccount(status.account ?? null);
      toast.success("Connected to MT5");
    } else {
      toast.error("Connection failed", { description: status.error });
    }
    setConnecting(false);
  }, [fnConnect]);

  const disconnect = useCallback(async () => {
    await fnDisconnect();
    setConnected(false);
    setAccount(null);
    setPositions([]);
    toast.message("Disconnected from MT5");
  }, [fnDisconnect]);

  const refreshAccount = useCallback(async () => {
    const info = await fnAccount();
    if ("error" in info) {
      toast.error(info.error);
    } else {
      setAccount(info as Mt5AccountInfo);
    }
  }, [fnAccount]);

  const refreshPositions = useCallback(async () => {
    const pos = await fnPositions();
    if ("error" in pos) {
      toast.error(pos.error);
    } else {
      setPositions(pos as Mt5Position[]);
    }
  }, [fnPositions]);

  useEffect(() => {
    fnStatus().then((s) => {
      if (s.connected) {
        setConnected(true);
        if (s.account) setAccount(s.account);
      }
    });
  }, [fnStatus]);

  const handlePlaceOrder = async () => {
    setPlacing(true);
    const result = await fnPlaceOrder({
      data: {
        symbol: orderForm.symbol,
        type: orderForm.type,
        volume: orderForm.volume,
        sl: orderForm.sl > 0 ? orderForm.sl : undefined,
        tp: orderForm.tp > 0 ? orderForm.tp : undefined,
      },
    });
    if ("error" in result) {
      toast.error("Order failed", { description: result.error });
    } else {
      toast.success(`Order placed: ticket #${(result as Mt5OrderResult).ticket}`);
      refreshPositions();
    }
    setPlacing(false);
  };

  const handleClosePosition = async (ticket: number) => {
    const result = await fnClose({ data: { ticket } });
    if ("error" in result) {
      toast.error("Close failed", { description: result.error });
    } else {
      toast.success(`Position #${ticket} closed`);
      refreshPositions();
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <Toaster theme="dark" position="top-right" richColors />
      <AppNav />
      <div className="max-w-7xl mx-auto px-6 py-6 space-y-6">
        <header className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
              <ExternalLink className="size-5 text-primary" /> MT5 Direct
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Connect to MetaTrader 5 via the Python FastAPI bridge.
              The app uses the bridge service to access MT5 and trade on your account.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {connected ? (
              <>
                <Badge variant="default" className="gap-1">
                  <Activity className="size-3" /> Connected
                </Badge>
                <Button size="sm" variant="outline" onClick={refreshAccount} className="gap-1">
                  <RefreshCw className="size-3.5" /> Refresh
                </Button>
                <Button size="sm" variant="destructive" onClick={disconnect} className="gap-1">
                  <PlugZap className="size-3.5" /> Disconnect
                </Button>
              </>
            ) : (
              <Button size="sm" onClick={connect} disabled={connecting} className="gap-1">
                <Plug className="size-3.5" />
                {connecting ? "Connecting..." : "Connect to MT5"}
              </Button>
            )}
          </div>
        </header>

        {!connected && (
          <div className="glass rounded-xl p-8 text-center">
            <p className="text-muted-foreground">
              Click "Connect to MT5" to establish a connection using credentials from your .env
              file (<code className="bg-card px-1 rounded">MT5_ACCOUNT_LOGIN</code>,{" "}
              <code className="bg-card px-1 rounded">MT5_ACCOUNT_PASSWORD</code>,{" "}
              <code className="bg-card px-1 rounded">MT5_ACCOUNT_SERVER</code>).
            </p>
          </div>
        )}

        {connected && account && (
          <>
            {/* Account Info */}
            <div className="glass rounded-xl p-5 space-y-4">
              <h2 className="text-sm font-semibold flex items-center gap-2">
                <Wallet className="size-3.5 text-primary" /> Account Info
              </h2>
              <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
                <InfoBadge label="Server" value={account.server} />
                <InfoBadge label="Name" value={account.name} />
                <InfoBadge label="Currency" value={account.currency} />
                <InfoBadge label="Leverage" value={`1:${account.leverage}`} />
                <InfoBadge
                  label="Balance"
                  value={`$${account.balance.toFixed(2)}`}
                  tone={account.balance >= 0 ? "bull" : "bear"}
                />
                <InfoBadge
                  label="Equity"
                  value={`$${account.equity.toFixed(2)}`}
                  tone={account.equity >= 0 ? "bull" : "bear"}
                />
                <InfoBadge label="Margin" value={`$${account.margin.toFixed(2)}`} />
                <InfoBadge
                  label="Free Margin"
                  value={`$${account.marginFree.toFixed(2)}`}
                  tone={account.marginFree > 0 ? "bull" : "bear"}
                />
                <InfoBadge
                  label="Margin Level"
                  value={`${account.marginLevel.toFixed(1)}%`}
                  tone={account.marginLevel > 100 ? "bull" : "bear"}
                />
              </div>
            </div>

            {/* Order Panel */}
            <div className="glass rounded-xl p-5 space-y-4">
              <h2 className="text-sm font-semibold flex items-center gap-2">
                <Zap className="size-3.5 text-primary" /> Place Order
              </h2>
              <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                <div>
                  <Label className="text-xs">Symbol</Label>
                  <Input
                    value={orderForm.symbol}
                    onChange={(e) => setOrderForm({ ...orderForm, symbol: e.target.value })}
                    className="text-sm"
                  />
                </div>
                <div>
                  <Label className="text-xs">Type</Label>
                  <select
                    className="w-full bg-card border border-border rounded-md px-2 py-1.5 text-sm"
                    value={orderForm.type}
                    onChange={(e) => setOrderForm({ ...orderForm, type: e.target.value as "buy" | "sell" })}
                  >
                    <option value="buy">Buy</option>
                    <option value="sell">Sell</option>
                  </select>
                </div>
                <div>
                  <Label className="text-xs">Volume (lots)</Label>
                  <Input
                    type="number" step={0.01} min={0.01}
                    value={orderForm.volume}
                    onChange={(e) => setOrderForm({ ...orderForm, volume: Number(e.target.value) })}
                  />
                </div>
                <div>
                  <Label className="text-xs">Stop Loss (price)</Label>
                  <Input
                    type="number" step={0.1}
                    value={orderForm.sl}
                    onChange={(e) => setOrderForm({ ...orderForm, sl: Number(e.target.value) })}
                  />
                </div>
                <div>
                  <Label className="text-xs">Take Profit (price)</Label>
                  <Input
                    type="number" step={0.1}
                    value={orderForm.tp}
                    onChange={(e) => setOrderForm({ ...orderForm, tp: Number(e.target.value) })}
                  />
                </div>
              </div>
              <Button onClick={handlePlaceOrder} disabled={placing} className="gap-1.5">
                <Play className="size-3.5" /> {placing ? "Placing..." : "Place Order"}
              </Button>
            </div>

            {/* Open Positions */}
            <div className="glass rounded-xl overflow-hidden">
              <div className="p-4 flex items-center justify-between">
                <h2 className="text-sm font-semibold flex items-center gap-2">
                  <BarChart3 className="size-3.5 text-primary" /> Open Positions
                </h2>
                <Button size="sm" variant="ghost" onClick={refreshPositions} className="gap-1 h-7 text-xs">
                  <RefreshCw className="size-3" /> Refresh
                </Button>
              </div>
              {positions.length === 0 ? (
                <div className="p-4 border-t border-border">
                  <p className="text-xs text-muted-foreground text-center py-4">No open positions.</p>
                </div>
              ) : (
                <div className="border-t border-border overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-card/60">
                      <tr className="text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                        <th className="px-3 py-2">Ticket</th>
                        <th className="px-3 py-2">Symbol</th>
                        <th className="px-3 py-2">Type</th>
                        <th className="px-3 py-2">Volume</th>
                        <th className="px-3 py-2">Open Price</th>
                        <th className="px-3 py-2">Current Price</th>
                        <th className="px-3 py-2">SL</th>
                        <th className="px-3 py-2">TP</th>
                        <th className="px-3 py-2">Profit</th>
                        <th className="px-3 py-2">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {positions.map((p) => (
                        <tr key={p.ticket} className="border-t border-border/30 hover:bg-card/30">
                          <td className="px-3 py-1.5 numeric">{p.ticket}</td>
                          <td className="px-3 py-1.5">{p.symbol}</td>
                          <td className={`px-3 py-1.5 font-semibold ${p.type === "buy" ? "text-bull" : "text-bear"}`}>
                            {p.type.toUpperCase()}
                          </td>
                          <td className="px-3 py-1.5 numeric">{p.volume}</td>
                          <td className="px-3 py-1.5 numeric">{p.priceOpen.toFixed(4)}</td>
                          <td className="px-3 py-1.5 numeric">{p.priceCurrent.toFixed(4)}</td>
                          <td className="px-3 py-1.5 numeric">{p.sl?.toFixed(4) ?? "—"}</td>
                          <td className="px-3 py-1.5 numeric">{p.tp?.toFixed(4) ?? "—"}</td>
                          <td className={`px-3 py-1.5 numeric font-semibold ${p.profit >= 0 ? "text-bull" : "text-bear"}`}>
                            {p.profit >= 0 ? "+" : ""}${p.profit.toFixed(2)}
                          </td>
                          <td className="px-3 py-1.5">
                            <Button
                              size="sm"
                              variant="destructive"
                              className="h-6 text-[10px] px-2"
                              onClick={() => handleClosePosition(p.ticket)}
                            >
                              <Square className="size-2.5" /> Close
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Connection guide */}
            <div className="glass rounded-xl p-5">
              <div className="flex items-start gap-3">
                <Info className="size-5 text-primary shrink-0 mt-0.5" />
                <div className="text-xs text-muted-foreground space-y-1">
                  <p>
                    <strong className="text-foreground">Library:</strong>{" "}
                    This integration uses the Python FastAPI bridge service to access MetaTrader 5.
                    Set <code className="bg-card px-1 rounded">MT5_LIB_MODE=python-bridge</code> and point
                    <code className="bg-card px-1 rounded">VITE_MT5_BRIDGE_URL</code> to the bridge endpoint.
                  </p>
                  <p>
                    <strong className="text-foreground">Credentials:</strong> Configured via{" "}
                    <code className="bg-card px-1 rounded">MT5_ACCOUNT_LOGIN</code>,{" "}
                    <code className="bg-card px-1 rounded">MT5_ACCOUNT_PASSWORD</code>,{" "}
                    <code className="bg-card px-1 rounded">MT5_ACCOUNT_SERVER</code> in .env.
                  </p>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function InfoBadge({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "bull" | "bear";
}) {
  return (
    <div className="bg-card/50 rounded-lg px-3 py-2 border border-border/60">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className={`text-sm font-semibold numeric mt-0.5 ${tone === "bull" ? "text-bull" : tone === "bear" ? "text-bear" : ""}`}>
        {value}
      </p>
    </div>
  );
}