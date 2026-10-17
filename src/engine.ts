import { VaultState, StrategyAllocation, QueuedWithdrawal } from "./types.js";

export class YieldEngine {
  public static readonly BPS_DIVISOR = 10_000n;
  public static readonly VIRTUAL_OFFSET = 1_000n;
  public static readonly VIRTUAL_ASSETS = 1n;

  private vault: VaultState;
  private nextQueueId: bigint = 1n;

  constructor(vaultId: string = "qmoosa-usdc-vault", asset: string = "USDC") {
    this.vault = {
      vaultId,
      asset,
      totalAssetsUsd: 0n,
      totalShares: 0n,
      idleAssetsUsd: 0n,
      strategies: new Map(),
      userShares: new Map(),
      withdrawalQueue: [],
      performanceFeeBps: 1000 // 10%
    };
  }

  public registerStrategy(strategy: StrategyAllocation): void {
    if (this.vault.strategies.has(strategy.strategyId)) {
      throw new Error(`Strategy ${strategy.strategyId} already registered`);
    }
    const availableLiquidity = strategy.availableLiquidityUsd !== undefined
      ? strategy.availableLiquidityUsd
      : strategy.allocatedAssetsUsd;

    this.vault.strategies.set(strategy.strategyId, {
      ...strategy,
      availableLiquidityUsd: availableLiquidity
    });
  }

  public deposit(user: string, assetsUsd: bigint): { sharesMinted: bigint } {
    if (assetsUsd <= 0n) {
      throw new Error("Deposit amount must be strictly greater than zero");
    }
    if (!user || user.trim().length === 0) {
      throw new Error("User address must not be empty");
    }

    // ERC-4626 standard conversion with virtual assets and shares
    const numerator = assetsUsd * (this.vault.totalShares + YieldEngine.VIRTUAL_OFFSET);
    const denominator = this.vault.totalAssetsUsd + YieldEngine.VIRTUAL_ASSETS;
    const sharesMinted = numerator / denominator;

    if (sharesMinted <= 0n) {
      throw new Error("Deposit produces zero shares: transaction rejected to prevent dilution");
    }

    // Atomic state update
    this.vault.totalAssetsUsd += assetsUsd;
    this.vault.idleAssetsUsd += assetsUsd;
    this.vault.totalShares += sharesMinted;

    const currentShares = this.vault.userShares.get(user) ?? 0n;
    this.vault.userShares.set(user, currentShares + sharesMinted);

    this.verifyConservationInvariant();
    return { sharesMinted };
  }

  /**
   * Immediate withdrawal. Fails closed with rollback/no-op semantics if immediate available liquidity
   * (idle assets + strategy available liquidity) cannot satisfy the full payout.
   */
  public withdraw(user: string, sharesToBurn: bigint): { assetsReturnedUsd: bigint } {
    if (sharesToBurn <= 0n) {
      throw new Error("Shares to burn must be strictly positive");
    }
    const currentShares = this.vault.userShares.get(user) ?? 0n;
    if (currentShares < sharesToBurn) {
      throw new Error(`Insufficient share balance: user holds ${currentShares}, requested ${sharesToBurn}`);
    }

    const numerator = sharesToBurn * (this.vault.totalAssetsUsd + YieldEngine.VIRTUAL_ASSETS);
    const denominator = this.vault.totalShares + YieldEngine.VIRTUAL_OFFSET;
    const assetsReturnedUsd = numerator / denominator;

    if (assetsReturnedUsd <= 0n) {
      throw new Error("Withdrawal evaluates to zero assets");
    }

    // Measure immediate liquid assets (NOT total illiquid AUM)
    const totalAvailableLiquidity = this.vault.idleAssetsUsd + Array.from(this.vault.strategies.values()).reduce(
      (sum, s) => sum + s.availableLiquidityUsd,
      0n
    );

    // Fail closed: if available liquidity is insufficient, REVERT without mutating any state
    if (assetsReturnedUsd > totalAvailableLiquidity) {
      throw new Error(
        `Insufficient immediate liquidity: requested ${assetsReturnedUsd}, available liquid ${totalAvailableLiquidity}`
      );
    }

    // Pull from idle assets first, then unlocked strategy liquidity
    if (this.vault.idleAssetsUsd < assetsReturnedUsd) {
      const deficit = assetsReturnedUsd - this.vault.idleAssetsUsd;
      let pulled = 0n;
      for (const strat of this.vault.strategies.values()) {
        const needed = deficit - pulled;
        const canPull = strat.availableLiquidityUsd > needed ? needed : strat.availableLiquidityUsd;
        strat.availableLiquidityUsd -= canPull;
        strat.allocatedAssetsUsd -= canPull;
        pulled += canPull;
        if (pulled >= deficit) break;
      }
      this.vault.idleAssetsUsd = 0n;
    } else {
      this.vault.idleAssetsUsd -= assetsReturnedUsd;
    }

    this.vault.totalAssetsUsd -= assetsReturnedUsd;
    this.vault.totalShares -= sharesToBurn;
    this.vault.userShares.set(user, currentShares - sharesToBurn);

    this.verifyConservationInvariant();
    return { assetsReturnedUsd };
  }

