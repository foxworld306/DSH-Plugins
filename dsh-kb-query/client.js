/**
 * dsh-kb-query — browser half (composer "知识库" chip, handwritten JS; no
 * build chain, ModuleLoader form per dsh-client-ui-jobs/lib/client.js).
 *
 * The chip sits in `conversation.input.left` (beside the Workspace Write
 * access-mode chip). All traffic goes to the same-origin /kb* routes — the
 * browser never sees the OWUI URL or any key (host half owns those).
 * State: localStorage["dsh-kb-query.v1"] = {kbId, kbName} (browser-level
 * memory of the choice); on every mount the remembered choice re-arms the
 * host's per-session mapping via POST /kb/select (fire-and-forget; a host
 * restart loses the map and this is the self-heal, plan R7).
 * No polling, no store subscriptions — the chip reads the InputZone props
 * snapshot only; requests happen on dropdown open / preview actions.
 */
window.__ModuleLoader__.load({
  id: "dsh-kb-query",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const react = require("react");
    const e = react.createElement;

    const STORAGE_KEY = "dsh-kb-query.v1";
    /** Same-origin host routes (routePrefix defaults to /kb). */
    const ROUTE_LIST = "/kb";
    const ROUTE_SELECT = "/kb/select";
    const ROUTE_QUERY = "/kb/query";
    const ROUTE_SETTINGS = "/kb/settings";
    const ROUTE_SETTINGS_TEST = "/kb/settings/test";

    /**
     * Styles. Uses host alias variables (ui-jobs precedent:
     * --dsw-alias-label-*, --dsw-alias-border-l2, --dsw-specific-menu,
     * --dsw-shadow-lv3); trigger/menu geometry follows ui-jobs.
     * SURFACE TOKENS CARRY FALLBACK CHAINS: a browser that still resolves
     * an OLDER theme module (pre-upgrade cache) lacks the newer token
     * generations (e.g. --dsw-specific-menu) — var() fallbacks keep the
     * surface solid regardless of which theme generation is live. DSH 0.2+
     * renders menus FROSTED: --dsw-specific-menu is a translucent tint and
     * readability comes from backdrop-filter (host value blur(40px)
     * saturate(150%)) — mirrored here so our surfaces match host menus.
     */
    const css =
      ".kbq-root{position:relative;display:inline-flex}" +
      ".kbq-trigger{min-height:24px;cursor:pointer;background:0 0;border:0;border-radius:6px;align-items:center;gap:4px;padding:2px 6px;font-size:12px;line-height:18px;display:inline-flex;color:var(--dsw-alias-label-tertiary);white-space:nowrap}" +
      ".kbq-trigger:hover,.kbq-trigger:focus-visible{color:var(--dsw-alias-label-secondary)}" +
      ".kbq-triggerActive{color:var(--dsw-alias-label-primary)}" +
      ".kbq-triggerDegraded{opacity:.55}" +
      ".kbq-dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-border-l2)}" +
      ".kbq-dotOn{background:var(--dsw-alias-label-secondary)}" +
      ".kbq-chevron{color:var(--dsw-alias-label-tertiary);font-size:10px}" +
      ".kbq-menu{z-index:100;box-sizing:border-box;min-width:240px;border:1px solid var(--dsw-alias-border-l2,#ffffff1f);background:var(--dsw-specific-menu,var(--dsw-alias-bg-layer-3,#262629));-webkit-backdrop-filter:var(--dsw-menu-backdrop-filter,blur(40px) saturate(150%));backdrop-filter:var(--dsw-menu-backdrop-filter,blur(40px) saturate(150%));--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);max-width:min(400px,100vw - 32px);max-height:min(420px,100vh - 140px);box-shadow:var(--dsw-shadow-lv3,0 0 1px 0 #0003,0 12px 32px 0 #00000014);border-radius:12px;flex-direction:column;gap:1px;margin:0;padding:4px;overflow:auto;position:absolute;bottom:calc(100% + 5px);left:0}" +
      ".kbq-section{color:var(--dsw-alias-label-tertiary);flex:none;padding:6px 8px 2px;font-size:11px;line-height:16px}" +
      ".kbq-row{box-sizing:border-box;width:100%;min-height:30px;cursor:pointer;background:0 0;border:0;border-radius:8px;align-items:center;gap:8px;padding:6px 8px;font-size:13px;line-height:18px;color:var(--dsw-alias-label-primary);display:flex}" +
      ".kbq-row:hover{background:var(--dsw-alias-fill-l2)}" +
      ".kbq-rowMuted{color:var(--dsw-alias-label-tertiary)}" +
      ".kbq-rowMuted:disabled{cursor:default;opacity:.6}" +
      ".kbq-rowLabel{min-width:0;white-space:nowrap;text-overflow:ellipsis;flex:1;overflow:hidden;text-align:left}" +
      ".kbq-check{color:var(--dsw-alias-label-secondary);flex:none}" +
      ".kbq-sep{border:0;border-top:1px solid var(--dsw-alias-border-l2);margin:3px 4px;flex:none}" +
      ".kbq-error{color:var(--dsw-alias-label-tertiary);flex:none;padding:6px 8px;font-size:12px;line-height:18px;cursor:default}" +
      ".kbq-preview{border-top:1px solid var(--dsw-alias-border-l2);margin-top:3px;padding-top:4px;flex-direction:column;gap:6px;display:flex}" +
      ".kbq-input{box-sizing:border-box;width:100%;min-height:26px;background:var(--dsw-alias-fill-l2);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:3px 8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);outline:none}" +
      ".kbq-input:focus{border-color:var(--dsw-alias-label-tertiary)}" +
      ".kbq-btn{cursor:pointer;background:0 0;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:3px 10px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);align-self:flex-start}" +
      ".kbq-btn:hover:not(:disabled){background:var(--dsw-alias-fill-l2)}" +
      ".kbq-btn:disabled{cursor:default;opacity:.6}" +
      ".kbq-chunk{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;max-height:150px;overflow:auto;padding:6px 8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);flex:none}" +
      ".kbq-chunkText{white-space:pre-wrap;word-break:break-word}" +
      ".kbq-chunkSource{color:var(--dsw-alias-label-tertiary);margin-top:4px;font-size:11px;line-height:16px}" +
      ".kbq-set{flex-direction:column;gap:8px;max-width:600px;width:100%}" +
      ".kbq-setTitle{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary);line-height:20px}" +
      ".kbq-setHint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}" +
      ".kbq-setRow{display:flex;align-items:center;gap:12px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}" +
      ".kbq-setLabel{flex:none;width:150px;color:var(--dsw-alias-label-tertiary);font-size:12px}" +
      ".kbq-setInput{max-width:420px}" +
      ".kbq-setNum{max-width:80px}" +
      ".kbq-setCheck{display:inline-flex;align-items:center;gap:6px;cursor:pointer}" +
      ".kbq-setOk{color:var(--dsw-alias-label-secondary)}" +
      ".kbq-setErr{color:var(--dsw-alias-label-tertiary)}" +
      ".kbq-setActions{display:flex;gap:8px;align-items:center;margin-top:2px}" +
      ".kbq-setMsg{font-size:12px;line-height:18px}" +
      ".kbq-setTest{display:flex;flex-direction:column;gap:4px;border-top:1px solid var(--dsw-alias-border-l2);padding-top:8px}" +
      ".kbq-setLeg{display:flex;align-items:center;gap:12px;font-size:12px;line-height:18px}" +
      ".kbq-setSelectWrap{position:relative}" +
      ".kbq-setSelect{cursor:pointer;box-sizing:border-box;max-width:460px;min-width:340px;background:var(--dsw-alias-fill-l2);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:3px 8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);display:inline-flex;align-items:center;gap:6px;white-space:nowrap}" +
      ".kbq-setSelect:hover{border-color:var(--dsw-alias-label-tertiary)}" +
      ".kbq-setMenu{bottom:auto;top:calc(100% + 5px);left:0;min-width:380px}" +
      ".kbq-kbcard{display:flex;flex-direction:column;gap:4px;max-width:640px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary)}" +
      ".kbq-kbcardHead{display:flex;align-items:center;gap:8px;flex-wrap:wrap;cursor:pointer}" +
      ".kbq-kbcardTitle{font-weight:600}" +
      ".kbq-kbcardQuery{min-width:0;max-width:320px;white-space:nowrap;text-overflow:ellipsis;overflow:hidden;color:var(--dsw-alias-label-secondary)}" +
      ".kbq-kbcardMeta{color:var(--dsw-alias-label-tertiary);font-size:11px}" +
      ".kbq-kbchunk{cursor:pointer;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:3px 8px}" +
      ".kbq-kbchunk:hover{background:var(--dsw-alias-fill-l2)}" +
      ".kbq-kbchunkHead{display:flex;align-items:center;gap:8px}" +
      ".kbq-kbchunkIdx{flex:none;min-width:18px;height:18px;border-radius:50%;background:var(--dsw-alias-fill-l2);color:var(--dsw-alias-label-secondary);display:inline-flex;align-items:center;justify-content:center;font-size:11px}" +
      ".kbq-kbchunkSrc{min-width:0;flex:1;white-space:nowrap;text-overflow:ellipsis;overflow:hidden;color:var(--dsw-alias-label-secondary)}" +
      ".kbq-kbchunkBody{margin:4px 0 2px;padding:4px 8px;background:var(--dsw-alias-fill-l2);border-radius:6px;white-space:pre-wrap;word-break:break-word;max-height:220px;overflow:auto;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary)}" +
      ".kbq-kbcardErr{color:var(--dsw-alias-label-tertiary)}" +
      ".kbq-cite{cursor:pointer;border-radius:4px;padding:0 2px;background:var(--dsw-alias-fill-l2);color:var(--dsw-alias-label-secondary);font-size:11px;white-space:nowrap}" +
      ".kbq-cite:hover,.kbq-cite:focus-visible{color:var(--dsw-alias-label-primary);outline:none;text-decoration:underline}" +
      ".kbq-citePop{position:fixed;z-index:1000;box-sizing:border-box;width:360px;max-width:calc(100vw - 24px);max-height:min(420px,60vh);overflow:auto;border:1px solid var(--dsw-alias-border-l2,#ffffff1f);background:var(--dsw-specific-menu,var(--dsw-alias-bg-layer-3,#262629));-webkit-backdrop-filter:var(--dsw-menu-backdrop-filter,blur(40px) saturate(150%));backdrop-filter:var(--dsw-menu-backdrop-filter,blur(40px) saturate(150%));box-shadow:var(--dsw-shadow-lv3,0 0 1px 0 #0003,0 12px 32px 0 #00000014);border-radius:12px;padding:10px 12px;display:flex;flex-direction:column;gap:8px}" +
      ".kbq-citePopSrc{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}" +
      ".kbq-citePopText{margin:0;white-space:pre-wrap;word-break:break-word;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary)}";

    /** Simplified Chinese dictionary (the key-set source of truth). */
    const zh = {
      "chip.label": "知识库",
      "chip.open": "选择知识库",
      "chip.degraded": "知识库后端不可用（未配置或不可达）",
      "menu.aria": "知识库",
      "menu.select": "选择",
      "menu.preview": "预览检索",
      "menu.close": "关闭知识库",
      "menu.empty": "未找到知识库",
      "menu.loadError": "列表加载失败 · 点击重试",
      "preview.title": "预览检索",
      "preview.placeholder": "输入要检索的问题",
      "preview.run": "检索",
      "preview.running": "检索中…",
      "preview.none": "无结果",
      "preview.error": "检索失败（{error}）",
      "preview.noKb": "请先选择一个知识库",
      "source": "来源",
      "resultsTruncated": "结果已截断",
      "settings.title": "知识库检索",
      "settings.hint": "运行期覆盖只保存在当前 DSH 进程内，重启后恢复为 profile 配置。",
      "settings.backend": "检索后端",
      "settings.backend.pgvector": "pgvector · 直连 PG document_chunk",
      "settings.backend.owui": "owui · OWUI 检索 API（0.8.12 上游损坏，建议 ≥0.9.5）",
      "settings.rerank": "重排序 rerank",
      "settings.on": "开",
      "settings.off": "关",
      "settings.k": "返回条数 k",
      "settings.fetchK": "候选池 fetchK",
      "settings.topK": "重排上限 topK",
      "settings.embeddingModel": "嵌入模型",
      "settings.credsPg": "PG 只读 DSN",
      "settings.credsEmbed": "嵌入/rerank key",
      "settings.ok": "已配置",
      "settings.missing": "未配置",
      "settings.kbList": "知识库白名单",
      "settings.override": "运行期覆盖",
      "settings.save": "保存",
      "settings.saving": "保存中…",
      "settings.saved": "已保存",
      "settings.reset": "清除覆盖",
      "settings.test": "测试连接",
      "settings.testing": "测试中…",
      "settings.testPg": "PG 连接",
      "settings.testEmbed": "嵌入端点",
      "settings.testRerank": "rerank 端点",
      "settings.loadError": "设置加载失败（{error}）",
      "card.title": "知识库检索",
      "card.running": "检索中…",
      "card.error": "检索失败",
      "card.noData": "无结果数据",
      "card.resultsUnit": "条结果",
      "card.degraded": "重排降级",
      "card.errorDetail": "后端错误（模型已收到错误状态）"
    };
    /** English dictionary, key-identical to the Chinese source of truth. */
    const en = {
      "chip.label": "KB",
      "chip.open": "Choose a knowledge base",
      "chip.degraded": "KB backend unavailable (not configured or unreachable)",
      "menu.aria": "Knowledge base",
      "menu.select": "Select",
      "menu.preview": "Preview retrieval",
      "menu.close": "Turn off knowledge base",
      "menu.empty": "No knowledge bases found",
      "menu.loadError": "Failed to load · click to retry",
      "preview.title": "Preview retrieval",
      "preview.placeholder": "Type a question",
      "preview.run": "Search",
      "preview.running": "Searching…",
      "preview.none": "No results",
      "preview.error": "Retrieval failed ({error})",
      "preview.noKb": "Pick a knowledge base first",
      "source": "Source",
      "resultsTruncated": "Results truncated",
      "settings.title": "Knowledge base retrieval",
      "settings.hint": "Runtime overrides live in the current DSH process only; a restart restores the profile config.",
      "settings.backend": "Backend",
      "settings.backend.pgvector": "pgvector · direct PG document_chunk read",
      "settings.backend.owui": "owui · OWUI retrieval API (broken upstream on 0.8.12, needs ≥0.9.5)",
      "settings.rerank": "Rerank",
      "settings.on": "on",
      "settings.off": "off",
      "settings.k": "Chunk cap k",
      "settings.fetchK": "Candidate pool fetchK",
      "settings.topK": "Rerank cap topK",
      "settings.embeddingModel": "Embedding model",
      "settings.credsPg": "PG read-only DSN",
      "settings.credsEmbed": "Embedding/rerank key",
      "settings.ok": "configured",
      "settings.missing": "missing",
      "settings.kbList": "KB whitelist",
      "settings.override": "Runtime overrides",
      "settings.save": "Save",
      "settings.saving": "Saving…",
      "settings.saved": "Saved",
      "settings.reset": "Clear overrides",
      "settings.test": "Test connection",
      "settings.testing": "Testing…",
      "settings.testPg": "PG connection",
      "settings.testEmbed": "Embedding endpoint",
      "settings.testRerank": "Rerank endpoint",
      "settings.loadError": "Failed to load settings ({error})",
      "card.title": "Knowledge base search",
      "card.running": "Searching…",
      "card.error": "Search failed",
      "card.noData": "No result data",
      "card.resultsUnit": "results",
      "card.degraded": "rerank degraded",
      "card.errorDetail": "Backend error (the model received the error state)"
    };

    // ── localStorage state (browser-level memory of the choice) ────────────
    /** @returns {{kbId: string, kbName?: string} | null} */
    function readStored() {
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (raw === null) return null;
        const parsed = JSON.parse(raw);
        return parsed !== null && typeof parsed === "object" && typeof parsed.kbId === "string" && parsed.kbId !== ""
          ? { kbId: parsed.kbId, ...(typeof parsed.kbName === "string" ? { kbName: parsed.kbName } : {}) }
          : null;
      } catch {
        return null;
      }
    }
    /** @param {{kbId: string, kbName?: string} | null} value */
    function writeStored(value) {
      try {
        if (value === null) window.localStorage.removeItem(STORAGE_KEY);
        else window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
      } catch {
        // storage unavailable (private mode) — the chip still works in-session
      }
    }

    // ── same-origin /kb* helpers (never see secrets; the host does) ────────
    /** @param {Response} res @param {any} data @returns {Error & {code: string}} */
    function httpError(res, data) {
      const code =
        data !== null && typeof data === "object" && typeof data.error === "string"
          ? data.error
          : "http-" + res.status;
      const err = new Error(code);
      err.code = code;
      return err;
    }
    /** @param {string} url @returns {Promise<any>} */
    async function getJson(url) {
      const res = await fetch(url, { headers: { accept: "application/json" } });
      let data = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }
      if (!res.ok) throw httpError(res, data);
      return data;
    }
    /** @param {string} url @param {object} body @returns {Promise<any>} */
    async function postJson(url, body) {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body)
      });
      let data = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }
      if (!res.ok) throw httpError(res, data);
      return data;
    }
    /** @param {unknown} err @returns {string} */
    function errCode(err) {
      return err !== null && typeof err === "object" && typeof err.code === "string"
        ? err.code
        : err !== null && typeof err === "object" && typeof err.message === "string"
          ? err.message
          : String(err);
    }
    /** @param {string} tag */
    const warn = (tag) => (err) => {
      try {
        console.warn("[dsh-kb-query]", tag, errCode(err));
      } catch {
        // console unavailable — nothing else to do
      }
    };

    /**
     * Composer chip: [● 知识库 ▾] — knowledge-base selector for the session.
     * @param {object} props slot props: sessionId, keyboard (the InputBar
     *   shell; keyboard.snapshot.draft = the live composer draft), t
     *   (kbquery-namespace translator). Reads props only — no store
     *   subscriptions.
     */
    function KbChip(props) {
      const sessionId = props.sessionId;
      const rawT = props.t;
      /** @param {string} key @param {object} [params] */
      const t = (key, params) => (typeof rawT === "function" ? rawT(key, params) : en[key] ?? key);

      const [stored, setStored] = react.useState(readStored);
      const [open, setOpen] = react.useState(false);
      const [degraded, setDegraded] = react.useState(false);
      const [list, setList] = react.useState({ status: "idle", kbs: [], error: "" });
      const [preview, setPreview] = react.useState(null);
      const rootRef = react.useRef(null);
      const triggerRef = react.useRef(null);

      // Re-arm the host's session → KB map with the remembered choice
      // (fire-and-forget; silent failure = console only, plan R7 self-heal).
      react.useEffect(() => {
        const remembered = readStored();
        if (remembered === null || typeof sessionId !== "string" || sessionId === "") return;
        postJson(ROUTE_SELECT, { sessionId: sessionId, kbId: remembered.kbId }).catch(warn("re-arm select failed"));
      }, [sessionId]);

      // Close on outside mousedown (rows select on mousedown, so their
      // own handler runs before this listener can fire).
      react.useEffect(() => {
        if (!open) return undefined;
        const onDown = (event) => {
          const root = rootRef.current;
          if (root !== null && !root.contains(event.target)) setOpen(false);
        };
        document.addEventListener("mousedown", onDown);
        return () => document.removeEventListener("mousedown", onDown);
      }, [open]);

      const loadList = () => {
        setList({ status: "loading", kbs: [], error: "" });
        getJson(ROUTE_LIST)
          .then((data) => {
            const kbs = Array.isArray(data) ? data : [];
            setList({ status: "ok", kbs: kbs, error: "" });
            setDegraded(false);
          })
          .catch((err) => {
            setList({ status: "error", kbs: [], error: errCode(err) });
            setDegraded(true);
          });
      };
      react.useEffect(() => {
        if (open) loadList();
      }, [open]);

      const pick = (kb) => {
        const next = { kbId: kb.id, ...(typeof kb.name === "string" ? { kbName: kb.name } : {}) };
        writeStored(next);
        setStored(next);
        setOpen(false);
        if (typeof sessionId !== "string" || sessionId === "") return;
        postJson(ROUTE_SELECT, { sessionId: sessionId, kbId: kb.id }).catch((err) => {
          setDegraded(true);
          warn("select failed")(err);
        });
      };

      const closeKb = () => {
        writeStored(null);
        setStored(null);
        setOpen(false);
        if (typeof sessionId !== "string" || sessionId === "") return;
        postJson(ROUTE_SELECT, { sessionId: sessionId, kbId: null }).catch(warn("close select failed"));
      };

      const readComposerDraft = () => {
        // 1) The host's canonical channel: the slot owner injects the
        //    InputBar shell as `keyboard` (live snapshot getter).
        const shell = props.keyboard;
        try {
          const snapshot = shell !== null && shell !== undefined ? shell.snapshot : undefined;
          if (snapshot !== null && typeof snapshot === "object" && typeof snapshot.draft === "string" && snapshot.draft.trim() !== "") {
            return snapshot.draft.trim();
          }
        } catch {
          /* fall through to the DOM fallback */
        }
        // 2) DOM fallback: the composer's contenteditable editor (the chip
        //    sits in the composer bar; climb to the container that owns the
        //    editable and read its text).
        const root = rootRef.current;
        if (root !== null && typeof document !== "undefined") {
          let node = root;
          for (let depth = 0; node !== null && depth < 10; depth++) {
            const editable = node.querySelector ? node.querySelector("div[contenteditable='true']") : null;
            if (editable !== null) {
              const text = typeof editable.innerText === "string" ? editable.innerText : "";
              return text.trim();
            }
            node = node.parentElement;
          }
        }
        return "";
      };

      const openPreview = () => {
        // Pure display: query defaults to the current composer draft
        // (editable); results never enter the draft (v2 RAG semantics,
        // plan §2.8).
        const draft = readComposerDraft();
        setPreview({
          query: draft,
          status: stored !== null && stored.kbId !== undefined ? "idle" : "no-kb",
          results: [],
          truncated: false,
          error: ""
        });
      };

      const runPreview = () => {
        if (preview === null || stored === null) return;
        const query = preview.query.trim();
        if (query === "" || preview.status === "loading") return;
        setPreview({ ...preview, status: "loading" });
        postJson(ROUTE_QUERY, { kbId: stored.kbId, query: query })
          .then((data) => {
            setPreview({
              query: query,
              status: "ok",
              results: data !== null && typeof data === "object" && Array.isArray(data.results) ? data.results : [],
              truncated: data !== null && typeof data === "object" ? data.truncated === true : false,
              error: ""
            });
          })
          .catch((err) => {
            setDegraded(true);
            setPreview({ query: query, status: "error", results: [], truncated: false, error: errCode(err) });
          });
      };

      const onKeyDown = (event) => {
        if (event.key !== "Escape" || !open) return;
        event.preventDefault();
        setOpen(false);
        if (triggerRef.current !== null) triggerRef.current.focus();
      };

      const selected = stored !== null && stored.kbId !== undefined;
      const label = selected ? stored.kbName ?? t("chip.label") : t("chip.label");
      const triggerTitle = degraded ? t("chip.degraded") : selected ? stored.kbName ?? "" : t("chip.open");

      const previewPanel =
        preview !== null
          ? e("div", { className: "kbq-preview", key: "preview" }, [
              e("div", { className: "kbq-section", key: "pt" }, t("preview.title")),
              preview.status === "no-kb"
                ? e("div", { className: "kbq-error", key: "pn" }, t("preview.noKb"))
                : [
                    e(
                      "div",
                      { key: "pr", style: { display: "flex", gap: "6px", alignItems: "center" } },
                      [
                        e("input", {
                          className: "kbq-input",
                          key: "qi",
                          type: "text",
                          value: preview.query,
                          placeholder: t("preview.placeholder"),
                          onChange: (ev) => setPreview({ ...preview, query: ev.target.value }),
                          onKeyDown: (ev) => {
                            if (ev.key === "Enter" && preview.status !== "loading") runPreview();
                          }
                        }),
                        e(
                          "button",
                          {
                            className: "kbq-btn",
                            key: "qr",
                            type: "button",
                            disabled: preview.status === "loading" || preview.query.trim() === "",
                            onClick: runPreview
                          },
                          preview.status === "loading" ? t("preview.running") : t("preview.run")
                        )
                      ]
                    ),
                    preview.status === "error" ? e("div", { className: "kbq-error", key: "pe" }, t("preview.error", { error: preview.error })) : null,
                    preview.status === "ok" && preview.results.length === 0 ? e("div", { className: "kbq-error", key: "pn2" }, t("preview.none")) : null,
                    preview.status === "ok"
                      ? preview.results.map((r, i) =>
                          e("div", { className: "kbq-chunk", key: "c" + i }, [
                            e("div", { className: "kbq-chunkText", key: "ct" }, typeof r === "object" && r !== null ? r.text : ""),
                            typeof r === "object" && r !== null && typeof r.source === "string" && r.source !== ""
                              ? e("div", { className: "kbq-chunkSource", key: "cs" }, t("source") + ": " + r.source)
                              : null
                          ])
                        )
                      : null,
                    preview.status === "ok" && preview.truncated ? e("div", { className: "kbq-error", key: "ptt" }, t("resultsTruncated")) : null
                  ]
            ])
          : null;

      return e(
        "div",
        { className: "kbq-root", ref: rootRef, onKeyDown: onKeyDown },
        [
          e(
            "button",
            {
              ref: triggerRef,
              type: "button",
              className:
                "kbq-trigger" + (selected ? " kbq-triggerActive" : "") + (degraded ? " kbq-triggerDegraded" : ""),
              title: triggerTitle,
              "aria-expanded": open,
              "aria-label": triggerTitle,
              onClick: () => setOpen((current) => !current)
            },
            [
              e("span", { className: "kbq-dot" + (selected ? " kbq-dotOn" : ""), key: "dot" }),
              e("span", { className: "kbq-rowLabel", key: "label" }, label),
              e("span", { className: "kbq-chevron", key: "chev" }, open ? "▴" : "▾")
            ]
          ),
          open
            ? e("div", { className: "kbq-menu", role: "menu", "aria-label": t("menu.aria") }, [
                e("div", { className: "kbq-section", key: "sec" }, t("menu.select")),
                list.status === "loading" ? e("div", { className: "kbq-error", key: "st" }, t("preview.running")) : null,
                list.status === "error"
                  ? e("button", { className: "kbq-row kbq-rowMuted", key: "err", type: "button", onMouseDown: loadList }, t("menu.loadError"))
                  : null,
                list.status === "ok" && list.kbs.length === 0 ? e("div", { className: "kbq-error", key: "emp" }, t("menu.empty")) : null,
                list.kbs.map((kb) =>
                  e(
                    "button",
                    {
                      className: "kbq-row" + (stored !== null && stored.kbId === kb.id ? " kbq-rowCurrent" : ""),
                      key: typeof kb === "object" && kb !== null ? kb.id : "kb",
                      type: "button",
                      role: "menuitem",
                      onMouseDown: () => pick(kb)
                    },
                    [
                      e("span", { className: "kbq-rowLabel", title: typeof kb === "object" && kb !== null ? kb.name : "" }, typeof kb === "object" && kb !== null ? kb.name : ""),
                      stored !== null && stored.kbId === kb.id ? e("span", { className: "kbq-check", key: "ck" }, "✓") : null
                    ]
                  )
                ),
                e("hr", { className: "kbq-sep", key: "sep" }),
                e("button", { className: "kbq-row", key: "pv", type: "button", role: "menuitem", onMouseDown: openPreview }, t("menu.preview")),
                e(
                  "button",
                  {
                    className: "kbq-row kbq-rowMuted",
                    key: "cl",
                    type: "button",
                    role: "menuitem",
                    disabled: !selected,
                    onMouseDown: closeKb
                  },
                  t("menu.close")
                ),
                previewPanel
              ])
            : null
        ]
      );
    }

    /**
     * Settings-page section (registered in the `settings.section` slot,
     * dshmarket/better-sidebar precedent): shows the effective config
     * (backend / rerank / k / models / credential PRESENCE — never values /
     * the KB whitelist), allows runtime overrides (backend, rerank, k —
     * in-memory; a restart restores the profile config), and offers a
     * per-leg connectivity test (PG / embedding / rerank).
     * @param {object} props {t} translator (the "kbquery" namespace)
     */
    function KbSettingsSection(props) {
      const rawT = props.t;
      const t = (key, params) =>
        (typeof rawT === "function" ? rawT(key, params) : (en[key] !== undefined ? en[key] : key));
      const [data, setData] = react.useState(null);
      const [loadError, setLoadError] = react.useState("");
      const [saving, setSaving] = react.useState(false);
      const [saved, setSaved] = react.useState(false);
      const [testing, setTesting] = react.useState(false);
      const [testResult, setTestResult] = react.useState(null);
      const [draft, setDraft] = react.useState(null); // {backend, rerankEnabled, k}
      const [backendOpen, setBackendOpen] = react.useState(false);
      const backendRef = react.useRef(null);

      const load = () => {
        setLoadError("");
        getJson(ROUTE_SETTINGS)
          .then((d) => {
            setData(d);
            setDraft({ backend: d.backend, rerankEnabled: d.rerankEnabled, k: d.k });
          })
          .catch((err) => setLoadError(errCode(err)));
      };
      react.useEffect(() => {
        load();
      }, []);

      // Close the backend dropdown on outside mousedown (KbChip pattern).
      react.useEffect(() => {
        if (!backendOpen) return undefined;
        const onDown = (event) => {
          const root = backendRef.current;
          if (root !== null && !root.contains(event.target)) setBackendOpen(false);
        };
        document.addEventListener("mousedown", onDown);
        return () => document.removeEventListener("mousedown", onDown);
      }, [backendOpen]);

      const dirty =
        data !== null &&
        draft !== null &&
        (draft.backend !== data.backend ||
          draft.rerankEnabled !== data.rerankEnabled ||
          draft.k !== data.k);

      const save = () => {
        if (data === null || draft === null || saving) return;
        setSaving(true);
        setSaved(false);
        setLoadError("");
        postJson(ROUTE_SETTINGS, draft)
          .then(() => {
            setSaved(true);
            load();
          })
          .catch((err) => setLoadError(errCode(err)))
          .finally(() => setSaving(false));
      };

      const resetOverrides = () => {
        if (data === null) return;
        setSaved(false);
        setLoadError("");
        postJson(ROUTE_SETTINGS, { reset: true })
          .then(load)
          .catch((err) => setLoadError(errCode(err)));
      };

      const runTest = () => {
        if (testing) return;
        setTesting(true);
        setTestResult(null);
        setSaved(false);
        setLoadError("");
        postJson(ROUTE_SETTINGS_TEST, {})
          .then(setTestResult)
          .catch((err) => setLoadError(errCode(err)))
          .finally(() => setTesting(false));
      };

      if (data === null) {
        return e("div", { className: "kbq-set" }, [
          e("div", { className: "kbq-error", key: "e" }, loadError === "" ? "…" : t("settings.loadError", { error: loadError })),
          loadError !== ""
            ? e("button", { className: "kbq-btn", key: "r", type: "button", onClick: load }, t("menu.loadError"))
            : null
        ]);
      }

      const hasOverrides = Object.keys(data.overrides ?? {}).length > 0;
      const legs =
        testResult !== null && typeof testResult === "object"
          ? { pg: testResult.pg ?? null, embed: testResult.embed ?? null, rerank: testResult.rerank ?? null }
          : null;
      /** @param {string} key @param {string} label @param {{ok: boolean, ms?: number, dims?: number, error?: string} | null} leg */
      const legRow = (key, label, leg) =>
        e("div", { className: "kbq-setLeg", key }, [
          e("span", { className: "kbq-setLabel" }, label),
          leg === null
            ? e("span", { className: "kbq-setErr" }, "…")
            : e(
                "span",
                { className: leg.ok ? "kbq-setOk" : "kbq-setErr" },
                leg.ok
                  ? `✓ ${typeof leg.ms === "number" ? leg.ms + "ms" : ""}${typeof leg.dims === "number" ? " · " + leg.dims + " 维" : ""}`
                  : `✗ ${leg.error ?? "error"}`
              )
        ]);

      return e("div", { className: "kbq-set" }, [
        e("div", { className: "kbq-setTitle", key: "t" }, t("settings.title")),
        e("div", { className: "kbq-setHint", key: "h" }, t("settings.hint")),
        e("div", { className: "kbq-setRow", key: "b" }, [
          e("span", { className: "kbq-setLabel" }, t("settings.backend")),
          // Custom themed dropdown (NOT a native <select>: the OS-rendered
          // option popup ignores our CSS and breaks the dark theme).
          e("div", { className: "kbq-setSelectWrap", ref: backendRef }, [
            e("button", {
              className: "kbq-setSelect",
              key: "bbtn",
              type: "button",
              onClick: () => setBackendOpen(!backendOpen)
            }, [
              t("settings.backend." + draft.backend),
              e("span", { className: "kbq-chevron", key: "ch" }, backendOpen ? "▴" : "▾")
            ]),
            backendOpen
              ? e("div", { className: "kbq-menu kbq-setMenu", key: "bmenu" }, [
                  e("button", { className: "kbq-row", type: "button", key: "pg", onClick: () => { setDraft({ ...draft, backend: "pgvector" }); setBackendOpen(false); } }, [
                    e("span", { className: "kbq-check", key: "c" }, draft.backend === "pgvector" ? "✓" : ""),
                    e("span", { className: "kbq-rowLabel", key: "l" }, t("settings.backend.pgvector"))
                  ]),
                  e("button", { className: "kbq-row", type: "button", key: "ow", onClick: () => { setDraft({ ...draft, backend: "owui" }); setBackendOpen(false); } }, [
                    e("span", { className: "kbq-check", key: "c" }, draft.backend === "owui" ? "✓" : ""),
                    e("span", { className: "kbq-rowLabel", key: "l" }, t("settings.backend.owui"))
                  ])
                ])
              : null
          ])
        ]),
        e("div", { className: "kbq-setRow", key: "r" }, [
          e("span", { className: "kbq-setLabel" }, t("settings.rerank")),
          e("label", { className: "kbq-setCheck" }, [
            e("input", {
              type: "checkbox",
              checked: draft.rerankEnabled,
              onChange: (ev) => setDraft({ ...draft, rerankEnabled: ev.target.checked })
            }),
            ` ${draft.rerankEnabled ? t("settings.on") : t("settings.off")}${typeof data.rerankModel === "string" && data.rerankModel !== "" ? " · " + data.rerankModel : ""}`
          ])
        ]),
        e("div", { className: "kbq-setRow", key: "k" }, [
          e("span", { className: "kbq-setLabel" }, t("settings.k")),
          e("input", {
            className: "kbq-input kbq-setNum",
            type: "number",
            min: 1,
            max: 20,
            value: draft.k,
            onChange: (ev) => {
              const v = parseInt(ev.target.value, 10);
              setDraft({ ...draft, k: Number.isFinite(v) ? Math.min(20, Math.max(1, v)) : 1 });
            }
          })
        ]),
        e("div", { className: "kbq-setRow", key: "fk" }, [
          e("span", { className: "kbq-setLabel" }, t("settings.fetchK")),
          e("span", null, String(data.fetchK ?? "—"))
        ]),
        e("div", { className: "kbq-setRow", key: "tk" }, [
          e("span", { className: "kbq-setLabel" }, t("settings.topK")),
          e("span", null, String(data.topKReranker ?? "—"))
        ]),
        e("div", { className: "kbq-setRow", key: "em" }, [
          e("span", { className: "kbq-setLabel" }, t("settings.embeddingModel")),
          e("span", null, typeof data.embeddingModel === "string" && data.embeddingModel !== "" ? data.embeddingModel : "—")
        ]),
        e("div", { className: "kbq-setRow", key: "cp" }, [
          e("span", { className: "kbq-setLabel" }, t("settings.credsPg")),
          data.credentials && data.credentials.pg
            ? e("span", { className: "kbq-setOk" }, "✓ " + t("settings.ok"))
            : e("span", { className: "kbq-setErr" }, "✗ " + t("settings.missing"))
        ]),
        e("div", { className: "kbq-setRow", key: "ce" }, [
          e("span", { className: "kbq-setLabel" }, t("settings.credsEmbed")),
          data.credentials && data.credentials.embed
            ? e("span", { className: "kbq-setOk" }, "✓ " + t("settings.ok"))
            : e("span", { className: "kbq-setErr" }, "✗ " + t("settings.missing"))
        ]),
        e("div", { className: "kbq-setRow", key: "kl" }, [
          e("span", { className: "kbq-setLabel" }, t("settings.kbList")),
          e("span", null, Array.isArray(data.kbList) && data.kbList.length > 0 ? data.kbList.map((kb) => (typeof kb?.name === "string" ? kb.name : kb?.id ?? "")).join(" / ") : "—")
        ]),
        e("div", { className: "kbq-setRow", key: "ov" }, [
          e("span", { className: "kbq-setLabel" }, t("settings.override")),
          hasOverrides
            ? e("span", { className: "kbq-setOk" }, Object.keys(data.overrides).join(", "))
            : e("span", null, "—")
        ]),
        e("div", { className: "kbq-setActions", key: "a" }, [
          e("button", { className: "kbq-btn", key: "sv", type: "button", disabled: !dirty || saving, onClick: save }, saving ? t("settings.saving") : t("settings.save")),
          e("button", { className: "kbq-btn", key: "rs", type: "button", disabled: !hasOverrides, onClick: resetOverrides }, t("settings.reset")),
          e("button", { className: "kbq-btn", key: "tt", type: "button", disabled: testing, onClick: runTest }, testing ? t("settings.testing") : t("settings.test"))
        ]),
        saved ? e("div", { className: "kbq-setOk kbq-setMsg", key: "sm" }, t("settings.saved")) : null,
        loadError !== "" ? e("div", { className: "kbq-setErr kbq-setMsg", key: "em2" }, loadError) : null,
        legs !== null
          ? e("div", { className: "kbq-setTest", key: "tr" }, [
              legRow("pg", t("settings.testPg"), legs.pg),
              legRow("embed", t("settings.testEmbed"), legs.embed),
              legRow("rerank", t("settings.testRerank"), legs.rerank)
            ])
          : null
      ]);
    }

    // ── kb_search tool-call card (keyed tool.call.toolview entry) ─────────
    /** Parse the kb_search result text (one JSON text block) defensively. */
    function parseKbOutcome(text) {
      if (typeof text !== "string" || text === "") return null;
      // The ok result carries a trailing citation reminder after a BLANK
      // line (the host-side render appends it for model compliance).
      // Pretty-printed JSON never contains an empty line, so the JSON-only
      // prefix is the part before the first "\n\n".
      const candidates = [text];
      const cut = text.indexOf("\n\n");
      if (cut !== -1) candidates.push(text.slice(0, cut));
      for (const candidate of candidates) {
        try {
          const v = JSON.parse(candidate);
          if (v !== null && typeof v === "object" && v.status === "ok" && Array.isArray(v.results)) return v;
        } catch {
          /* try the next candidate */
        }
      }
      return null;
    }

    /**
     * kb_search tool-call card: the query + the retrieved chunks with the
     * 1-based indices the model's kb[n] citation markers refer to; each
     * chunk row expands in place. `data-kbq-chunks` on the card root is the
     * chunk store the inline citation chips read (document-order lookup:
     * the card always precedes the answer that cites it).
     * @param {object} props owner props: {callId, toolName, block, cwd, home, ...}
     */
    function KbSearchToolCard(props) {
      const rawT = props.t;
      const t = (key, params) =>
        (typeof rawT === "function" ? rawT(key, params) : en[key] !== undefined ? en[key] : key);
      const [open, setOpen] = react.useState(false); // card disclosure (auto-collapsed)
      const [expanded, setExpanded] = react.useState(null); // chunk index or null
      const block = props.block;
      const done = block !== null && typeof block === "object" && "kind" in block;
      const call = done ? (block.call ?? null) : (block !== null && typeof block === "object" ? block : null);
      const argsRaw = call !== null && typeof call.argsRaw === "string" ? call.argsRaw : "";
      let query = "";
      try {
        const a = JSON.parse(argsRaw);
        if (a !== null && typeof a === "object" && typeof a.query === "string") query = a.query;
      } catch {
        /* args not JSON yet (call running) */
      }
      const isError = done && block.isError === true;
      const resultText = done
        ? Array.isArray(block.content)
          ? block.content.filter((c) => c !== null && c !== undefined && c.type === "text").map((c) => c.text).join("\n")
          : ""
        : "";
      const outcome = done && !isError ? parseKbOutcome(resultText) : null;
      const results = outcome !== null ? outcome.results : [];

      return e(
        "div",
        {
          className: "kbq-kbcard",
          "data-kbq-chunks": JSON.stringify(
            results.map((r) => ({
              t: r !== null && typeof r === "object" && typeof r.text === "string" ? r.text : "",
              s: r !== null && typeof r === "object" && typeof r.source === "string" ? r.source : ""
            }))
          )
        },
        [
          e(
            "div",
            {
              className: "kbq-kbcardHead",
              key: "h",
              role: "button",
              tabIndex: 0,
              onClick: () => setOpen(!open),
              onKeyDown: (ev) => {
                if (ev.key === "Enter" || ev.key === " ") {
                  ev.preventDefault();
                  setOpen(!open);
                }
              }
            },
            [
              e("span", { className: "kbq-chevron", key: "cv0" }, open ? "▴" : "▾"),
              e("span", { className: "kbq-kbcardTitle", key: "t" }, t("card.title")),
            query !== "" ? e("span", { className: "kbq-kbcardQuery", key: "q", title: query }, query) : null,
            e(
              "span",
              { className: "kbq-kbcardMeta", key: "m" },
              !done
                ? t("card.running")
                : isError
                  ? t("card.error")
                  : outcome === null
                    ? t("card.noData")
                    : `${results.length} ${t("card.resultsUnit")}${outcome.degraded === "rerank-unavailable" ? " · " + t("card.degraded") : ""}`
            )
          ]),
          open && outcome !== null
            ? results.map((r, i) =>
                e(
                  "div",
                  {
                    className: "kbq-kbchunk",
                    key: "c" + i,
                    role: "button",
                    tabIndex: 0,
                    onClick: () => setExpanded(expanded === i ? null : i),
                    onKeyDown: (ev) => {
                      if (ev.key === "Enter" || ev.key === " ") {
                        ev.preventDefault();
                        setExpanded(expanded === i ? null : i);
                      }
                    }
                  },
                  [
                    e("div", { className: "kbq-kbchunkHead", key: "ch" }, [
                      e("span", { className: "kbq-kbchunkIdx", key: "i" }, String(i + 1)),
                      e(
                        "span",
                        { className: "kbq-kbchunkSrc", key: "s" },
                        r !== null && typeof r === "object" && typeof r.source === "string" && r.source !== "" ? r.source : "—"
                      ),
                      e("span", { className: "kbq-chevron", key: "cv" }, expanded === i ? "▴" : "▾")
                    ]),
                    expanded === i
                      ? e("pre", { className: "kbq-kbchunkBody", key: "cb" }, r !== null && typeof r === "object" && typeof r.text === "string" ? r.text : "")
                      : null
                  ]
                )
              )
            : null,
          done && isError ? e("div", { className: "kbq-kbcardErr", key: "e" }, t("card.errorDetail")) : null
        ]
      );
    }

    // ── Inline citation chips (the kb[n] markers the model emits) ─────────
    const CITE_CLASS = "kbq-cite";
    const CITE_RE = /\bkb\[(\d+)\]/g;
    /** Own UI containers the decoration must never enter. */
    const CITE_SKIP = ".kbq-kbcard, .kbq-menu, .kbq-set, .kbq-citePop, ." + CITE_CLASS;
    let citePopEl = null; // the single open popup

    const citeLabels = () => {
      const lang = (typeof document !== "undefined" && document.documentElement.lang || "").toLowerCase();
      return lang.startsWith("en")
        ? { source: "Source", close: "Close", missing: "(no matching chunk found)" }
        : { source: "来源", close: "关闭", missing: "（未找到对应的引用块）" };
    };

    function closeCitePop() {
      if (citePopEl !== null) {
        citePopEl.remove();
        citePopEl = null;
      }
      if (typeof document === "undefined") return;
      document.removeEventListener("mousedown", citePopDown, true);
      document.removeEventListener("keydown", citePopKey, true);
    }
    function citePopDown(ev) {
      if (citePopEl !== null && !citePopEl.contains(ev.target)) closeCitePop();
    }
    function citePopKey(ev) {
      if (ev.key === "Escape") closeCitePop();
    }
    /** The LAST kb_search card that PRECEDES the anchor (document order). */
    function chunksBefore(anchorEl) {
      if (typeof document === "undefined" || anchorEl === null) return null;
      let el = anchorEl;
      let scope = null;
      for (let i = 0; el !== null && i < 20; i++) {
        if (typeof el.querySelectorAll === "function" && el.querySelectorAll("[data-kbq-chunks]").length > 0) {
          scope = el;
          break;
        }
        el = el.parentElement;
      }
      if (scope === null) scope = document.body;
      const cards = scope.querySelectorAll("[data-kbq-chunks]");
      let hit = null;
      for (const card of cards) {
        // DOCUMENT_POSITION_FOLLOWING (4): the anchor follows the card → the card precedes it
        if (card.compareDocumentPosition(anchorEl) & 4) hit = card; // keep the LAST such card
      }
      if (hit === null) return null;
      try {
        const v = JSON.parse(hit.getAttribute("data-kbq-chunks") || "[]");
        return Array.isArray(v) ? v : null;
      } catch {
        return null;
      }
    }
    function showCitePop(anchorEl, chunks, index) {
      if (typeof document === "undefined") return;
      closeCitePop();
      const L = citeLabels();
      const item = chunks !== null && index >= 0 && index < chunks.length ? chunks[index] : null;
      const pop = document.createElement("div");
      pop.className = "kbq-citePop";
      pop.setAttribute("role", "dialog");
      const src = document.createElement("div");
      src.className = "kbq-citePopSrc";
      src.textContent = L.source + ": " + (item !== null && item.s !== "" ? item.s : "—");
      pop.appendChild(src);
      const text = document.createElement("pre");
      text.className = "kbq-citePopText";
      text.textContent = item !== null && item.t !== "" ? item.t : L.missing;
      pop.appendChild(text);
      const close = document.createElement("button");
      close.type = "button";
      close.className = "kbq-btn";
      close.textContent = L.close;
      close.addEventListener("click", () => closeCitePop());
      pop.appendChild(close);
      document.body.appendChild(pop);
      const rect = anchorEl.getBoundingClientRect();
      const popW = 360;
      const left = Math.min(Math.max(12, rect.left), Math.max(12, window.innerWidth - popW - 12));
      let top = rect.bottom + 6;
      const popH = pop.offsetHeight;
      if (top + popH > window.innerHeight - 12) top = Math.max(12, rect.top - popH - 6);
      pop.style.left = left + "px";
      pop.style.top = top + "px";
      citePopEl = pop;
      document.addEventListener("mousedown", citePopDown, true);
      document.addEventListener("keydown", citePopKey, true);
    }
    /** Wrap kb[n] markers in clickable chips (idempotent; skips own UI). */
    function decorateCites(rootNode) {
      if (rootNode === null || typeof rootNode !== "object") return;
      const el = rootNode.nodeType === 3 ? rootNode.parentElement : rootNode.nodeType === 1 ? rootNode : null;
      if (el !== null && typeof el.closest === "function" && el.closest(CITE_SKIP) !== null) return;
      const walk = (node) => {
        if (node.nodeType === 3) {
          const text = node.nodeValue || "";
          if (text.indexOf("kb[") === -1) return;
          CITE_RE.lastIndex = 0;
          if (!CITE_RE.test(text)) return;
          const parent = node.parentElement;
          if (parent === null) return;
          const frag = document.createDocumentFragment();
          let last = 0;
          let m;
          CITE_RE.lastIndex = 0;
          while ((m = CITE_RE.exec(text)) !== null) {
            if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
            const chip = document.createElement("span");
            chip.className = CITE_CLASS;
            chip.setAttribute("role", "button");
            chip.setAttribute("tabindex", "0");
            chip.textContent = m[0];
            const idx = parseInt(m[1], 10) - 1;
            const open = () => showCitePop(chip, chunksBefore(chip), idx);
            chip.addEventListener("click", (ev) => {
              ev.stopPropagation();
              open();
            });
            chip.addEventListener("keydown", (ev) => {
              if (ev.key === "Enter" || ev.key === " ") {
                ev.preventDefault();
                open();
              }
            });
            frag.appendChild(chip);
            last = m.index + m[0].length;
          }
          if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
          parent.replaceChild(frag, node);
        } else if (node.nodeType === 1) {
          if (typeof node.closest === "function" && node.closest(CITE_SKIP) !== null) return;
          for (const child of Array.from(node.childNodes)) walk(child);
        }
      };
      walk(rootNode);
    }

    /** Required services: the composer slot registry + dictionary registry.
     * NOTE: no "styles" service — the runner's `styles` service is
     * runner-internal and NOT resolvable from plugin client entries
     * (declaring it stalls boot: `pending (waiting for service: styles)`).
     * The dsh-client-ui-jobs precedent inserts the <style> tag directly. */
    const inject = ["slots", "locale"];

    /**
     * Client plugin body: dictionaries, styles, and the composer chip.
     * @param {object} ctx client root context
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register("kbquery", { zh: zh, en: en }), "kb-query: dictionaries");
      ctx.effect(() => {
        // Manual <style> injection (ui-jobs precedent): the cordis `styles`
        // service is runner-internal, not resolvable from plugin entries.
        // The document guard keeps the host-side evaluation a no-op.
        if (typeof document === "undefined") return;
        const sel = "style[data-plugin-css='dsh-kb-query/styles']";
        if (document.querySelector(sel)) return;
        const tag = document.createElement("style");
        tag.setAttribute("data-plugin-css", "dsh-kb-query/styles");
        tag.textContent = css;
        document.head.appendChild(tag);
        return () => {
          const t = document.querySelector(sel);
          if (t) t.remove();
        };
      }, "kb-query: styles");
      ctx.effect(
        () =>
          ctx.slots.inject("conversation.input.left", () =>
            ctx.slots.register(
              { name: "conversation.input.left", id: "kb-query", order: 10, locale: "kbquery" },
              KbChip
            )
          ),
        "kb-query: composer chip"
      );
      // Settings page tab (the settings.section slot renders a tab per
      // registration; the shell handles the nav + dialog).
      ctx.effect(
        () => {
          const t = ctx.locale.bind("kbquery");
          return ctx.slots.inject("settings.section", () =>
            ctx.slots.register(
              { name: "settings.section", id: "kb-query-settings", order: 60, label: () => t("settings.title"), inject: () => ({ t }) },
              () => e(KbSettingsSection, { t })
            )
          );
        },
        "kb-query: settings section"
      );
      // kb_search tool-call card (keyed tool.call.toolview; key = tool name).
      ctx.effect(
        () =>
          ctx.slots.inject("tool.call.toolview", () =>
            ctx.slots.register(
              { name: "tool.call.toolview", key: "kb_search", locale: "kbquery" },
              KbSearchToolCard
            )
          ),
        "kb-query: kb_search tool card"
      );
      // Inline kb[n] citation chips on rendered assistant text (the tool
      // description instructs the model to emit the markers).
      ctx.effect(() => {
        if (typeof document === "undefined" || typeof MutationObserver === "undefined") return undefined;
        const observe = (root) => {
          try {
            decorateCites(root);
          } catch {
            /* decoration must never break the host */
          }
        };
        const mo = new MutationObserver((records) => {
          for (const r of records) {
            if (r.type === "childList") {
              for (const n of Array.from(r.addedNodes)) observe(n);
            } else if (r.type === "characterData") {
              observe(r.target); // streamed text-node growth (childList-only
              // observation misses in-place text mutation)
            }
          }
        });
        mo.observe(document.body, { childList: true, subtree: true, characterData: true });
        observe(document.body);
        return () => {
          mo.disconnect();
          closeCitePop();
        };
      }, "kb-query: citation chips");
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
