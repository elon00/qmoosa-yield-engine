export interface StrategyAllocation {
  strategyId: string;
  allocatedAssetsUsd: bigint;
  liquidAssetsUsd?: bigint; // Immediately redeemable liquidity; if omitted, defaults to allocatedAssetsUsd
  targetWeightBps: number; // e.g. 5000 = 50%
  expectedApyBps: number;
}

export interface VaultState {
  vaultId: string;
  asset: string;
  totalAssetsUsd: bigint;
  totalShares: bigint;
  idleAssetsUsd: bigint;
  strategies: Map<string, StrategyAllocation>;
  userShares: Map<string, bigint>;
  performanceFeeBps: number;
}

export interface VaultStateSnapshot {
  totalAssetsUsd: bigint;
  totalShares: bigint;
  idleAssetsUsd: bigint;
  strategies: Map<string, StrategyAllocation>;
  userShares: Map<string, bigint>;
}
