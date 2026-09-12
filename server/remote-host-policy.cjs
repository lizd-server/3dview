"use strict";

const REMOTE_HOST_ALLOWLIST_ENV = "REMOTE_VIEWER_ALLOWED_HOSTS";
const DEFAULT_REMOTE_HOSTS = Object.freeze(["hl_gpu_2", "126781"]);
const REMOTE_HOST_PATTERN = /^(?!-)[A-Za-z0-9_.@-]{1,128}$/;

function createRemoteHostPolicy(configuredHosts) {
  const allowedHosts = parseAllowedRemoteHosts(configuredHosts);
  return Object.freeze({
    isAllowed(host) {
      return REMOTE_HOST_PATTERN.test(host) && allowedHosts.has(host);
    },
  });
}

function parseAllowedRemoteHosts(configuredHosts) {
  const hosts = configuredHosts === undefined
    ? DEFAULT_REMOTE_HOSTS
    : configuredHosts.split(",").map((host) => host.trim()).filter(Boolean);

  for (const host of hosts) {
    if (!REMOTE_HOST_PATTERN.test(host)) {
      throw new Error(
        `${REMOTE_HOST_ALLOWLIST_ENV} contains an invalid SSH host alias: ${JSON.stringify(host)}`,
      );
    }
  }

  return new Set(hosts);
}

module.exports = {
  DEFAULT_REMOTE_HOSTS,
  REMOTE_HOST_ALLOWLIST_ENV,
  REMOTE_HOST_PATTERN,
  createRemoteHostPolicy,
  parseAllowedRemoteHosts,
};
