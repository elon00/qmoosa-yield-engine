import { test } from "node:test";
import assert from "node:assert/strict";
import { YieldEngine } from "../dist/index.js";

test("1. Deposit creates shares and updates idle assets", () => {
  const engine = new YieldEngine();
  const res = engine.deposit("alice", 100_000n);

  assert.ok(res.sharesMinted > 0n);
  assert.equal(engine.getUserShares("alice"), res.sharesMinted);

  const metrics = engine.getVaultMetrics();
  assert.equal(metrics.totalAssetsUsd, 100_000n);
  assert.equal(metrics.idleAssetsUsd, 100_000n);
});

test("2. Strategy registration and idle asset allocation", () => {
  const engine = new YieldEngine();
  engine.registerStrategy({
    strategyId: "lending-pool-v1",
    allocatedAssetsUsd: 0n,
    targetWeightBps: 6000, // 60%
    expectedApyBps: 800
  });
  engine.registerStrategy({
    strategyId: "staking-rewards-v1",
    allocatedAssetsUsd: 0n,
    targetWeightBps: 4000, // 40%
    expectedApyBps: 1200
  });

  engine.deposit("alice", 100_000n);
  engine.allocateIdleAssets();

  const metrics = engine.getVaultMetrics();
  assert.equal(metrics.idleAssetsUsd, 0n);
});

test("3. Harvest compounding increases vault assets and share price", () => {
  const engine = new YieldEngine();
  engine.registerStrategy({
    strategyId: "lending-strat",
    allocatedAssetsUsd: 0n,
    targetWeightBps: 10_000,
    expectedApyBps: 1000
  });

  engine.deposit("alice", 100_000n);
  engine.allocateIdleAssets();

  const metricsPre = engine.getVaultMetrics();

  // Harvest generates 10,000 gross yield (10% fee = 1,000, net = 9,000)
  const harvestRes = engine.harvest("lending-strat", 10_000n);
  assert.equal(harvestRes.feeUsd, 1000n);
  assert.equal(harvestRes.netCompoundedUsd, 9000n);

  const metricsPost = engine.getVaultMetrics();
  assert.equal(metricsPost.totalAssetsUsd, 109_000n);
  assert.ok(metricsPost.sharePrice > metricsPre.sharePrice);
});

test("4. Withdrawal burns shares and returns proportional assets", () => {
  const engine = new YieldEngine();
  const dep = engine.deposit("alice", 100_000n);

  // Alice withdraws half her shares
  const halfShares = dep.sharesMinted / 2n;
  const withdrawRes = engine.withdraw("alice", halfShares);

  assert.ok(withdrawRes.assetsReturnedUsd >= 49_990n && withdrawRes.assetsReturnedUsd <= 50_010n);
  assert.equal(engine.getUserShares("alice"), dep.sharesMinted - halfShares);
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
