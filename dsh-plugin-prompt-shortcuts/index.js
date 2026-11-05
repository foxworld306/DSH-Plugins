/**
 * Host half of the prompt-shortcuts bundle.
 *
 * Owns the durable shortcut list as one JSON document under `$DSH_HOME`, and
 * serves it to the Client half over a Connection RPC channel.
 *
 * Storage deliberately lives here rather than in the browser: `localStorage` is
 * cleared along with site data, so saved prompts would silently disappear.
 * The document path follows DSH's own convention so it survives browser changes
 * and can be backed up or version-controlled with the rest of the profile.
 *
 * Writes are atomic (temp file then rename) and serialized, so an interrupted
 * write cannot leave a truncated document behind and two concurrent saves
 * cannot lose each other's edits.
 */
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

/** Absolute path of the plugin's own browser-facing endpoint. */
const ROUTE_PATH = '/api/dsh-prompt-shortcuts';

/** Upper bound on a request body, so one call cannot exhaust memory. */
const MAX_BODY_BYTES = 1024 * 1024;

/** Longest accepted button label, matching the Client half's input limit. */
const MAX_LABEL = 24;

/**
 * End-to-end deadline for one translate call, so a hung provider cannot hold
 * the request. 60s leaves headroom for reasoning models: their thinking
 * counts against the output cap and streams before the JSON arrives.
 */
const TRANSLATE_TIMEOUT_MS = 60000;

/**
 * Output cap for one translate call. The visible answer is small (one JSON
 * object with a short label and a prompt body); 2048 leaves room for modest
 * thinking on top of a long translated prompt. The main latency/cost control
 * is the lightest advertised reasoning effort (see lightestReasoningEffort) —
 * a wide cap invites extended thinking that streams before the JSON.
 */
const TRANSLATE_MAX_TOKENS = 2048;

/**
 * Cache: `${provider}/${model}` → the lightest advertised reasoning effort
 * id for that exact route (null = none advertised or lookup failed). Effort
 * lists are stable per route; the map is bounded by the routes actually
 * translated.
 */
const REASONING_EFFORT_CACHE = new Map();

/**
 * The lightest advertised reasoning effort for one exact route. Translation
 * is a trivial mechanical task, but REASONING models stream their thinking
 * as output tokens BEFORE the JSON — that thinking dominated both the
 * perceived latency and the token-budget truncations, so the call asks for
 * the minimum effort the route offers. Best-effort: a missing
 * `resolveModelInfo`, a lookup failure, or a route without advertised
 * efforts all yield undefined (the provider's own default applies).
 * @param llm - the LlmRuntime service.
 * @param provider - registered provider route.
 * @param model - exact model id.
 * @returns the lightest effort id, or undefined.
 */
async function lightestReasoningEffort(llm, provider, model) {
  if (typeof llm.resolveModelInfo !== 'function') return undefined;
  const key = `${provider}/${model}`;
  if (REASONING_EFFORT_CACHE.has(key)) {
    return REASONING_EFFORT_CACHE.get(key) ?? undefined;
  }
  let effort;
  try {
    const info = await llm.resolveModelInfo(provider, model);
    const efforts = info?.reasoning?.efforts;
    effort = efforts && efforts.length > 0 ? efforts[0].id : undefined;
  } catch {
    effort = undefined;
  }
  REASONING_EFFORT_CACHE.set(key, effort ?? null);
  return effort;
}

/**
 * An error from one translate generation attempt. `retryable` marks the
 * transient model misbehaviors (token-cap truncation, a stray tool call, an
 * unparseable answer) that a fresh attempt often fixes.
 */
class AttemptError extends Error {
  /** @param message - user-facing Chinese message. @param retryable - whether one automatic retry is worthwhile. */
  constructor(message, retryable) {
    super(message);
    this.name = 'AttemptError';
    this.retryable = Boolean(retryable);
  }
}

