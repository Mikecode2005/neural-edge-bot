export const fmtPrice = (n: number | null | undefined, digits = 5) =>
  n == null || isNaN(n) ? "—" : n.toFixed(digits);

export const fmtPct = (n: number | null | undefined, digits = 2) =>
  n == null || isNaN(n) ? "—" : `${(n * 100).toFixed(digits)}%`;

export const fmtMoney = (n: number | null | undefined, digits = 2) =>
  n == null || isNaN(n)
    ? "—"
    : new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      }).format(n);

export const fmtTime = (epoch: number) =>
  new Date(epoch * 1000).toLocaleTimeString();
