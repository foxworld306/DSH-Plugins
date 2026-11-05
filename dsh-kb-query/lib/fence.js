/**
 * dsh-kb-query — browser-trust fence for the /kb* routes.
 *
 * Ported (TypeScript → plain JS) from dsh-better-sidebar's
 * `src/trust-fence.ts` (MIT, Copyright (c) 2026 dsh-external), which is
 * itself behaviorally identical to the /api gateway's fence in
 * @deepseek-ai/dsh-client-connection (src/api-request-trust.ts +
 * src/loopback-hostname.ts). Copied rather than
 * imported because those packages do not export the helpers and a plugin
 * must not depend on their internals.
 *
 * A Host header naming loopback (or a configured trusted authority) passes;
 * cross-site browser markers (`sec-fetch-site: cross-site`, a re-deciding
 * Origin) refuse. This is a DNS-rebinding / cross-site defense, NOT
 * authentication — the SSO gate (if mounted) owns authentication and wraps
 * these routes automatically.
 */

/** The request facts the fence reads (structural subset of IncomingMessage). */
/** @typedef {{headers: object<string, string | string[] | undefined>}} FenceRequest */

/** @param {object<string, string | string[] | undefined>} headers @param {string} name */
function header(headers, name) {
  const value = headers[name];
  return typeof value === "string" ? value : undefined;
}

/** @param {string} authority @returns {URL | undefined} normalized URL of a Host-header authority */
function parseAuthority(authority) {
  try {
    return new URL(`http://${authority}`);
  } catch {
    return undefined;
  }
}

/** @param {string} hostname @returns {boolean} whether the hostname names the local loopback authority */
export function isLoopbackHostname(hostname) {
  if (hostname === "localhost" || hostname === "[::1]") return true;
  const parts = hostname.split(".");
  return (
    parts.length === 4 &&
    parts[0] === "127" &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  );
}

/** @param {string} entry @param {URL} entryUrl @returns {string} canonical authority form */
function canonicalAuthority(entry, entryUrl) {
  const port = entryUrl.port !== "" ? entryUrl.port : new URL(`https://${entry}`).port;
  return port === "" ? entryUrl.hostname : `${entryUrl.hostname}:${port}`;
}

/**
 * @param {URL} hostUrl
 * @param {readonly string[]} trustedHosts
 * @returns {boolean} whether the request authority matches a trustedHosts entry (exact or port-less)
 */
function isTrustedAuthority(hostUrl, trustedHosts) {
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry);
    if (entryUrl === undefined) return false;
    return canonicalAuthority(entry, entryUrl) === entryUrl.hostname
      ? entryUrl.hostname === hostUrl.hostname
      : entryUrl.host === hostUrl.host;
  });
}

/**
 * Decide whether one /kb request may reach the plugin routes.
 * @param {FenceRequest} request node HTTP request facts (headers)
 * @param {readonly string[]} trustedHosts non-loopback authorities this deployment serves
 * @returns {boolean} true when the Host is ours (loopback or trusted) and browser markers are same-origin.
 */
export function isTrustedApiRequest(request, trustedHosts) {
  const host = header(request.headers, "host");
  if (host === undefined) return false;
  const hostUrl = parseAuthority(host);
  if (hostUrl === undefined) return false;
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false;
  if (header(request.headers, "sec-fetch-site") === "cross-site") return false;
  // Origin fence: when a browser attaches an Origin it must name this
  // hostname (the Host fence above already bound the authority, so the port
  // must not re-decide trust). Comparing hostname, not host: some Chromium
  // builds (Edge 151) serialize the Origin of a non-default-port loopback
  // page without the port, and refusing those bricks every /kb route.
  // Absent Origin is fine — the Host fence above already bound the request.
  // The literal "null" (sandboxed iframes, file: pages) is an opaque origin,
  // refused.
  const origin = header(request.headers, "origin");
  if (origin === undefined) return true;
  try {
    return new URL(origin).hostname === hostUrl.hostname;
  } catch {
    return false;
  }
}
