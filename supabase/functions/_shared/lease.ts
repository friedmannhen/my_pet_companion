// Session lease constants (plan §12): "exactly one live client instance per
// user at a time." Heartbeat every 20s; a lease is stale (reclaimable) once
// ~3.75x the heartbeat interval has passed without one, tolerating a couple
// missed beats from a slow network without false-evicting an active client.
export const HEARTBEAT_INTERVAL_MS = 20_000;
export const LEASE_TTL_MS = 75_000;