/**
 * Repair the common model JSON sloppiness of writing RAW control characters
 * (newlines, tabs) inside string values where JSON requires the two-character
 * escapes (\n, \t). Only attempted after a plain parse already failed, so
 * already-valid JSON is never touched: raw CR/LF bytes do not occur in valid
 * JSON except as whitespace between tokens, and that case never reaches here.
 * @param candidate - the brace-delimited JSON candidate.
 * @returns the repaired candidate.
 */
function repairJsonText(candidate) {
  return candidate.replace(/\r\n/g, '\\n').replace(/\n/g, '\\n').replace(/\t/g, '\\t');
}

/**
 * Tolerantly extract the {labelEn, promptEn} translation from raw model
 * text. A model may wrap the JSON in code fences or add comments, so the
 * slice from the first '{' to the last '}' is parsed instead of the raw text;
 * if that fails, the repair pass above handles unescaped control characters.
 * @param text - raw model output.
 * @returns `{ labelEn, promptEn }`, or null when the text is not a complete,
 *   usable translation.
 */
function parseTranslation(text) {
  if (typeof text !== 'string' || text === '') return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  const candidate = text.slice(start, end + 1);
  let parsed = null;
  for (const attempt of [candidate, repairJsonText(candidate)]) {
    try {
      parsed = JSON.parse(attempt);
      break;
    } catch {
      parsed = null;
    }
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const labelEn = typeof parsed.labelEn === 'string' ? parsed.labelEn.trim().slice(0, MAX_LABEL) : '';
  const promptEn = typeof parsed.promptEn === 'string' ? parsed.promptEn.trim() : '';
  if (labelEn === '' || promptEn === '') return null;
  return { labelEn, promptEn };
}

/**
 * Consume one model text stream into its joined text plus the terminal finish
 * reason. Written against the plain StreamChunk shapes ({type: 'text-delta'},
 * {type: 'block-end'}, {type: 'finish'}) so the Host half never needs to
 * import a DSH package: this plugin is installed as a junction into the
 * user's workspace, where bare-specifier resolution would fail.
 *
 * Text blocks are authoritative when the adapter reports them (block-end
 * carries the completed block); delta runs are kept as the fallback for
 * adapters that stream only deltas.
 * @param stream - an AsyncIterable of StreamChunks from LlmRuntime.stream.
 * @returns `{ text, finish }` (finish is null when the stream never reported one).
 */
async function consumeTextStream(stream) {
  let text = '';
  let delta = '';
  let finish = null;
  for await (const chunk of stream) {
    if (!chunk || typeof chunk !== 'object') continue;
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
      delta += chunk.text;
    } else if (chunk.type === 'block-end' && chunk.block?.type === 'text' && typeof chunk.block.text === 'string') {
      text += delta !== '' ? delta : chunk.block.text;
      delta = '';
    } else if (chunk.type === 'finish' && chunk.reason) {
      finish = chunk.reason;
    }
  }
  text += delta;
  return { text, finish };
}

/**
 * Accepted 显示范围 (placement) values:
 *  - 'both'   show on the New Session (hero) page and in sessions that already
 *             have a conversation;
 *  - 'hero'   only on the New Session page;
 *  - 'active' only in sessions that already have a conversation.
 */
const PLACEMENTS = new Set(['both', 'hero', 'active']);

/** Seed list used when no document exists yet. */
const SEED = [
  { id: 'seed-continue', label: '继续', prompt: '继续', enabled: true },
  { id: 'seed-suggest', label: '建议', prompt: '给我下一步的建议', enabled: true },
  { id: 'seed-accept', label: '采纳', prompt: '按你的建议继续', enabled: true },
];

