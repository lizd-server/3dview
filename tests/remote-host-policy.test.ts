import assert from "node:assert/strict";
import test from "node:test";

import remoteHostPolicyModule from "../server/remote-host-policy.cjs";

const {
  createRemoteHostPolicy,
  parseAllowedRemoteHosts,
} = remoteHostPolicyModule;

test("the default remote host policy permits only the repository aliases", () => {
  const policy = createRemoteHostPolicy(undefined);

  assert.equal(policy.isAllowed("hl_gpu_2"), true);
  assert.equal(policy.isAllowed("126781"), true);
  assert.equal(policy.isAllowed("other_valid_alias"), false);
});

test("an environment allowlist replaces defaults and matches exact aliases", () => {
  const policy = createRemoteHostPolicy(" research_gpu, user@compute-1, research_gpu ");

  assert.equal(policy.isAllowed("research_gpu"), true);
  assert.equal(policy.isAllowed("user@compute-1"), true);
  assert.equal(policy.isAllowed("hl_gpu_2"), false);
  assert.equal(policy.isAllowed("compute-1"), false);
});

test("configured aliases must pass SSH host syntax validation", () => {
  assert.throws(
    () => parseAllowedRemoteHosts("hl_gpu_2,-oProxyCommand=bad"),
    /invalid SSH host alias/,
  );
  assert.equal(createRemoteHostPolicy("").isAllowed("hl_gpu_2"), false);
});
