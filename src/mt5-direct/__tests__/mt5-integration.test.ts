/**
 * Integration test for MT5 Direct – requires a running MT5 demo account.
 *
 * Gated by MT5_INTEGRATION_TEST=true environment variable.
 * This test connects to a live MT5 demo account using credentials from .env.
 */

import { describe, it, expect } from "vitest";

const runIntegration = process.env.MT5_INTEGRATION_TEST === "true";

describe.runIf(runIntegration)("MT5 Integration (demo account)", () => {
  it("should connect to MT5 demo account", async () => {
    const { Mt5Client } = await import("../client");
    const client = new Mt5Client("node-sdk");

    const login = Number(process.env.MT5_ACCOUNT_LOGIN ?? 0);
    const password = process.env.MT5_ACCOUNT_PASSWORD ?? "";
    const server = process.env.MT5_ACCOUNT_SERVER ?? "";

    expect(login).toBeGreaterThan(0);
    expect(password).toBeTruthy();
    expect(server).toBeTruthy();

    await client.initialize({ login, password, server });
    expect(client.connected).toBe(true);

    const info = await client.accountInfo();
    expect(info.balance).toBeGreaterThanOrEqual(0);
    expect(info.currency).toBeTruthy();

    await client.shutdown();
    expect(client.connected).toBe(false);
  }, 30000); // 30s timeout for MT5 connection
});