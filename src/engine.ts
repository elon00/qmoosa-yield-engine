import { VaultState, StrategyAllocation } from "./types.js";

export class YieldEngine {
  public static readonly BPS_DIVISOR = 10_000n;
  public static readonly VIRTUAL_OFFSET = 1_000n;

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

    const numerator = (assetsUsd + 1n) * (this.vault.totalShares + YieldEngine.VIRTUAL_OFFSET);
    const denominator = this.vault.totalAssetsUsd + 1n;
    const sharesMinted = numerator / denominator;

    if (sharesMinted <= 0n) {
      throw new Error("Deposit produces zero shares: transaction rejected to prevent dilution");
    }

    // Update vault state
    this.vault.totalAssetsUsd += assetsUsd;
    this.vault.idleAssetsUsd += assetsUsd;
    this.vault.totalShares += sharesMinted;

    const currentShares = this.vault.userShares.get(user) ?? 0n;
    this.vault.userShares.set(user, currentShares + sharesMinted);

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

    const numerator = sharesToBurn * (this.vault.totalAssetsUsd + 1n);
    const denominator = this.vault.totalShares + YieldEngine.VIRTUAL_OFFSET;
    const assetsReturnedUsd = numerator / denominator;

    if (assetsReturnedUsd <= 0n) {
      throw new Error("Withdrawal evaluates to zero assets");
    }

    // If idle assets are insufficient, pull from strategies proportionally
    if (this.vault.idleAssetsUsd < assetsReturnedUsd) {
      const deficit = assetsReturnedUsd - this.vault.idleAssetsUsd;
      let pulled = 0n;
      for (const strat of this.vault.strategies.values()) {
        const canPull = strat.allocatedAssetsUsd > (deficit - pulled) ? (deficit - pulled) : strat.allocatedAssetsUsd;
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
    for (const strat of this.vault.strategies.values()) {
      const alloc = (toAllocate * BigInt(strat.targetWeightBps)) / BigInt(totalWeight);
      strat.allocatedAssetsUsd += alloc;
    }
    this.vault.idleAssetsUsd = 0n;
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

    return { netCompoundedUsd, feeUsd };
  }

  public getVaultMetrics(): {
    totalAssetsUsd: bigint;
    totalShares: bigint;
    idleAssetsUsd: bigint;
    sharePrice: number;
  } {
    const assetsWithVirtual = this.vault.totalAssetsUsd + 1n;
    const sharesWithVirtual = this.vault.totalShares + YieldEngine.VIRTUAL_OFFSET;
    const sharePrice = Number((assetsWithVirtual * 10_000n) / sharesWithVirtual) / 10_000;

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
}