/** @returns a fresh, collision-resistant shortcut id. */
function newId() {
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Normalize one stored or submitted record.
 * @returns `{ value }` when usable, otherwise `{ error }` naming the problem.
 */
function normalizeEntry(raw, index) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: `第 ${index + 1} 条不是对象。` };
  }
  const label = typeof raw.label === 'string' ? raw.label.trim() : '';
  const prompt = typeof raw.prompt === 'string' ? raw.prompt : '';
  if (label === '') return { error: `第 ${index + 1} 条缺少名称。` };
  if (prompt.trim() === '') return { error: `第 ${index + 1} 条「${label}」缺少提示词内容。` };
  // Optional English variants (shown when the UI language is English). They
  // are omitted from the stored record when absent or empty, so older
  // documents and hand-edits keep their exact shape.
  const labelEn = typeof raw.labelEn === 'string' ? raw.labelEn.trim().slice(0, MAX_LABEL) : '';
  const promptEn = typeof raw.promptEn === 'string' ? raw.promptEn.trim() : '';
  // Unknown or missing placement falls back to 'both' so older documents and
  // hand-edits keep working.
  const placement = PLACEMENTS.has(raw.placement) ? raw.placement : 'both';
  return {
    value: {
      id: typeof raw.id === 'string' && raw.id.trim() !== '' ? raw.id : newId(),
      label: label.slice(0, MAX_LABEL),
      prompt,
      enabled: raw.enabled !== false,
      placement,
      ...(labelEn !== '' ? { labelEn } : {}),
      ...(promptEn !== '' ? { promptEn } : {}),
    },
  };
}

/**
 * Coerce a parsed document into a valid list.
 * Unusable records are dropped instead of failing the whole read, so one bad
 * hand-edit cannot take the composer row down.
 * @param parsed - value read from the JSON document.
 * @returns the normalized list.
 */
function normalizeDocument(parsed) {
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.shortcuts) ? parsed.shortcuts : [];
  const out = [];
  for (const [index, raw] of list.entries()) {
    const result = normalizeEntry(raw, index);
    if (result.value) out.push(result.value);
  }
  return out;
}

/**
 * Serialized, atomic JSON document holding the shortcut list.
 */
class ShortcutStore {
  /** @param file - absolute path of the JSON document this store owns. */
  constructor(file) {
    this.file = file;
    /** Tail of the mutation queue; always resolves so one failure cannot stall later writes. */
    this.queue = Promise.resolve();
  }

