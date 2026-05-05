import {
  assertLocalRefereeOutcomeSummaryPayload as assertSdkLocalRefereeOutcomeSummaryPayload,
  buildLocalRefereeOutcomeSummaryPayload as buildSdkLocalRefereeOutcomeSummaryPayload,
  type LocalRefereeOutcomeSummaryPayload as SdkLocalRefereeOutcomeSummaryPayload,
  type LocalRefereeReceipt,
} from "@headsdown/sdk/referee";

export {
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

export function assertLocalRefereeOutcomeSummaryPayload(
  value: unknown,
): asserts value is LocalRefereeOutcomeSummaryPayload {
  assertSdkLocalRefereeOutcomeSummaryPayload(value);

  if (value.client.kind !== "pi") {
    throw new Error("Outcome summary client kind must be pi.");
  }
}

export function buildLocalRefereeOutcomeSummaryPayload(
  input: BuildLocalRefereeOutcomeSummaryPayloadInput,
): LocalRefereeOutcomeSummaryPayload {
  const client =
    "client" in input ? input.client : { kind: "pi" as const, version: input.clientVersion };

  if (client.kind !== "pi") {
    throw new Error("Outcome summary client kind must be pi.");
  }

  const payload = buildSdkLocalRefereeOutcomeSummaryPayload({
    receipt: input.receipt,
    client,
    executionMode: input.executionMode,
  });

  assertLocalRefereeOutcomeSummaryPayload(payload);
  return payload;
}
