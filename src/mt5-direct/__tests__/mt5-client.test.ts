/**
 * Unit tests for Mt5Client – mocks the metatrader5-sdk package.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockInitialize,
  mockLogin,
  mockShutdown,
  mockAccountInfo,
  mockPositionsGet,
  mockOrderSend,
  mockCopyRatesFrom,
} = vi.hoisted(() => ({
  mockInitialize: vi.fn(),
  mockLogin: vi.fn(),
  mockShutdown: vi.fn(),
  mockAccountInfo: vi.fn(),
  mockPositionsGet: vi.fn(),
  mockOrderSend: vi.fn(),
  mockCopyRatesFrom: vi.fn(),
}));

vi.mock("metatrader5-sdk", () => ({
  MetaTrader5: class {
    initialize = mockInitialize;
    login = mockLogin;
    shutdown = mockShutdown;
    accountInfo = mockAccountInfo;
    positionsGet = mockPositionsGet;
    orderSend = mockOrderSend;
    copyRatesFrom = mockCopyRatesFrom;
  },
}));

import { Mt5Client } from "../client";

describe("Mt5Client", () => {
  let client: Mt5Client;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new Mt5Client("node-sdk");
  });

  describe("initialize", () => {
    it("should connect and login with credentials", async () => {
      mockInitialize.mockResolvedValue(undefined);
      mockLogin.mockResolvedValue(true);

      await client.initialize({ login: 12345, password: "secret", server: "Deriv-Server" });

      expect(mockInitialize).toHaveBeenCalledOnce();
      expect(mockLogin).toHaveBeenCalledWith(12345, "secret", "Deriv-Server");
      expect(client.connected).toBe(true);
    });

    it("should throw on login failure", async () => {
      mockInitialize.mockResolvedValue(undefined);
      mockLogin.mockResolvedValue(false);
      await expect(client.initialize({ login: 0, password: "", server: "" })).rejects.toThrow(
        "MT5 login failed",
      );
      expect(client.connected).toBe(false);
    });
  });

  describe("accountInfo", () => {
    it("should return account info", async () => {
      mockAccountInfo.mockResolvedValue({ login: 12345, balance: 10000, currency: "USD" });
      const info = await client.accountInfo();
      expect(info.balance).toBe(10000);
    });
  });

  describe("positions", () => {
    it("should return open positions", async () => {
      mockPositionsGet.mockResolvedValue([{ ticket: 1, profit: 5.0 }]);
      const positions = await client.positions();
      expect(positions).toHaveLength(1);
    });
  });

  describe("orderSend", () => {
    it("should place a buy order", async () => {
      mockOrderSend.mockResolvedValue({ retcode: 10009, ticket: 1001 });
      const result = await client.orderSend({ symbol: "X", type: "buy", volume: 0.01 });
      expect(result.ticket).toBe(1001);
    });
  });

  describe("rates", () => {
    it("should fetch rates", async () => {
      mockCopyRatesFrom.mockResolvedValue([{ time: 1000, open: 1.0, close: 1.05 }]);
      const rates = await client.rates("X", "1m", 100);
      expect(rates).toHaveLength(1);
    });
  });

  describe("status", () => {
    it("should return disconnected on error", async () => {
      mockAccountInfo.mockRejectedValue(new Error("Not connected"));
      const status = await client.status();
      expect(status.connected).toBe(false);
    });
  });

  describe("shutdown", () => {
    it("should disconnect", async () => {
      mockShutdown.mockResolvedValue(undefined);
      await client.shutdown();
      expect(mockShutdown).toHaveBeenCalledOnce();
      expect(client.connected).toBe(false);
    });
  });
});