  /** Read the document, seeding it on first run. @returns the normalized list. */
  async read() {
    let text;
    try {
      text = await readFile(this.file, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const seeded = SEED.map((entry) => ({ ...entry }));
      await this.write(seeded);
      return seeded;
    }
    try {
      return normalizeDocument(JSON.parse(text));
    } catch {
      // A corrupt document must not break the row; the next write repairs it.
      return [];
    }
  }

  /**
   * Replace the document atomically.
   * @param shortcuts - already-normalized list to persist.
   */
  async write(shortcuts) {
    await mkdir(dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(temp, `${JSON.stringify({ shortcuts }, null, 2)}\n`, 'utf8');
      await rename(temp, this.file);
    } catch (error) {
      await unlink(temp).catch(() => {});
      throw error;
    }
  }

  /**
   * Run one read-modify-write against the document without interleaving.
   * @param operation - receives the current list and returns the next one plus a result.
   * @returns the operation's result.
   */
  mutate(operation) {
    const run = this.queue.then(async () => {
      const current = await this.read();
      const { next, result } = await operation(current);
      if (next) await this.write(next);
      return result;
    });
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

/**
 * Build the store, register the RPC channel, and expose an agent tool.
 * @param ctx - Host plugin context.
 * @param config - resolved plugin row configuration.
 */
export function apply(ctx, config = {}) {
  const home = config.dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh');
  const file = config.file ?? join(home, 'prompt-shortcuts.json');
  const store = new ShortcutStore(file);

  /**
   * Translate one shortcut's label and prompt into English with the model the
   * user currently has selected in the DSH interface (the agent default
   * model). Output-capped, time-limited, with one silent retry on transient
   * model misbehavior. Nothing is persisted here: the Client's editor
   * receives the result for review, and only an explicit save writes it to
   * the document.
   * @param label - the shortcut label to translate.
   * @param prompt - the prompt body to translate (may carry {{variables}}).
 * @param signal - optional host cancellation signal (exec.signal); aborting
 *   it aborts the in-flight model stream immediately.
   * @returns `{ labelEn, promptEn, model }`.
   */
  async function translateLabelAndPrompt(label, prompt, signal) {
    const llm = ctx.llm;
    if (!llm || typeof llm.stream !== 'function') {
      throw new Error('LLM 服务不可用，无法生成英文版。');
    }
    const defaultModel = ctx.agentDefaultModel;
    if (!defaultModel || typeof defaultModel.currentSelection !== 'function') {
      throw new Error('找不到当前默认模型服务，无法生成英文版。');
    }
    const selection = defaultModel.currentSelection();
    if (!selection?.provider || !selection?.model) {
      throw new Error('尚未选择默认模型，无法生成英文版；请先在设置里选择一个模型。');
    }
    const system = [
      'You are a translator for a Chinese developer tool. Translate the supplied prompt-shortcut label and prompt body from Chinese into English.',
      'Rules:',
      '- This is a short mechanical task: do not reason, plan, or show step-by-step thinking; answer directly with the JSON object.',
      '- Keep the meaning, tone (short, direct, imperative) and structure.',
      '- Preserve every {{variable}} placeholder: keep the double braces intact, keep exactly one placeholder per original and in the same order, never drop, merge, or invent placeholders. Translate the variable NAMES inside the braces into concise natural English (for example {{指定语言}} becomes {{target language}}).',
      '- Keep the translated label within 24 characters.',
      'Return ONLY a JSON object of the form {"labelEn":"...","promptEn":"..."} — no markdown, no code fences, no extra text.',
    ].join('\n');
    const userText = `Translate this prompt shortcut:\n${JSON.stringify({ label, prompt })}`;
    // Translation is trivial: ask for the lightest reasoning effort the route
    // advertises (best-effort), so the model does not stream a long thinking
    // monologue before the JSON. undefined keeps the provider's own default.
    const reasoningEffort = await lightestReasoningEffort(llm, selection.provider, selection.model);
    /**
     * One generation attempt. Throws AttemptError; `retryable` marks the
     * transient model misbehaviors (token-cap truncation, a stray tool call,
     * an unparseable answer) that a fresh attempt often fixes.
     */
    const attempt = async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TRANSLATE_TIMEOUT_MS);
      // Host-side cancellation (exec.signal): fold into the per-attempt
      // controller so the in-flight model stream aborts immediately.
      const onOuterAbort = () => controller.abort();
      if (signal && typeof signal.addEventListener === 'function') {
        if (signal.aborted) controller.abort();
        else signal.addEventListener('abort', onOuterAbort, { once: true });
      }
      try {
        const stream = llm.stream({
          provider: selection.provider,
          model: selection.model,
          system,
          messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
          maxTokens: TRANSLATE_MAX_TOKENS,
          ...(reasoningEffort ? { reasoningEffort } : {}),
          signal: controller.signal,
        });
        const { text, finish } = await consumeTextStream(stream);
        if (!finish || finish.kind === 'aborted') {
          throw new AttemptError('翻译超时或已被中止，请重试。', false);
        }
        if (finish.kind === 'error') {
          throw new AttemptError(`翻译失败：${finish.failure?.message ?? '未知错误'}`, false);
        }
        // Accept the output whenever it already forms a complete translation,
        // even if the stream then ended for an odd reason (a trailing tool
        // call, or the token cap hit right after the JSON finished). The
        // model occasionally does this; the text is still a valid result.
        const parsed = parseTranslation(text);
        if (parsed) {
          return parsed;
        }
        // The text is not a complete translation. Report the concrete reason
        // instead of a generic "incomplete" so the user knows what to do.
        if (finish.kind === 'max-tokens') {
          throw new AttemptError('翻译输出超出模型长度限制被截断，请重试。', true);
        }
        if (finish.kind === 'tool-calls') {
          throw new AttemptError('模型返回了工具调用而不是翻译结果，请重试。', true);
        }
        // Diagnostic: the raw model output for this failure, visible in the
        // DSH host console (the dsh web terminal).
        console.error('[prompt-shortcuts] translate: unparseable output (finish kind: ' + String(finish.kind) + '): ' + text.slice(0, 500));
        throw new AttemptError(`翻译输出不是有效的 JSON（结束原因：${String(finish.kind)}），请重试。`, true);
      } finally {
        clearTimeout(timer);
        if (signal && typeof signal.removeEventListener === 'function') {
          signal.removeEventListener('abort', onOuterAbort);
        }
      }
    };

    let result;
    try {
      result = await attempt();
    } catch (err) {
      // One silent retry on transient model misbehavior (the model is
      // stochastic: a truncation or stray tool call on one attempt is often
      // clean on the next). Cost is incurred only when the first attempt
      // already failed.
      if (!(err instanceof AttemptError) || !err.retryable) throw err;
      result = await attempt();
    }
    return { ...result, model: `${selection.provider}/${selection.model}` };
  }

  /** The one implementation both the Client half and the agent tool call. */
  const service = {
    /** @returns the current list plus the backing path for display. */
    list: async () => ({ ok: true, shortcuts: await store.read(), file }),
    /** Create or update one shortcut. */
    save: (input) =>
      store.mutate((current) => {
        const normalized = normalizeEntry({ ...input, id: input?.id ?? newId() }, 0);
        if (normalized.error) return { result: { ok: false, error: normalized.error } };
        const index = current.findIndex((entry) => entry.id === normalized.value.id);
        const next = current.slice();
        if (index >= 0) next[index] = normalized.value;
        else next.push(normalized.value);
        return { next, result: { ok: true, shortcut: normalized.value, shortcuts: next } };
      }),
    /** Remove one shortcut by id. */
    remove: (id) =>
      store.mutate((current) => {
        const next = current.filter((entry) => entry.id !== id);
        if (next.length === current.length) return { result: { ok: false, error: `未找到 id 为 ${id} 的提示词。` } };
        return { next, result: { ok: true, shortcuts: next } };
      }),
    /**
     * Generate English label/prompt for one shortcut with the user's current
     * model. Read-only with respect to the document: the caller decides
     * whether to persist the result (via save/replaceAll).
     */
    translate: async (input, signal) => {
      const label = typeof input?.label === 'string' ? input.label.trim() : '';
      const prompt = typeof input?.prompt === 'string' ? input.prompt : '';
      if (label === '' || prompt.trim() === '') {
        return { ok: false, error: '翻译需要同时提供名称和提示词内容。' };
      }
      try {
        return { ok: true, ...(await translateLabelAndPrompt(label, prompt, signal)) };
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error) };
      }
    },
    /** Replace the whole list; used by the maintenance panel's save. */
    replaceAll: (shortcuts) =>
      store.mutate(() => {
        if (!Array.isArray(shortcuts)) return { result: { ok: false, error: 'shortcuts 必须是数组。' } };
        const next = [];
        for (const [index, raw] of shortcuts.entries()) {
          const normalized = normalizeEntry(raw, index);
          if (normalized.error) return { result: { ok: false, error: normalized.error } };
          next.push(normalized.value);
        }
        return { next, result: { ok: true, shortcuts: next } };
      }),
  };

  ctx.effect(() =>
    ctx.provide('promptShortcuts', {
      ...service,
      /** @returns the backing document path. */
      file: () => file,
    }),
  );

  /*
   * Browser-facing endpoint. A plain webServer route is used rather than
   * connection.rpc because this plugin owns one fixed path, and an exact route
   * is verifiable end to end with curl. The route waits for the web server
   * through ctx.inject, which runs once the service is live.
   */
  ctx.inject(['webServer'], (wsCtx) => {
    const server = wsCtx.webServer;
    if (!server || typeof server.register !== 'function') return;

    wsCtx.effect(() =>
      server.register({
        kind: 'exact',
        path: ROUTE_PATH,
        handler: async (req, res) => {
          const reply = (status, body) => {
            const text = JSON.stringify(body);
            res.writeHead(status, {
              'content-type': 'application/json; charset=utf-8',
              'content-length': Buffer.byteLength(text),
              'cache-control': 'no-store',
            });
            res.end(text);
          };

          if (req.method !== 'POST') {
            res.setHeader('allow', 'POST');
            reply(405, { ok: false, error: '仅支持 POST。' });
            return;
          }

          // Read the body with a hard size cap so one request cannot exhaust memory.
          const chunks = [];
          let size = 0;
          for await (const chunk of req) {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
              reply(413, { ok: false, error: '请求体过大。' });
              return;
            }
            chunks.push(chunk);
          }

          let body;
          try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
          } catch {
            reply(400, { ok: false, error: '请求体不是合法 JSON。' });
            return;
          }

          try {
            switch (body?.action) {
              case 'list':
                reply(200, await service.list());
                return;
              case 'replaceAll':
                reply(200, await service.replaceAll(body?.shortcuts));
                return;
              case 'translate':
                reply(200, await service.translate(body));
                return;
              default:
                reply(400, { ok: false, error: `未知操作：${String(body?.action)}` });
                return;
            }
          } catch (error) {
            reply(500, { ok: false, error: String(error?.message ?? error) });
          }
        },
      }),
    );
  });

  // Same deferred-registration reason as the RPC channel: the tools registry
  // may not be live yet when this plugin activates.
  ctx.inject(['tools'], (toolsCtx) => {
    const tools = toolsCtx.tools;
    if (!tools) return;

    toolsCtx.effect(() =>
      tools.register({
      name: 'prompt_shortcuts',
      description:
        'Manage the saved prompt shortcuts that appear as buttons above the composer. ' +
        'Actions: list (read all), save (create or update one by id), remove (delete one), ' +
        'translate (generate English label/prompt for the given Chinese text with the user\'s current model; ' +
        'returns the result without persisting it).',
      parameters: {
        action: {
          type: 'string',
          enum: ['list', 'save', 'remove', 'translate'],
          description: 'Operation to perform.',
          required: true,
        },
        id: { type: 'string', description: 'Shortcut id; required for remove, optional for save (omit to create).' },
        label: { type: 'string', description: 'Button text, at most 24 characters; required when creating or translating.' },
        prompt: { type: 'string', description: 'Text inserted into the composer when the button is clicked; required for translate.' },
        enabled: { type: 'boolean', description: 'Whether the button shows in the composer row.' },
        placement: {
          type: 'string',
          enum: ['both', 'hero', 'active'],
          description:
            'Where the button shows: both (default, New Session page and active sessions), ' +
            'hero (New Session page only), or active (sessions with an existing conversation only).',
        },
        labelEn: {
          type: 'string',
          description: 'Optional English label (at most 24 characters), shown when the UI language is English.',
        },
        promptEn: {
          type: 'string',
          description: 'Optional English prompt body, used when the UI language is English; {{variables}} must match the Chinese prompt.',
        },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      execute: async (args, exec) => {
        exec?.signal?.throwIfAborted?.();
        switch (args.action) {
          case 'list':
            return service.list();
          case 'save':
            return service.save({
              id: args.id,
              label: args.label,
              prompt: args.prompt,
              enabled: args.enabled,
              placement: args.placement,
              labelEn: args.labelEn,
              promptEn: args.promptEn,
            });
          case 'remove':
            if (!args.id) return { ok: false, error: 'remove 需要 id。' };
            return service.remove(args.id);
          case 'translate':
            if (!args.label || !args.prompt) return { ok: false, error: 'translate 需要 label 和 prompt。' };
            return service.translate({ label: args.label, prompt: args.prompt }, exec?.signal);
          default:
            return { ok: false, error: `未知操作：${String(args.action)}` };
        }
      },
      }),
    );
  });
}

/**
 * Services this plugin consumes: the LLM registry (for one-shot translate
 * calls) and the agent default model selection (the model the user currently
 * has chosen in the DSH interface).
 */
export const inject = ['llm', 'agentDefaultModel'];
