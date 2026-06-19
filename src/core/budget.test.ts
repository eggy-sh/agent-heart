import { describe, it, expect } from "vitest";
import { evaluateBudget, isOverBudget } from "./budget.js";

describe("evaluateBudget", () => {
  it("is ok when no limits are set", () => {
    const e = evaluateBudget({ tokens: 9_999_999, cost_usd: 1000 }, {});
    expect(e.severity).toBe("ok");
    expect(e.tokens.limit).toBeNull();
    expect(e.tokens.pct).toBeNull();
    expect(e.cost_usd.limit).toBeNull();
  });

  it("is ok well under the limit", () => {
    const e = evaluateBudget({ tokens: 50, cost_usd: 1 }, { tokens: 100, cost_usd: 10 });
    expect(e.tokens.pct).toBe(50);
    expect(e.severity).toBe("ok");
  });

  it("warns at or above 80% of a limit", () => {
    const e = evaluateBudget({ tokens: 80, cost_usd: 0 }, { tokens: 100 });
    expect(e.tokens.severity).toBe("warning");
    expect(e.severity).toBe("warning");
  });

  it("is critical at or above 100% of a limit", () => {
    const e = evaluateBudget({ tokens: 0, cost_usd: 10 }, { cost_usd: 10 });
    expect(e.cost_usd.severity).toBe("critical");
    expect(e.severity).toBe("critical");
  });

  it("takes the worst severity across both metrics", () => {
    // tokens ok (50%), cost over (120%)
    const e = evaluateBudget(
      { tokens: 50, cost_usd: 12 },
      { tokens: 100, cost_usd: 10 },
    );
    expect(e.tokens.severity).toBe("ok");
    expect(e.cost_usd.severity).toBe("critical");
    expect(e.severity).toBe("critical");
  });

  it("computes percentages rounded sensibly", () => {
    const e = evaluateBudget({ tokens: 82, cost_usd: 0 }, { tokens: 100 });
    expect(e.tokens.pct).toBe(82);
  });

  it("treats a zero limit as unset rather than dividing by zero", () => {
    const e = evaluateBudget({ tokens: 5, cost_usd: 0 }, { tokens: 0 });
    expect(e.tokens.limit).toBeNull();
    expect(e.tokens.pct).toBeNull();
    expect(e.severity).toBe("ok");
  });
});

describe("isOverBudget", () => {
  it("is true only when a metric is at/over 100%", () => {
    expect(isOverBudget(evaluateBudget({ tokens: 100, cost_usd: 0 }, { tokens: 100 }))).toBe(true);
    expect(isOverBudget(evaluateBudget({ tokens: 99, cost_usd: 0 }, { tokens: 100 }))).toBe(false);
    expect(isOverBudget(evaluateBudget({ tokens: 100, cost_usd: 0 }, {}))).toBe(false);
  });
});
