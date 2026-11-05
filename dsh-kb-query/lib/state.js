/**
 * dsh-kb-query — session → active knowledge base map (pure, in-memory).
 *
 * The host keeps one entry per session id, holding the KB id + display-name
 * snapshot the user picked in the composer. Per-session isolation is the
 * whole point: one session on KB A and another on KB B never see each
 * other's mapping. The browser half re-arms the current session on every
 * render (localStorage + POST /kb/select), so a host restart loses at most
 * one render's selection and self-heals (plan R7).
 */

/**
 * @typedef {{id: string, name: string}} ActiveKb
 *   id — the KB identifier (the OWUI UUID; the retrieval collection_name);
 *   name — display-name snapshot (falls back to the id when absent).
 */

/**
 * @returns {{
 *   set: (sessionId: string, kb: {id: string, name?: string} | null, allowedIds?: string[] | Set<string>) => boolean,
 *   get: (sessionId: string | unknown) => ActiveKb | null,
 *   clear: (sessionId: string) => void,
 *   clearAll: () => void,
 *   size: number,
 * }}
 */
export function makeSessionKbState() {
  /** @type {Map<string, ActiveKb>} */
  const map = new Map();
  return {
    /**
     * Set (or clear, with null) a session's active KB.
     * @param {string} sessionId
     * @param {{id: string, name?: string} | null} kb
     * @param {string[] | Set<string>} [allowedIds] KB whitelist; a non-null
     *        kb outside it is refused (fail-closed against arbitrary
     *        collection names). Omitted = no whitelist check (tests).
     * @returns {boolean} true when the map changed
     * @throws {TypeError} malformed sessionId/kb record, or whitelist miss
     */
    set(sessionId, kb, allowedIds) {
      if (typeof sessionId !== "string" || sessionId === "") {
        throw new TypeError("state.set: sessionId must be a non-empty string");
      }
      if (kb === null || kb === undefined) {
        map.delete(sessionId);
        return true;
      }
      if (kb === null || typeof kb !== "object" || typeof kb.id !== "string" || kb.id === "") {
        throw new TypeError("state.set: kb must be {id: string} or null");
      }
      if (allowedIds !== undefined) {
        const allowed = allowedIds instanceof Set ? allowedIds : new Set(allowedIds);
        if (!allowed.has(kb.id)) {
          throw new TypeError("state.set: kbId is not in the allowed knowledge bases");
        }
      }
      map.set(sessionId, {
        id: kb.id,
        name: typeof kb.name === "string" && kb.name !== "" ? kb.name : kb.id,
      });
      return true;
    },
    /**
     * @param {string | unknown} sessionId
     * @returns {ActiveKb | null} the session's active KB (non-string session
     * ids read as absent instead of throwing).
     */
    get(sessionId) {
      if (typeof sessionId !== "string") return null;
      return map.get(sessionId) ?? null;
    },
    /** @param {string} sessionId */
    clear(sessionId) {
      map.delete(sessionId);
    },
    /** @returns {void} */
    clearAll() {
      map.clear();
    },
    get size() {
      return map.size;
    },
  };
}
