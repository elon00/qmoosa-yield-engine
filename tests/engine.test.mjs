import { test } from "node:test";
import assert from "node:assert/strict";
import { YieldEngine } from "../dist/index.js";

test("1. Deposit creates shares and updates idle assets with exact mathematical model", () => {
  const engine = new YieldEngine();
  // Single unit deposit: (1 * 1000) / 1 = 1,000 shares
  const res1 = engine.deposit("alice", 1n);
  assert.equal(res1.sharesMinted, 1000n, "Must mint exact 1,000 shares for 1 unit on empty vault");
  assert.equal(engine.getUserShares("alice"), 1000n);

  // Subsequent deposit: 99 assets
  const res2 = engine.deposit("bob", 99n);
  assert.equal(res2.sharesMinted, 99_000n);

  const metrics = engine.getVaultMetrics();
  assert.equal(metrics.totalAssetsUsd, 100n);
  assert.equal(metrics.idleAssetsUsd, 100n);
  assert.equal(metrics.totalShares, 100_000n);
});

test("2. Strategy registration and idle asset allocation with rounding conservation", () => {
  const engine = new YieldEngine();
  // 3 strategies with odd weights that induce rounding remainders
  engine.registerStrategy({
    strategyId: "strat-1",
    allocatedAssetsUsd: 0n,
    targetWeightBps: 3333,
    expectedApyBps: 800
  });
  engine.registerStrategy({
    strategyId: "strat-2",
    allocatedAssetsUsd: 0n,
    targetWeightBps: 3333,
    expectedApyBps: 800
  });
  engine.registerStrategy({
    strategyId: "strat-3",
    allocatedAssetsUsd: 0n,
    targetWeightBps: 3334,
    expectedApyBps: 800
  });

  engine.deposit("alice", 100_001n);
  engine.allocateIdleAssets();

  // Verify that asset conservation holds 100% exactly down to the wei
  assert.doesNotThrow(() => engine.verifyConservationInvariant());
  const metrics = engine.getVaultMetrics();
  const s1 = engine.getStrategy("strat-1").allocatedAssetsUsd;
  const s2 = engine.getStrategy("strat-2").allocatedAssetsUsd;
  const s3 = engine.getStrategy("strat-3").allocatedAssetsUsd;
  assert.equal(s1 + s2 + s3 + metrics.idleAssetsUsd, 100_001n);
});

test("3. Independent strategy liquidity check and atomic state rollback on withdrawal failure", () => {
  const engine = new YieldEngine();
  engine.registerStrategy({
    strategyId: "real-estate-lending",
    allocatedAssetsUsd: 0n,
    targetWeightBps: 10_000,
    expectedApyBps: 1200
  });

  const dep = engine.deposit("alice", 100_000n);
  engine.allocateIdleAssets();

  // Strategy locks all capital (e.g. 30-day unbonding): liquidAssetsUsd = 0n
  engine.setStrategyLiquidity("real-estate-lending", 0n);

  const preMetrics = engine.getVaultMetrics();
  const preAliceShares = engine.getUserShares("alice");

  // Alice holds 100% of the vault shares, but withdrawal MUST FAIL closed due to illiquid assets!
  assert.throws(
    () => engine.withdraw("alice", dep.sharesMinted),
    /Insufficient liquid strategy assets/
  );

  // Verify Atomic Rollback: NO user shares burned, NO vault assets corrupted
  const postMetrics = engine.getVaultMetrics();
  const postAliceShares = engine.getUserShares("alice");
  assert.equal(postAliceShares, preAliceShares, "User shares must be fully restored by atomic rollback");
  assert.equal(postMetrics.totalAssetsUsd, preMetrics.totalAssetsUsd, "Total assets must remain intact");
  assert.equal(postMetrics.totalShares, preMetrics.totalShares, "Total shares must remain intact");
  assert.doesNotThrow(() => engine.verifyConservationInvariant());
});

test("4. Withdrawal burns shares and returns proportional assets when liquidity is available", () => {
  const engine = new YieldEngine();
  const dep = engine.deposit("alice", 100_000n);

  // Alice withdraws half her shares
  const halfShares = dep.sharesMinted / 2n;
  const withdrawRes = engine.withdraw("alice", halfShares);

  assert.ok(withdrawRes.assetsReturnedUsd >= 49_990n && withdrawRes.assetsReturnedUsd <= 50_010n);
  assert.equal(engine.getUserShares("alice"), dep.sharesMinted - halfShares);
  assert.doesNotThrow(() => engine.verifyConservationInvariant());
});

test("5. Fail-closed negative controls: over-withdrawal and zero deposit", () => {
  const engine = new YieldEngine();
  engine.deposit("alice", 10_000n);

  assert.throws(
    () => engine.deposit("alice", 0n),
    /Deposit amount must be strictly greater than zero/
  );

  assert.throws(
    () => engine.withdraw("alice", 1_000_000_000_000n),
    /Insufficient share balance/
  );
});
