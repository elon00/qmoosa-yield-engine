import { test } from "node:test";
import assert from "node:assert/strict";
import { YieldEngine } from "../dist/index.js";

test("1. P1 Regression: Withdrawal fails closed and reverts all state when strategy liquidity is locked", () => {
  const engine = new YieldEngine();
  engine.registerStrategy({
    strategyId: "illiquid-real-estate-strat",
    allocatedAssetsUsd: 0n,
    availableLiquidityUsd: 0n,
    targetWeightBps: 10_000,
    expectedApyBps: 1200
  });

  // Alice deposits 100,000 USD
  const dep = engine.deposit("0xAlice", 100_000n);
  assert.equal(engine.getUserShares("0xAlice"), dep.sharesMinted);

  // Allocate all idle assets to strategy
  engine.allocateIdleAssets();
  assert.equal(engine.getVaultMetrics().idleAssetsUsd, 0n);

  // Strategy now locks funds: AUM = 100,000 USD, but available immediate liquidity = only 10,000 USD
  engine.setStrategyLiquidity("illiquid-real-estate-strat", 10_000n);

  // Alice attempts to withdraw all her shares (worth ~100,000 USD).
  // Alice owns 100% of the shares! Share balance is sufficient!
  // BUT immediate vault liquidity is only 10,000 USD.
  assert.throws(
    () => engine.withdraw("0xAlice", dep.sharesMinted),
    /Insufficient immediate liquidity/
  );

  // VERIFY REVERSION / NO STATE MUTATION:
  // Alice's shares must NOT be burned!
  assert.equal(engine.getUserShares("0xAlice"), dep.sharesMinted);
  // Total shares must be untouched
  assert.equal(engine.getVaultMetrics().totalShares, dep.sharesMinted);
  // Total assets must be untouched
  assert.equal(engine.getVaultMetrics().totalAssetsUsd, 100_000n);
  // Idle assets must remain 0
  assert.equal(engine.getVaultMetrics().idleAssetsUsd, 0n);
  // Strategy AUM must remain 100,000
  assert.equal(engine.getStrategy("illiquid-real-estate-strat").allocatedAssetsUsd, 100_000n);
  // Conservation invariant must hold
  assert.doesNotThrow(() => engine.verifyConservationInvariant());
});

test("2. Strategy allocation rounding dust is conserved in idle assets", () => {
  const engine = new YieldEngine();
  engine.registerStrategy({
    strategyId: "strat-a",
    allocatedAssetsUsd: 0n,
    availableLiquidityUsd: 0n,
    targetWeightBps: 3333,
    expectedApyBps: 500
  });
  engine.registerStrategy({
    strategyId: "strat-b",
    allocatedAssetsUsd: 0n,
    availableLiquidityUsd: 0n,
    targetWeightBps: 3333,
    expectedApyBps: 500
  });
  engine.registerStrategy({
    strategyId: "strat-c",
    allocatedAssetsUsd: 0n,
    availableLiquidityUsd: 0n,
    targetWeightBps: 3334,
    expectedApyBps: 500
  });

  engine.deposit("0xBob", 100_001n);
  engine.allocateIdleAssets();

  const metrics = engine.getVaultMetrics();
  const sA = engine.getStrategy("strat-a").allocatedAssetsUsd;
  const sB = engine.getStrategy("strat-b").allocatedAssetsUsd;
  const sC = engine.getStrategy("strat-c").allocatedAssetsUsd;

  assert.equal(sA + sB + sC + metrics.idleAssetsUsd, 100_001n);
  assert.doesNotThrow(() => engine.verifyConservationInvariant());
});

test("3. Strategy loss write-down preserves asset and share conservation", () => {
  const engine = new YieldEngine();
  engine.registerStrategy({
    strategyId: "risk-strat",
    allocatedAssetsUsd: 0n,
    availableLiquidityUsd: 0n,
    targetWeightBps: 10_000,
    expectedApyBps: 1000
  });

  engine.deposit("0xCharlie", 100_000n);
  engine.allocateIdleAssets();

  // Audit identifies a $5,000 loss in the strategy
  engine.recordStrategyLoss("risk-strat", 5000n);

  const metrics = engine.getVaultMetrics();
  assert.equal(metrics.totalAssetsUsd, 95_000n);
  assert.equal(engine.getStrategy("risk-strat").allocatedAssetsUsd, 95_000n);
  assert.doesNotThrow(() => engine.verifyConservationInvariant());
});

test("4. Asynchronous withdrawal queue escrows shares and creates ticket", () => {
  const engine = new YieldEngine();
  const dep = engine.deposit("0xAlice", 50_000n);

  const ticket = engine.queueWithdrawal("0xAlice", dep.sharesMinted);
  assert.equal(ticket.user, "0xAlice");
  assert.equal(ticket.status, "PENDING");
  assert.equal(engine.getUserShares("0xAlice"), 0n, "Shares must be escrowed in queue");
});

test("5. Successful withdrawal when strategy liquidity is unlocked", () => {
  const engine = new YieldEngine();
  engine.registerStrategy({
    strategyId: "liquid-strat",
    allocatedAssetsUsd: 0n,
    availableLiquidityUsd: 0n,
    targetWeightBps: 10_000,
    expectedApyBps: 500
  });

  const dep = engine.deposit("0xDavid", 20_000n);
  engine.allocateIdleAssets();

  // Strategy has full liquidity
  const withdrawRes = engine.withdraw("0xDavid", dep.sharesMinted / 2n);
  assert.ok(withdrawRes.assetsReturnedUsd >= 9990n && withdrawRes.assetsReturnedUsd <= 10010n);
  assert.doesNotThrow(() => engine.verifyConservationInvariant());
});
