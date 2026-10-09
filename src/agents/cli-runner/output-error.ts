import type { CliOutput } from "../cli-output-contracts.js";
import { formatCliOutputError } from "../cli-output.js";
import { classifyFailoverReason } from "../embedded-agent-helpers.js";
import { FailoverError, resolveFailoverStatus } from "../failover-error.js";
import { failoverReasonFromClassification } from "../failover/classification-rules.js";
import { classifyFailoverSignal } from "../failover/classify.js";
import type { FailoverReason } from "../failover/signal.js";

function classifyCliOutputError(params: {
  message: string;
  provider: string;
  status?: number;
}): FailoverReason | null {
  const fromMessage = classifyFailoverReason(params.message, { provider: params.provider });
  // The backend-reported status covers prose no pattern knows, e.g. Claude's
  // "You've hit your session limit" arrives as a 429 without rate-limit wording.
  if (fromMessage || params.status === undefined) {
    return fromMessage;
  }
  return failoverReasonFromClassification(
    classifyFailoverSignal({
      message: params.message,
      provider: params.provider,
      status: params.status,
    }),
  );
}

export function createCliOutputFailoverError(params: {
  output: CliOutput;
  provider: string;
  model: string;
  runId?: string;
  sessionId?: string;
  lane?: string;
}): FailoverError | undefined {
  if (!params.output.errorText) {
    return undefined;
  }
  const message = formatCliOutputError(params.output, {
    runId: params.runId,
    sessionId: params.sessionId,
  });
  const terminalFailure = params.output.terminalFailure?.reason;
  // Record terminal facts before provider hooks can throw or reclassify them;
  // losing a max-turn stop here could replay tools in another model attempt.
  const reason = terminalFailure
    ? terminalFailure === "synthetic_no_response"
      ? "format"
      : "unknown"
    : (classifyCliOutputError({
        message,
        provider: params.provider,
        status: params.output.errorStatus,
      }) ?? "unknown");
  const code = terminalFailure
    ? `cli_${terminalFailure}`
    : reason === "context_overflow"
      ? "cli_context_overflow"
      : undefined;
  const subscriptionLimit = reason === "rate_limit" ? params.output.subscriptionLimit : undefined;
  return new FailoverError(message, {
    reason,
    provider: params.provider,
    model: params.model,
    sessionId: params.sessionId,
    lane: params.lane,
    status: resolveFailoverStatus(reason),
    code,
    rawError: params.output.errorText,
    ...(subscriptionLimit ? { cliSubscriptionLimit: subscriptionLimit } : {}),
  });
}
