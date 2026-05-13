import {
  createBrowserLease,
  releaseBrowserLease,
  type BrowserLeaseStoreOptions,
} from "../leases.js";
import { leaseEvidence, type BrowserLeaseExecutionContext } from "../leaseIntegration.js";
import {
  runProviderDomFlow,
  runProviderSubmissionFlow,
  type ProviderDomAdapter,
  type ProviderDomFlowContext,
  type ProviderDomFlowResult,
} from "../providerDomFlow.js";
import type {
  BrowserLeaseProvider,
  StoredBrowserLeaseRecord,
} from "../../oracle/v18/browser_lease.js";

export interface ProviderLeaseIntegrationOptions extends BrowserLeaseStoreOptions {
  provider: BrowserLeaseProvider;
  profileIdHash: string;
  ttlSeconds?: number;
  holder?: string;
  commandSummary?: string;
  remoteBrowser?: Record<string, unknown>;
  releaseOnCompletion?: boolean;
}

export interface LeasedProviderResult<T> {
  result: T;
  lease: BrowserLeaseExecutionContext;
}

export interface LeasedProviderDomFlowResult extends ProviderDomFlowResult {
  lease: BrowserLeaseExecutionContext;
}

export async function withProviderLease<T>(
  adapter: Pick<ProviderDomAdapter, "providerName">,
  ctx: ProviderDomFlowContext,
  leaseOptions: ProviderLeaseIntegrationOptions,
  execute: (leasedCtx: ProviderDomFlowContext) => Promise<T>,
): Promise<LeasedProviderResult<T>> {
  const lease = await createBrowserLease(
    {
      provider: leaseOptions.provider,
      profileIdHash: leaseOptions.profileIdHash,
      ttlSeconds: leaseOptions.ttlSeconds,
      holder: leaseOptions.holder,
      commandSummary:
        leaseOptions.commandSummary ?? `oracle browser provider run ${adapter.providerName}`,
      remoteBrowser: leaseOptions.remoteBrowser,
    },
    leaseOptions,
  );

  const state = ctx.state ?? {};
  state.browserLease = leaseEvidence(lease, "acquired");
  const leasedCtx: ProviderDomFlowContext = { ...ctx, state };

  let result: T | null = null;
  let runError: unknown = null;
  let released: StoredBrowserLeaseRecord | null = null;
  let releaseError: unknown = null;
  try {
    result = await execute(leasedCtx);
  } catch (error) {
    runError = error;
  }

  if (leaseOptions.releaseOnCompletion !== false) {
    try {
      released = await releaseBrowserLease(
        {
          provider: leaseOptions.provider,
          profileIdHash: leaseOptions.profileIdHash,
          leaseId: lease.lease_id,
        },
        leaseOptions,
      );
    } catch (error) {
      releaseError = error;
    }
  }

  const finalLease = releaseError
    ? leaseEvidence(lease, "release_failed", releaseError)
    : leaseEvidence(released ?? lease, released ? "released" : "acquired");
  state.browserLease = finalLease;

  if (runError) {
    throw runError;
  }
  if (result === null) {
    throw new Error(`Provider ${adapter.providerName} did not return a result.`);
  }
  return { result, lease: finalLease };
}

export async function runLeasedProviderSubmissionFlow(
  adapter: ProviderDomAdapter,
  ctx: ProviderDomFlowContext,
  leaseOptions: ProviderLeaseIntegrationOptions,
): Promise<BrowserLeaseExecutionContext> {
  const leased = await withProviderLease(adapter, ctx, leaseOptions, async (leasedCtx) => {
    await runProviderSubmissionFlow(adapter, leasedCtx);
    return true;
  });
  return leased.lease;
}

export async function runLeasedProviderDomFlow(
  adapter: ProviderDomAdapter,
  ctx: ProviderDomFlowContext,
  leaseOptions: ProviderLeaseIntegrationOptions,
): Promise<LeasedProviderDomFlowResult> {
  const leased = await withProviderLease(adapter, ctx, leaseOptions, (leasedCtx) =>
    runProviderDomFlow(adapter, leasedCtx),
  );
  return { ...leased.result, lease: leased.lease };
}
