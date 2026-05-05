import {
  buildLocalRefereeOutcomeSummaryPayload as buildSdkLocalRefereeOutcomeSummaryPayload,
  type LocalRefereeOutcomeSummaryPayload as SdkLocalRefereeOutcomeSummaryPayload,
  type LocalRefereeReceipt,
} from "@headsdown/sdk/referee";

export {
  assertLocalRefereeOutcomeSummaryPayload,
  assertLocalRefereeOutcomeSummaryPayloadIsSafe,
  renderLocalRefereeOutcomeSharePreview,
  shouldShareLocalRefereeOutcomeSummary,
} from "@headsdown/sdk/referee";

export type {
  LocalRefereeOutcomeShareChoice,
  LocalRefereeOutcomeSharingConfig,
  LocalRefereeOutcomeSharingPreference,
} from "@headsdown/sdk/referee";

export type LocalRefereeOutcomeSummaryPayload = Omit<
  SdkLocalRefereeOutcomeSummaryPayload,
  "client"
> & {
  client: {
    kind: "pi";
    version: string;
  };
};

export type BuildLocalRefereeOutcomeSummaryPayloadInput = {
  receipt: LocalRefereeReceipt;
  executionMode?: "local_only" | "hosted";
} & (
  | {
      client: LocalRefereeOutcomeSummaryPayload["client"];
    }
  | {
      clientVersion: string;
    }
);

export function buildLocalRefereeOutcomeSummaryPayload(
  input: BuildLocalRefereeOutcomeSummaryPayloadInput,
): LocalRefereeOutcomeSummaryPayload {
  const client =
    "client" in input ? input.client : { kind: "pi" as const, version: input.clientVersion };

  return buildSdkLocalRefereeOutcomeSummaryPayload({
    receipt: input.receipt,
    client,
    executionMode: input.executionMode,
  }) as LocalRefereeOutcomeSummaryPayload;
}