  /**
   * Enqueues an asynchronous withdrawal request when strategy liquidity is locked.
   */
  public queueWithdrawal(user: string, sharesToBurn: bigint): QueuedWithdrawal {
    if (sharesToBurn <= 0n) throw new Error("Shares to burn must be strictly positive");
    const currentShares = this.vault.userShares.get(user) ?? 0n;
    if (currentShares < sharesToBurn) {
      throw new Error(`Insufficient share balance: user holds ${currentShares}, requested ${sharesToBurn}`);
    }

    const numerator = sharesToBurn * (this.vault.totalAssetsUsd + YieldEngine.VIRTUAL_ASSETS);
    const denominator = this.vault.totalShares + YieldEngine.VIRTUAL_OFFSET;
    const assetsExpectedUsd = numerator / denominator;

    // Escrow user shares
    this.vault.userShares.set(user, currentShares - sharesToBurn);

    const queued: QueuedWithdrawal = {
      id: `REQ-${this.nextQueueId++}`,
      user,
      sharesToBurn,
      assetsExpectedUsd,
      requestedAt: Date.now(),
      status: "PENDING"
    };

    this.vault.withdrawalQueue.push(queued);
    return { ...queued };
  }

  public allocateIdleAssets(): void {
    if (this.vault.idleAssetsUsd <= 0n) return;

    let totalWeight = 0;
    for (const strat of this.vault.strategies.values()) {
      totalWeight += strat.targetWeightBps;
    }
    if (totalWeight === 0) return;

    const toAllocate = this.vault.idleAssetsUsd;
    let allocatedSum = 0n;

    for (const strat of this.vault.strategies.values()) {
      const alloc = (toAllocate * BigInt(strat.targetWeightBps)) / BigInt(totalWeight);
      strat.allocatedAssetsUsd += alloc;
      strat.availableLiquidityUsd += alloc;
      allocatedSum += alloc;
    }

    // Preserve rounding remainder in idle assets
    this.vault.idleAssetsUsd -= allocatedSum;
    this.verifyConservationInvariant();
  }

  /**
   * Records an audited loss or write-down in a strategy.
   */
  public recordStrategyLoss(strategyId: string, lossUsd: bigint): void {
    const strat = this.vault.strategies.get(strategyId);
    if (!strat) throw new Error(`Strategy ${strategyId} not found`);
    if (lossUsd <= 0n) throw new RangeError("Loss must be positive");

    const actualLoss = lossUsd > strat.allocatedAssetsUsd ? strat.allocatedAssetsUsd : lossUsd;
    strat.allocatedAssetsUsd -= actualLoss;
    strat.availableLiquidityUsd = strat.availableLiquidityUsd > actualLoss
      ? strat.availableLiquidityUsd - actualLoss
      : 0n;

    this.vault.totalAssetsUsd -= actualLoss;
    this.verifyConservationInvariant();
  }

  public setStrategyLiquidity(strategyId: string, availableLiquidityUsd: bigint): void {
    const strat = this.vault.strategies.get(strategyId);
    if (!strat) throw new Error(`Strategy ${strategyId} not found`);
    if (availableLiquidityUsd > strat.allocatedAssetsUsd) {
      throw new RangeError("Available liquidity cannot exceed total allocated AUM");
    }
    strat.availableLiquidityUsd = availableLiquidityUsd;
  }

  public harvest(strategyId: string, grossYieldUsd: bigint): { netCompoundedUsd: bigint; feeUsd: bigint } {
    const strat = this.vault.strategies.get(strategyId);
    if (!strat) throw new Error(`Strategy ${strategyId} not found`);
    if (grossYieldUsd <= 0n) return { netCompoundedUsd: 0n, feeUsd: 0n };

    const feeUsd = (grossYieldUsd * BigInt(this.vault.performanceFeeBps)) / YieldEngine.BPS_DIVISOR;
    const netCompoundedUsd = grossYieldUsd - feeUsd;

    strat.allocatedAssetsUsd += netCompoundedUsd;
    strat.availableLiquidityUsd += netCompoundedUsd;
    this.vault.totalAssetsUsd += netCompoundedUsd;

    this.verifyConservationInvariant();
    return { netCompoundedUsd, feeUsd };
  }

  public verifyConservationInvariant(): void {
    const strategyTotal = Array.from(this.vault.strategies.values()).reduce(
      (sum, s) => sum + s.allocatedAssetsUsd,
      0n
    );
    const totalAccounted = this.vault.idleAssetsUsd + strategyTotal;
    if (totalAccounted !== this.vault.totalAssetsUsd) {
      throw new Error(
        `Asset conservation invariant violated! Total accounted: ${totalAccounted}, totalAssetsUsd: ${this.vault.totalAssetsUsd}`
      );
    }
  }

  public getVaultMetrics(): {
    totalAssetsUsd: bigint;
    totalShares: bigint;
    idleAssetsUsd: bigint;
    sharePrice: number;
  } {
    const assetsWithVirtual = this.vault.totalAssetsUsd + YieldEngine.VIRTUAL_ASSETS;
    const sharesWithVirtual = this.vault.totalShares + YieldEngine.VIRTUAL_OFFSET;
    const sharePrice = Number((assetsWithVirtual * YieldEngine.VIRTUAL_OFFSET * 10_000n) / sharesWithVirtual) / 10_000;

    return {
      totalAssetsUsd: this.vault.totalAssetsUsd,
      totalShares: this.vault.totalShares,
      idleAssetsUsd: this.vault.idleAssetsUsd,
      sharePrice
    };
  }

  public getUserShares(user: string): bigint {
    return this.vault.userShares.get(user) ?? 0n;
  }

  public getStrategy(strategyId: string): StrategyAllocation | undefined {
    const strat = this.vault.strategies.get(strategyId);
    return strat ? { ...strat } : undefined;
  }
}
