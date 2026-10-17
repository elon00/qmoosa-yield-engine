export interface StrategyAllocation {
  strategyId: string;
  allocatedAssetsUsd: bigint; // Total Assets Under Management (AUM) in strategy
  availableLiquidityUsd: bigint; // Immediate liquid assets available for withdrawal (unlocked)
  targetWeightBps: number; // e.g. 5000 = 50%
  expectedApyBps: number;
}

export interface QueuedWithdrawal {
  id: string;
  user: string;
  sharesToBurn: bigint;
  assetsExpectedUsd: bigint;
  requestedAt: number;
  status: "PENDING" | "FULFILLED" | "CANCELLED";
}

export interface VaultState {
  vaultId: string;
  asset: string;
  totalAssetsUsd: bigint;
  totalShares: bigint;
  idleAssetsUsd: bigint;
  strategies: Map<string, StrategyAllocation>;
  userShares: Map<string, bigint>;
  withdrawalQueue: QueuedWithdrawal[];
  performanceFeeBps: number;
}
