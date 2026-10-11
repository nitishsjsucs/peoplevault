// Limits shared by the Worker, the privacy console and their tests (no dependencies, so the console bundle stays small).

/** Events one audit verification request checks at most. SPEC.md section 30.3.2 set 100 for Workers Free; the committed
 * `npm run bench:cpu` median for a 100-event window was 2.6 ms on the owner's Mac, over the 2.5 ms design target, so
 * the window is 50 (review of 2026-10-11). */
export const AUDIT_VERIFY_WINDOW = 50;

/** Header the privacy console sends on every API call. Reads marked with it never fill the KV cache, so a console
 * session cannot spend the account's 1,000 daily KV writes (shared by four repos; the budget model counts 0 console
 * writes). Setting it only skips cache fills, so a client that forges it gains nothing. */
export const CLIENT_HEADER = "X-PV-Client";
export const CONSOLE_CLIENT = "console";
