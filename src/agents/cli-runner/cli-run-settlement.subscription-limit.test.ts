/** Tests how a CLI-reported subscription reset settles the run's auth profile. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../auth-profiles/types.js";
import { buildPreparedCliRunContext } from "../cli-runner.test-helpers.js";
import { FailoverError } from "../failover-error.js";
import { settlePreparedCliRun } from "./cli-run-settlement.js";

const authMocks = vi.hoisted(() => ({
  markAuthProfileBlockedUntil: vi.fn(async (_params: unknown) => undefined),
  markAuthProfileFailure: vi.fn(async (_params: unknown) => undefined),
}));

vi.mock("../auth-profiles.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../auth-profiles.js")>()),
  ...authMocks,
}));

const profileId = "anthropic:d";
const resetsAtMs = Date.now() + 2 * 60 * 60 * 1000;

function settleFailure(error: FailoverError) {
  const store: AuthProfileStore = {
    version: 1,
    profiles: { [profileId]: { type: "oauth", provider: "anthropic", access: "", refresh: "" } },
  } as unknown as AuthProfileStore;
  const context = {
    ...buildPreparedCliRunContext({ model: "claude-opus-5-5" }),
    effectiveAuthProfileId: profileId,
    authProfileStore: store,
    agentDir: "/tmp/agent",
  };
  return settlePreparedCliRun({
    context,
    run: async () => {
      throw error;
    },
  });
}

function rateLimit(cliSubscriptionLimit?: FailoverError["cliSubscriptionLimit"]) {
  return new FailoverError("You've hit your session limit · resets 2:10pm (Europe/Warsaw)", {
    reason: "rate_limit",
    provider: "claude-cli",
    status: 429,
    ...(cliSubscriptionLimit ? { cliSubscriptionLimit } : {}),
  });
}

describe("CLI subscription-limit settlement", () => {
  beforeEach(() => {
    authMocks.markAuthProfileBlockedUntil.mockClear();
    authMocks.markAuthProfileFailure.mockClear();
  });

  it("blocks the whole profile until the reported account reset", async () => {
    await expect(settleFailure(rateLimit({ resetsAtMs }))).rejects.toThrow("session limit");
    expect(authMocks.markAuthProfileBlockedUntil).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId,
        blockedUntil: resetsAtMs,
        source: "claude_rate_limits",
      }),
    );
    // No model id: the block covers every model on the account.
    expect(authMocks.markAuthProfileBlockedUntil.mock.calls[0]?.[0]).not.toHaveProperty("modelId");
    expect(authMocks.markAuthProfileFailure).not.toHaveBeenCalled();
  });

  it.each([
    { label: "no reset was reported", limit: undefined },
    { label: "the reported reset has passed", limit: { resetsAtMs: Date.now() - 60_000 } },
  ])("keeps the ordinary rate-limit backoff when $label", async ({ limit }) => {
    await expect(settleFailure(rateLimit(limit))).rejects.toThrow("session limit");
    expect(authMocks.markAuthProfileBlockedUntil).not.toHaveBeenCalled();
    expect(authMocks.markAuthProfileFailure).toHaveBeenCalledWith(
      expect.objectContaining({ profileId, reason: "rate_limit" }),
    );
  });
});
