import { VaultState, StrategyAllocation, VaultStateSnapshot } from "./types.js";

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
    this.vault.strategies.set(strategy.strategyId, {
      ...strategy,
      liquidAssetsUsd: strategy.liquidAssetsUsd ?? strategy.allocatedAssetsUsd
    });
  }

  public setStrategyLiquidity(strategyId: string, liquidAssetsUsd: bigint): void {
    const strat = this.vault.strategies.get(strategyId);
    if (!strat) throw new Error(`Strategy ${strategyId} not found`);
    if (liquidAssetsUsd < 0n || liquidAssetsUsd > strat.allocatedAssetsUsd) {
      throw new RangeError("Liquid assets must be between 0 and allocatedAssetsUsd");
    }
    strat.liquidAssetsUsd = liquidAssetsUsd;
  }

  public createSnapshot(): VaultStateSnapshot {
    const strategiesClone = new Map<string, StrategyAllocation>();
    for (const [k, v] of this.vault.strategies.entries()) {
      strategiesClone.set(k, { ...v });
    }
    const userSharesClone = new Map<string, bigint>(this.vault.userShares);

    return {
      totalAssetsUsd: this.vault.totalAssetsUsd,
      totalShares: this.vault.totalShares,
      idleAssetsUsd: this.vault.idleAssetsUsd,
      strategies: strategiesClone,
      userShares: userSharesClone
    };
  }

  public restoreSnapshot(snapshot: VaultStateSnapshot): void {
    this.vault.totalAssetsUsd = snapshot.totalAssetsUsd;
    this.vault.totalShares = snapshot.totalShares;
    this.vault.idleAssetsUsd = snapshot.idleAssetsUsd;
    this.vault.strategies = snapshot.strategies;
    this.vault.userShares = snapshot.userShares;
  }

  public deposit(user: string, assetsUsd: bigint): { sharesMinted: bigint } {
    if (assetsUsd <= 0n) {
      throw new Error("Deposit amount must be strictly greater than zero");
    }
    if (!user || user.trim().length === 0) {
      throw new Error("User address must not be empty");
    }

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

  /**
   * Withdraws assets by burning user shares with independent liquidity checks
   * and transactional atomic rollback if available liquidity cannot supply the deficit.
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

    // Check independent liquid strategy assets (not just allocated assets)
    const totalLiquidStrategyAssets = Array.from(this.vault.strategies.values()).reduce(
      (sum, s) => sum + (s.liquidAssetsUsd ?? s.allocatedAssetsUsd),
      0n
    );
    const totalAvailableLiquidity = this.vault.idleAssetsUsd + totalLiquidStrategyAssets;

    // Fail closed if liquid assets cannot fulfill withdrawal
    if (assetsReturnedUsd > totalAvailableLiquidity) {
      throw new Error(
        `Insufficient liquid strategy assets: requested ${assetsReturnedUsd}, available liquid ${totalAvailableLiquidity}`
      );
    }

    // Snapshot state for atomic rollback protection
    const snapshot = this.createSnapshot();

    try {
      if (this.vault.idleAssetsUsd < assetsReturnedUsd) {
        const deficit = assetsReturnedUsd - this.vault.idleAssetsUsd;
        let pulled = 0n;

        for (const strat of this.vault.strategies.values()) {
          const maxLiquid = strat.liquidAssetsUsd ?? strat.allocatedAssetsUsd;
          const needed = deficit - pulled;
          const canPull = maxLiquid > needed ? needed : maxLiquid;

          strat.allocatedAssetsUsd -= canPull;
          strat.liquidAssetsUsd = maxLiquid - canPull;
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
    } catch (err) {
      // Atomic rollback: restore entire vault state on failure
      this.restoreSnapshot(snapshot);
      throw err;
    }
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
      strat.liquidAssetsUsd = (strat.liquidAssetsUsd ?? 0n) + alloc;
      allocatedSum += alloc;
    }

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
    strat.liquidAssetsUsd = (strat.liquidAssetsUsd ?? 0n) + netCompoundedUsd;
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
