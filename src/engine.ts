import { VaultState, StrategyAllocation } from "./types.js";

export class YieldEngine {
  public static readonly BPS_DIVISOR = 10_000n;
  public static readonly VIRTUAL_OFFSET = 1_000n;
  public static readonly VIRTUAL_ASSETS = 1n;

  private vault: VaultState;

  constructor(vaultId: string = "qmoosa-usdc-vault", asset: string = "USDC") {
    this.vault = {
      vaultId,
      asset,
      totalAssetsUsd: 0n,
      totalShares: 0n,
      idleAssetsUsd: 0n,
      strategies: new Map(),
      userShares: new Map(),
      performanceFeeBps: 1000 // 10%
    };
  }

  public registerStrategy(strategy: StrategyAllocation): void {
    if (this.vault.strategies.has(strategy.strategyId)) {
      throw new Error(`Strategy ${strategy.strategyId} already registered`);
    }
    this.vault.strategies.set(strategy.strategyId, { ...strategy });
  }

  public deposit(user: string, assetsUsd: bigint): { sharesMinted: bigint } {
    if (assetsUsd <= 0n) {
      throw new Error("Deposit amount must be strictly greater than zero");
    }
    if (!user || user.trim().length === 0) {
      throw new Error("User address must not be empty");
    }

    // ERC-4626 standard conversion with virtual shares and assets:
    // (assets * (totalShares + virtualShares)) / (totalAssets + virtualAssets)
    const numerator = assetsUsd * (this.vault.totalShares + YieldEngine.VIRTUAL_OFFSET);
    const denominator = this.vault.totalAssetsUsd + YieldEngine.VIRTUAL_ASSETS;
    const sharesMinted = numerator / denominator;

    if (sharesMinted <= 0n) {
      throw new Error("Deposit produces zero shares: transaction rejected to prevent dilution");
    }

    // Update vault state atomically
    this.vault.totalAssetsUsd += assetsUsd;
    this.vault.idleAssetsUsd += assetsUsd;
    this.vault.totalShares += sharesMinted;

    const currentShares = this.vault.userShares.get(user) ?? 0n;
    this.vault.userShares.set(user, currentShares + sharesMinted);

    this.verifyConservationInvariant();
    return { sharesMinted };
  }

  public withdraw(user: string, sharesToBurn: bigint): { assetsReturnedUsd: bigint } {
    if (sharesToBurn <= 0n) {
      throw new Error("Shares to burn must be strictly positive");
    }
    const currentShares = this.vault.userShares.get(user) ?? 0n;
    if (currentShares < sharesToBurn) {
      throw new Error(`Insufficient share balance: user holds ${currentShares}, requested ${sharesToBurn}`);
    }

    // ERC-4626 standard conversion: (shares * (totalAssets + virtualAssets)) / (totalShares + virtualShares)
    const numerator = sharesToBurn * (this.vault.totalAssetsUsd + YieldEngine.VIRTUAL_ASSETS);
    const denominator = this.vault.totalShares + YieldEngine.VIRTUAL_OFFSET;
    const assetsReturnedUsd = numerator / denominator;

    if (assetsReturnedUsd <= 0n) {
      throw new Error("Withdrawal evaluates to zero assets");
    }

    // Check aggregate vault liquidity: idle assets + strategy liquidity
    const totalStrategyLiquidity = Array.from(this.vault.strategies.values()).reduce(
      (sum, s) => sum + s.allocatedAssetsUsd,
      0n
    );
    const totalAvailableLiquidity = this.vault.idleAssetsUsd + totalStrategyLiquidity;

    // Fail closed if aggregate liquidity is insufficient: no state changes made
    if (assetsReturnedUsd > totalAvailableLiquidity) {
      throw new Error(
        `Insufficient vault liquidity to process withdrawal: requested ${assetsReturnedUsd}, available ${totalAvailableLiquidity}`
      );
    }

    // Pull from idle assets first, then from strategies
    if (this.vault.idleAssetsUsd < assetsReturnedUsd) {
      const deficit = assetsReturnedUsd - this.vault.idleAssetsUsd;
      let pulled = 0n;
      for (const strat of this.vault.strategies.values()) {
        const needed = deficit - pulled;
        const canPull = strat.allocatedAssetsUsd > needed ? needed : strat.allocatedAssetsUsd;
        strat.allocatedAssetsUsd -= canPull;
        pulled += canPull;
        if (pulled >= deficit) break;
      }

      if (pulled < deficit) {
        throw new Error("Strategy liquidity pull failed to cover deficit");
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
      allocatedSum += alloc;
    }

    // Retain any rounding remainder in idleAssetsUsd rather than discarding it
    this.vault.idleAssetsUsd -= allocatedSum;

    this.verifyConservationInvariant();
  }

  public harvest(strategyId: string, grossYieldUsd: bigint): { netCompoundedUsd: bigint; feeUsd: bigint } {
    const strat = this.vault.strategies.get(strategyId);
    if (!strat) {
      throw new Error(`Strategy ${strategyId} not found`);
    }
    if (grossYieldUsd <= 0n) {
      return { netCompoundedUsd: 0n, feeUsd: 0n };
    }

    const feeUsd = (grossYieldUsd * BigInt(this.vault.performanceFeeBps)) / YieldEngine.BPS_DIVISOR;
    const netCompoundedUsd = grossYieldUsd - feeUsd;

    // Compound directly into strategy
    strat.allocatedAssetsUsd += netCompoundedUsd;
    this.vault.totalAssetsUsd += netCompoundedUsd;

    this.verifyConservationInvariant();
    return { netCompoundedUsd, feeUsd };
  }

  /**
   * Verifies that total accounted assets (idle assets + strategy allocated assets)
   * exactly equals totalAssetsUsd down to the last wei.
   */
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
