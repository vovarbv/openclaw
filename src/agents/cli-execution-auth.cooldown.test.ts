import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import { testing as cliBackendsTesting } from "./cli-backends.test-support.js";
import { resolveCliExecutionAuthProfileId } from "./cli-execution-auth.js";
import { resolveCliSessionReuse } from "./cli-session.js";

const now = 1_800_000_000_000;
const binding = { sessionId: "native-session", authProfileId: "anthropic:old" };

describe("CLI account cooldown continuation", () => {
  let store: AuthProfileStore;

  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    cliBackendsTesting.setDepsForTest({
      resolveRuntimeCliBackends: () => [
        {
          id: "claude-cli",
          modelProvider: "anthropic",
          pluginId: "anthropic",
          config: { command: "claude" },
        },
      ],
      resolvePluginSetupCliBackend: () => undefined,
    });
    store = {
      version: 1,
      profiles: {
        "anthropic:old": { type: "token", provider: "anthropic", token: "test-old" },
        "anthropic:next": { type: "token", provider: "anthropic", token: "test-next" },
      },
      order: { anthropic: ["anthropic:old", "anthropic:next"] },
      usageStats: {
        "anthropic:old": {
          cooldownUntil: now + 60_000,
          cooldownReason: "rate_limit",
          cooldownModel: "model-a",
        },
      },
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cliBackendsTesting.resetDepsForTest();
  });

  const resolve = (
    source: "auto" | "user" = "auto",
    selected = "anthropic:old",
    modelId = "model-a",
  ) =>
    resolveCliExecutionAuthProfileId({
      cliExecutionProvider: "claude-cli",
      authProfileProvider: "anthropic",
      modelId,
      config: {},
      agentDir: "/unused",
      sessionBinding: binding,
      selected: { authProfileId: selected, authProfileIdSource: source },
      loadAuthProfileStoreForRuntimeAsync: async () => store,
    });

  it.each(["anthropic:old", "anthropic:next"])(
    "continues on an available account with automatic selection %s",
    async (selected) => {
      const profileId = await resolve("auto", selected);
      expect(profileId).toBe("anthropic:next");
      expect(
        resolveCliSessionReuse({ binding, authProfileId: profileId, authEpochVersion: 1 }),
      ).toEqual({ mode: "invalidate", invalidatedReason: "auth-profile" });
      expect(binding.authProfileId).toBe("anthropic:old");
    },
  );

  it("does not rotate for a different model's cooldown", async () => {
    expect(await resolve("auto", "anthropic:next", "model-b")).toBe("anthropic:old");
  });

  it("retains an explicit user lock even while it is in cooldown", async () => {
    expect(await resolve("user")).toBe("anthropic:old");
  });

  it("keeps healthy session affinity despite a different automatic preference", async () => {
    store.usageStats = {};
    expect(await resolve("auto", "anthropic:next")).toBe("anthropic:old");
  });

  it("retains the recorded account if no healthy alternative exists", async () => {
    store.usageStats!["anthropic:next"] = {
      disabledUntil: now + 120_000,
      disabledReason: "billing",
    };
    expect(await resolve()).toBe("anthropic:old");
  });

  it("does not escape an authored order to an unlisted account", async () => {
    store.order = { anthropic: ["anthropic:old"] };
    expect(await resolve()).toBe("anthropic:old");
  });

  it("rotates a disabled account without selecting API-key billing", async () => {
    store.usageStats!["anthropic:old"] = { disabledUntil: now + 60_000, disabledReason: "billing" };
    store.profiles["anthropic:api"] = { type: "api_key", provider: "anthropic", key: "test-key" };
    store.order!.anthropic = ["anthropic:old", "anthropic:api", "anthropic:next"];
    expect(await resolve()).toBe("anthropic:next");
  });
});
