/**
 * Client half of the prompt-shortcuts bundle (local custom build v1.4.0).
 *
 * Changes versus upstream v1.1.2:
 *   1. The management UI (search + card grid + editor) moved from the floating
 *      maintenance dialog into a first-class settings page (settings.section
 *      "自定义指令", order 30). The trailing 添加指令 button is removed from the
 *      composer row.
 *   2. On the blank-session (New Session / Hero) page the shortcut row no
 *      longer renders below the workspace + mode selectors; instead a compact
 *      chip row (as many chips as fit + 更多 menu) renders in the
 *      conversation.hero.options seat, right of the mode (agent preset)
 *      selector. The dock entry detects the shell's data-phase and renders
 *      nothing while the page is a hero.
 *   3. Prompts may contain {{变量名}} placeholders. Clicking such a shortcut
 *      opens a small dialog that collects every variable (Enter submits,
 *      Shift+Enter inserts a newline) and then fills the composer with the
 *      substituted text. The editor lists the variables it detects.
 *   4. 显示范围 (placement) per shortcut: both (default) / hero (New Session
 *      page only) / active (sessions with a conversation only). Each seat
 *      filters the list by its own scope.
 *   5. Optional English variants per shortcut (labelEn / promptEn). The client
 *      tracks the active UI language through the shared `locale` service
 *      (<html lang> fallback) and displays the English variant while the
 *      interface language is English; the original text is the fallback. The
 *      editor carries two optional English fields plus a "generate with my
 *      current model" button that asks the Host half for a one-shot LLM
 *      translation.
 *
 * The Host half owns the JSON document, the /api/dsh-prompt-shortcuts route,
 * the one-shot translate action (via the user's current model), and the
 * prompt_shortcuts agent tool.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-prompt-shortcuts',
  factory(require) {
    const React = require('react');
    const { createSnapshotStore } = require('@deepseek-ai/dsh-client-store');
    const h = React.createElement;

    /** Logical RPC channel served by this package's Host half. */
    const ROUTE_PATH = '/api/dsh-prompt-shortcuts';
    const MAX_LABEL = 24;

    /**
     * One {{variable}} placeholder. Inner text: no braces, no newlines,
     * at most 32 characters (a longer span is treated as literal text).
     * Surrounding whitespace inside the braces is trimmed.
     */
    const VAR_RE = /\{\{\s*([^{}\n]{1,32}?)\s*\}\}/g;

    /**
     * 显示范围 (placement) values, mirrored from the Host half:
     *  - 'both'   the New Session (hero) page and sessions that already have a
     *             conversation;
     *  - 'hero'   the New Session page only;
     *  - 'active' sessions with an existing conversation only.
     */
    const PLACEMENTS = new Set(['both', 'hero', 'active']);

    /** Editor options for the placement field; labels resolve through UI_STRINGS. */
    const SCOPE_OPTIONS = [
      { value: 'both', key: 'scope_opt_both' },
      { value: 'hero', key: 'scope_hero' },
      { value: 'active', key: 'scope_active' },
    ];

    /** UI_STRINGS key for the card badge of entries whose placement is restricted. */
    const SCOPE_TAG_KEYS = { hero: 'scope_hero', active: 'scope_active' };

    /** @returns the validated placement of one entry ('both' when absent). */
    function placementOf(entry) {
      return PLACEMENTS.has(entry?.placement) ? entry.placement : 'both';
    }

    /**
     * The label to display for one entry under the active UI language: the
     * English variant when the UI is English and a variant exists, otherwise
     * the original text.
     */
    function displayLabel(entry, lang) {
      return lang === 'en' && entry.labelEn ? entry.labelEn : entry.label;
    }

    /** The prompt body to display / fill for one entry under the active UI language. */
    function displayPrompt(entry, lang) {
      return lang === 'en' && entry.promptEn ? entry.promptEn : entry.prompt;
    }

    /** @returns a display copy of one entry under the active UI language. */
    function localize(entry, lang) {
      return { ...entry, label: displayLabel(entry, lang), prompt: displayPrompt(entry, lang) };
    }

    /**
     * The plugin's own UI strings in both supported interface languages.
     * Every user-visible literal in this file resolves through this table
     * (data such as entry labels/prompts is content, not UI chrome, and is
     * localized separately via labelEn/promptEn).
     */
    const UI_STRINGS = {
      zh: {
        more: '更多',
        more_title: '还有 {n} 条未显示',
        menu_title: '更多指令',
        menu_empty: '所有提示词都已显示',
        close: '关闭',
        row_empty_none: '还没有提示词',
        row_empty_active: '没有适用于进行中的会话的提示词',
        dialog_title: '填写变量 · {label}',
        dialog_aria: '填写「{label}」的变量',
        dialog_hint: '填写完成后，组合好的指令会填入输入框；Enter 直接填入，Shift+Enter 换行。',
        dialog_var_placeholder: '输入「{name}」的内容',
        dialog_var_required: '请填写「{name}」。',
        dialog_cancel: '取消',
        dialog_fill: '填入输入框',
        settings_title: '自定义指令',
        settings_title_edit: '编辑提示词',
        settings_hint_browse:
          '把常用提示词保存为快捷按钮。提示词支持 {{变量名}} 占位符，点击按钮时会先弹出填写框；「显示范围」控制按钮出现在新会话页还是进行中的会话；英文版可手动填写或用当前模型生成，界面切到英文时自动显示。',
        settings_hint_edit: '改完点「返回列表」回到卡片，再点「保存」写入。删除和置顶在卡片上进行。',
        search_placeholder: '搜索自定义指令…',
        search_aria: '搜索自定义指令',
        add_title: '新增提示词',
        tile_title: '点「编辑」查看内容',
        tile_label_empty: '未命名',
        tile_body_empty: '（还没有内容）',
        en_tag_title: '已配置英文版，界面语言为英文时自动显示',
        scope_opt_both: '两者都显示',
        scope_hero: '仅新会话',
        scope_active: '仅进行中',
        scope_hero_title: '只在新建会话页显示',
        scope_active_title: '只在已有对话的会话中显示',
        scope_field: '显示范围（按钮出现在哪）',
        scope_aria: '显示范围',
        edit: '编辑',
        pin_on: '已置顶',
        pin_off: '置顶',
        pin_title_on: '已显示在输入框上方，点击取消',
        pin_title_off: '点击后显示在输入框上方',
        pin_check: '置顶（显示在输入框上方）',
        pin_check_title: '勾选后出现在输入框上方的按钮栏中',
        delete: '删除',
        delete_confirm: '确认删除',
        cancel: '取消',
        back: '返回列表',
        save: '保存',
        saving: '保存中…',
        save_failed: '保存失败。',
        err_no_label: '第 {n} 条缺少名称。',
        err_no_prompt: '第 {n} 条「{label}」缺少提示词内容。',
        http_error: '后端返回 HTTP {code}。',
        field_label: '名称（显示在按钮上，最多 24 字）',
        field_label_ph: '例如：代码评审',
        field_prompt: '提示词内容',
        field_prompt_ph: '点击按钮时会替换输入框内容；用 {{变量名}} 标记需要用户填写的部分',
        vars_hint: '点击该指令时会先填写：',
        en_section: '英文版（可选；界面语言为英文时自动显示）',
        en_label_ph: '英文名称（最多 24 字），例如 Code Review',
        en_label_aria: '英文名称',
        en_prompt_ph: '英文内容；{{变量名}} 保留花括号，变量名会翻译成英文（与中文版不必相同）',
        en_prompt_aria: '英文内容',
        en_generate: '用当前模型生成英文版',
        en_generating: '正在用当前模型生成…',
        en_need_base: '先填写名称和提示词内容，再生成英文版。',
        en_failed: '生成失败，请重试。',
        grid_empty_none: '还没有提示词，点右上角「+」新增。',
        grid_empty_nomatch: '没有匹配的提示词。',
        dock_label: '提示词快捷按钮',
      },
      en: {
        more: 'More',
        more_title: '{n} more hidden',
        menu_title: 'More prompts',
        menu_empty: 'All prompts are visible',
        close: 'Close',
        row_empty_none: 'No prompts yet',
        row_empty_active: 'No prompts for active sessions',
        dialog_title: 'Fill variables · {label}',
        dialog_aria: 'Fill the variables of "{label}"',
        dialog_hint: 'When filled in, the assembled prompt goes into the composer; Enter submits, Shift+Enter inserts a newline.',
        dialog_var_placeholder: 'Enter the value for "{name}"',
        dialog_var_required: 'Please fill in "{name}".',
        dialog_cancel: 'Cancel',
        dialog_fill: 'Fill composer',
        settings_title: 'Prompt shortcuts',
        settings_title_edit: 'Edit prompt',
        settings_hint_browse:
          'Save frequently used prompts as quick buttons. Prompts support {{variables}} — clicking such a button opens a fill-in dialog first. Placement controls whether the button shows on the New Session page or in active sessions; English variants can be typed or generated with your current model and show automatically when the UI language is English.',
        settings_hint_edit: 'Click Back to list when done, then Save to write. Delete and pin happen on the cards.',
        search_placeholder: 'Search prompt shortcuts…',
        search_aria: 'Search prompt shortcuts',
        add_title: 'Add prompt',
        tile_title: 'Click Edit to view',
        tile_label_empty: 'Untitled',
        tile_body_empty: '(no content yet)',
        en_tag_title: 'English variant set; shown automatically when the UI language is English',
        scope_opt_both: 'Both places',
        scope_hero: 'New session only',
        scope_active: 'Active only',
        scope_hero_title: 'Shown on the New Session page only',
        scope_active_title: 'Shown in sessions with a conversation only',
        scope_field: 'Placement (where the button appears)',
        scope_aria: 'Placement',
        edit: 'Edit',
        pin_on: 'Pinned',
        pin_off: 'Pin',
        pin_title_on: 'Shown above the composer; click to unpin',
        pin_title_off: 'Click to show above the composer',
        pin_check: 'Pin (show above the composer)',
        pin_check_title: 'When checked, appears in the button row above the composer',
        delete: 'Delete',
        delete_confirm: 'Confirm',
        cancel: 'Cancel',
        back: 'Back to list',
        save: 'Save',
        saving: 'Saving…',
        save_failed: 'Save failed.',
        err_no_label: 'Entry {n} has no label.',
        err_no_prompt: 'Entry {n} ("{label}") has no prompt body.',
        http_error: 'Backend returned HTTP {code}.',
        field_label: 'Label (shown on the button, up to 24 chars)',
        field_label_ph: 'e.g. Code review',
        field_prompt: 'Prompt body',
        field_prompt_ph: 'Replaces the composer content on click; mark parts the user must fill in as {{variable}}',
        vars_hint: 'Asks for these variables first:',
        en_section: 'English variant (optional; shown when the UI language is English)',
        en_label_ph: 'English label (up to 24 chars), e.g. Code Review',
        en_label_aria: 'English label',
        en_prompt_ph: 'English body; keep the {{variable}} braces intact — variable names may be translated and need not match the Chinese version',
        en_prompt_aria: 'English body',
        en_generate: 'Generate English with current model',
        en_generating: 'Generating with current model…',
        en_need_base: 'Fill in the label and body first, then generate the English version.',
        en_failed: 'Generation failed; please retry.',
        grid_empty_none: 'No prompts yet; click the + at the top right to add one.',
        grid_empty_nomatch: 'No matching prompts.',
        dock_label: 'Prompt shortcut buttons',
      },
    };

    /**
     * @returns a translator bound to one UI language. A missing key falls
     * back to the Chinese original, then to the key itself; `{name}` parts
     * are substituted from `vars`.
     */
    function makeT(lang) {
      const dict = UI_STRINGS[lang] || UI_STRINGS.en;
      return (key, vars) => {
        let text = dict[key] ?? UI_STRINGS.zh[key] ?? key;
        if (vars) {
          for (const [name, value] of Object.entries(vars)) {
            text = text.split(`{${name}}`).join(String(value));
          }
        }
        return text;
      };
    }

    /** @returns a fresh id for a new shortcut. */
    function newId() {
      return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    }

    /**
     * Extract the unique variable names (first-occurrence order) from one
     * prompt body. Literal braces that do not form a {{...}} token are
     * ignored.
     * @param prompt - the prompt text to scan.
     * @returns the ordered variable names.
     */
    function extractVars(prompt) {
      const out = [];
      const seen = new Set();
      if (typeof prompt !== 'string') return out;
      for (const match of prompt.matchAll(VAR_RE)) {
        const name = String(match[1]).trim();
        if (name === '' || seen.has(name)) continue;
        seen.add(name);
        out.push(name);
      }
      return out;
    }

    /**
     * Substitute every {{name}} in one prompt with the collected values.
     * Unknown tokens (e.g. a variable deleted from the dialog) are left as-is.
     * @param prompt - the template.
     * @param values - variable name → filled value.
     * @returns the filled text.
     */
    function renderPrompt(prompt, values) {
      return String(prompt).replace(VAR_RE, (text, name) => {
        const key = String(name).trim();
        return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : text;
      });
    }

    /**
     * Normalize one record.
     * @returns the clean shortcut, or null when it lacks a label or body.
     */
    function normalize(raw) {
      if (raw === null || typeof raw !== 'object') return null;
      const label = typeof raw.label === 'string' ? raw.label.trim() : '';
      const prompt = typeof raw.prompt === 'string' ? raw.prompt : '';
      if (label === '' || prompt.trim() === '') return null;
      const labelEn = typeof raw.labelEn === 'string' ? raw.labelEn.trim().slice(0, MAX_LABEL) : '';
      const promptEn = typeof raw.promptEn === 'string' ? raw.promptEn.trim() : '';
      return {
        id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : newId(),
        label: label.slice(0, MAX_LABEL),
        prompt,
        enabled: raw.enabled !== false,
        placement: PLACEMENTS.has(raw.placement) ? raw.placement : 'both',
        ...(labelEn !== '' ? { labelEn } : {}),
        ...(promptEn !== '' ? { promptEn } : {}),
      };
    }

    /** Coerce an arbitrary parsed value into a clean list. */
    function normalizeList(value) {
      const list = Array.isArray(value) ? value : [];
      const out = [];
      for (const raw of list) {
        const entry = normalize(raw);
        if (entry) out.push(entry);
      }
      return out;
    }

    /**
     * A store whose authority is the Host document, not browser storage.
     *
     * `localStorage` would be cleared with site data, which silently loses the
     * user's prompts, so the Host owns the file and this side only mirrors it.
     * Reads happen on mount; writes replace the whole list and echo the Host's
     * normalized answer back into the store, so validation lives in one place.
     *
     * @param call - the HTTP caller bound to this package's Host route.
     * @returns the snapshot store plus a save function.
     */
    function createStore(call) {
      const store = createSnapshotStore([]);
      let loaded = false;

      /** Ask the Host for the document and adopt its answer. */
      const refresh = async () => {
        const result = await call('list', {});
        if (result?.ok && Array.isArray(result.shortcuts)) {
          loaded = true;
          store.set(normalizeList(result.shortcuts));
        }
        return result;
      };

      /**
       * Persist the whole list.
       * @param shortcuts - the list to write.
       * @returns the Host's answer, whose `ok` is false when it rejected the input.
       */
      const save = async (shortcuts) => {
        const result = await call('replaceAll', { shortcuts });
        if (result?.ok && Array.isArray(result.shortcuts)) {
          store.set(normalizeList(result.shortcuts));
        }
        return result;
      };

      return {
        store,
        refresh,
        save,
        /** Ask the Host (the user's current model) to translate one shortcut. */
        translate: (payload) => call('translate', payload),
        /** Whether the Host has answered at least once. */
        hasLoaded: () => loaded,
      };
    }

    /**
     * Track one snapshot store's current value.
     * @param store - the snapshot store to observe.
     * @returns the current value, re-rendered on every change.
     */
    function useSnapshot(store) {
      const [value, setValue] = React.useState(() => store.getSnapshot());
      React.useEffect(
        () => store.subscribe(() => setValue(store.getSnapshot())),
        [store],
      );
      return value;
    }

    /**
     * Read the conversation shell's phase ("settling" | "hero" | "active")
     * from the `data-phase` attribute the shell puts on the conversation
     * root, and re-render when it changes. The shell itself is the
     * authority, so this never drifts from the real layout: the dock row must
     * hide on the hero (New Session) page, where the same shortcuts move to
     * the hero options seat.
     *
     * The value is NOT stable across a session switch, and this is where a
     * naive mount-once observer goes stale (the row then never reappears
     * until a page reload):
     *  - the shell swaps the New Session page in and out around the composer,
     *    so the root element captured at mount time can be detached while
     *    this component instance (or its captured reference) survives;
     *  - while the conversation data of a just-selected session resolves,
     *    the shell transiently reports "hero" (shellPhase "blank" +
     *    openState "open"), so the value at mount time is not the final one.
     * The hook therefore re-derives the root element and the phase during
     * render and after every commit (derived state, cheap: one ancestor walk
     * + one attribute read), and additionally watches the *current* root
     * with a MutationObserver, re-targeting it whenever the root's identity
     * changes, for attribute changes that do not re-render this component.
     *
     * @param anchorRef - ref to a node inside the conversation root that
     *                    stays mounted even while the visible row is hidden.
     * @returns the current phase.
     */
    function useComposerPhase(anchorRef) {
      const [phase, setPhase] = React.useState('active');
      const [rootEl, setRootEl] = React.useState(null);

      // Derived-state read: runs on every render, correcting the phase as
      // soon as a props-driven re-render lands (e.g. a session switch).
      const el = anchorRef.current;
      const root = el && typeof el.closest === 'function' ? el.closest('[data-phase]') : null;
      if (root) {
        const next = root.getAttribute('data-phase') || 'active';
        if (next !== phase) setPhase(next);
        if (root !== rootEl) setRootEl(root);
      }

      // Post-commit read: also runs on the very first commit, when the
      // anchor (and therefore the closest() result) only now exists.
      React.useLayoutEffect(() => {
        const a = anchorRef.current;
        const r = a && typeof a.closest === 'function' ? a.closest('[data-phase]') : null;
        if (!r) return undefined;
        const next = r.getAttribute('data-phase') || 'active';
        setPhase((prev) => (prev === next ? prev : next));
        setRootEl((prev) => (prev === r ? prev : r));
        return undefined;
      });

      // Watch the current root for attribute changes that do not re-render
      // this component; re-attach when the root element is replaced.
      React.useLayoutEffect(() => {
        if (!rootEl) return undefined;
        const sync = () => {
          const next = rootEl.getAttribute('data-phase') || 'active';
          setPhase((prev) => (prev === next ? prev : next));
        };
        sync();
        const observer = new MutationObserver(sync);
        observer.observe(rootEl, { attributes: true, attributeFilter: ['data-phase'] });
        return () => observer.disconnect();
      }, [rootEl]);

      return phase;
    }

    const CSS = `
 /*
  * Docks in this slot are calibrated against the composer card, which is
  * centered at --dsh-composer-card-max-width inside a full-width seat. Without
  * the same width, max-width, auto margins, and inset padding the row stretches
  * edge to edge and visually detaches from the card below it.
  */
.ps-row {
  box-sizing: border-box;
  display: flex; flex-wrap: nowrap; align-items: center; gap: 6px;
  /* Chips hug the card's right edge (above the send button): the row box stays
     aligned with the card, only the content is right-aligned. */
  justify-content: flex-end;
  position: relative;
  width: calc(100% - var(--dsh-composer-side-clearance) - var(--dsh-composer-side-clearance) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));
  max-width: calc(var(--dsh-composer-card-max-width) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));
  margin: 0 auto;
  padding: 0 var(--dsh-composer-dock-inset);
  flex: none;
}
 /*
  * Hero-page seat: the shell's .heroOptions wrapper is flex:none (content
  * sized); the override below neutralizes its margin-left:auto so the chips
  * sit flush right of the mode selector instead of the row's right edge.
  * The cap keeps the chip row from ever pushing the mode selector off the
  * row on narrow windows; the fit pass measures against the same budget.
  */
.ps-hero {
  box-sizing: border-box;
  display: flex; flex-wrap: nowrap; align-items: center; gap: 6px;
  position: relative;
  min-width: 0;
  max-width: min(44vw, 420px);
  flex: none;
}
 /*
  * The shell's .heroOptions wrapper (hashed class from
  * dsh-client-ui-conversation) carries margin-left:auto, which pushes slot
  * content to the right edge of the hero row. The user wants the chips flush
  * right of the mode selector, so clear the push on the wrapper itself. The
  * wrapper exists only for this slot (and hides itself when empty), so the
  * override cannot affect any other part of the hero row. The class is
  * doubled to out-specificity the shell's own rule regardless of the order
  * the two style tags happen to sit in.
  */
.wSkVaW_heroOptions.wSkVaW_heroOptions { margin-left: 0; }
 /*
  * Offscreen copies used only to measure chip widths. They must keep real layout
  * metrics (so text and padding render identically) while occupying no space:
  * the wrapper is taken out of flow entirely and clamped to zero width, or its
  * intrinsic width would otherwise squeeze the real chips beside it.
  */
.ps-probe {
  position: absolute; top: 0; left: 0;
  display: flex; gap: 6px;
  width: 0; height: 0; overflow: hidden;
  flex: none;
  visibility: hidden; pointer-events: none;
}
.ps-probe > .ps-chip { flex: none; }
 /*
  * The row borrows the composer card's own surface language rather than
  * inventing one: a solid fill, no hard border (the elevation's 0.5px spread
  * IS the hairline stroke), a soft drop shadow, and a radius well short of the
  * card's pill-shaped 28px so the buttons read as smaller siblings, not peers.
  */
.ps-chip {
  display: inline-flex; align-items: center; gap: 5px; max-width: 220px;
  box-sizing: border-box;
  padding: 4px 11px; border-radius: var(--dsw-radius-md, 12px); cursor: pointer;
  font: inherit; font-size: 13px; line-height: 18px; white-space: nowrap;
  color: var(--dsw-alias-label-secondary);
  background: var(--dsw-specific-input-major, var(--dsw-alias-bg-base));
  border: 0;
  box-shadow: var(--dsw-elevation-soft);
  transition: color 120ms ease, box-shadow 120ms ease;
}
.ps-chip > .ps-chip-label { overflow: hidden; text-overflow: ellipsis; }
.ps-chip:hover {
  color: var(--dsw-alias-label-primary);
  box-shadow: 0 0 0 .5px var(--dsw-alias-border-l2), 0 4px 16px 0 rgba(0, 0, 0, .06);
}
.ps-chip:active { transform: translateY(.5px); }
.ps-chip:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
 /* The trailing 更多 control: quieter than the chips it collects. */
.ps-gear {
  display: inline-flex; align-items: center; gap: 5px;
  box-sizing: border-box;
  padding: 4px 11px; border-radius: var(--dsw-radius-md, 12px); cursor: pointer;
  font: inherit; font-size: 13px; line-height: 18px;
  color: var(--dsw-alias-label-secondary);
  background: transparent;
  border: 0;
  box-shadow: 0 0 0 .5px var(--dsw-alias-border-l1);
  transition: color 120ms ease, box-shadow 120ms ease, background 120ms ease;
}
.ps-gear:hover {
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-specific-input-major, var(--dsw-alias-bg-base));
  box-shadow: var(--dsw-elevation-soft);
}
.ps-gear:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.ps-gear[data-ps-trailing] { flex: none; }

/* Badge counting the prompts that are kept out of the row. */
.ps-count {
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 16px; height: 16px; padding: 0 4px; box-sizing: border-box;
  border-radius: 999px;
  font-size: 11px; line-height: 1;
  color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, .06));
}

/*
  * 更多 opens a menu rather than a dialog: it picks one value and closes, so a
  * light anchored surface fits better than a modal that would cover the composer.
  * It is absolutely positioned against its row (the anchored ancestor).
  */
.ps-menu {
  position: absolute; z-index: 40;
  top: calc(100% - 2px); right: 0;
  min-width: 240px; max-width: min(420px, 90vw); max-height: 280px; overflow: auto;
  padding: 4px; box-sizing: border-box;
  border-radius: var(--dsw-radius-md, 12px);
  background: var(--dsw-specific-input-major, var(--dsw-alias-bg-overlay));
  border: 0;
  box-shadow: 0 0 0 .5px var(--dsw-alias-border-l2), 0 8px 28px rgba(0, 0, 0, .16);
}
.ps-menu-item {
  display: flex; flex-direction: column; gap: 1px; width: 100%;
  box-sizing: border-box; padding: 7px 9px;
  border-radius: var(--dsw-radius-sm, 8px); cursor: pointer; text-align: left;
  font: inherit;
  color: var(--dsw-alias-label-primary);
  background: transparent;
  border: 0;
}
.ps-menu-item:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, .05)); }
.ps-menu-item:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -1px; }
.ps-menu-label { font-size: 13px; font-weight: 500; line-height: 18px; }
.ps-menu-body {
  font-size: 12px; line-height: 16px; color: var(--dsw-alias-label-secondary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%;
}
.ps-menu-empty { padding: 14px 9px; font-size: 12px; color: var(--dsw-alias-label-secondary); text-align: center; }
/* Menu header row: label on the left, close control on the right. */
.ps-menu-head {
  display: flex; align-items: center; gap: 8px;
  padding: 2px 4px 6px 9px; margin-bottom: 2px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.ps-menu-title { flex: 1; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.ps-menu-close {
  flex: none; display: inline-flex; align-items: center; justify-content: center;
  width: 22px; height: 22px; border-radius: var(--dsw-radius-sm, 8px); cursor: pointer;
  color: var(--dsw-alias-label-secondary);
  background: transparent;
  border: 0;
  transition: color 120ms ease, background 120ms ease;
}
.ps-menu-close:hover {
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, .05));
}
.ps-menu-close:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }

/* Icons inherit text color so one drawing serves every state and theme. */
.ps-ico { display: block; flex: none; }
.ps-empty { font-size: 12px; color: var(--dsw-alias-label-secondary); padding: 4px 2px; }
.ps-backdrop {
  position: fixed; inset: 0; z-index: 60;
  background: rgba(0, 0, 0, 0.35);
  display: flex; align-items: center; justify-content: center;
}
.ps-panel {
  display: flex; flex-direction: column;
  width: min(900px, 92vw); max-height: 82vh;
  border-radius: var(--dsw-radius-panel, 28px); padding: 20px;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-specific-input-major, var(--dsw-alias-bg-overlay));
  border: 0;
  box-shadow: 0 0 0 .5px var(--dsw-alias-border-l2), 0 16px 48px rgba(0, 0, 0, .18);
}
/* The variable dialog is narrower than a full panel. */
.ps-var-panel { width: min(560px, 92vw); }
.ps-title { font-size: 15px; font-weight: 600; margin: 0 0 2px; }
.ps-hint { font-size: 12px; color: var(--dsw-alias-label-secondary); margin: 0; }

/* Header: the copy block, with the close control pinned to the top right. */
.ps-head-row { display: flex; align-items: flex-start; gap: 12px; margin-bottom: 14px; }
.ps-head-text { flex: 1; min-width: 0; }
.ps-head-text .ps-hint { margin-bottom: 0; }
.ps-close {
  flex: none; display: inline-flex; align-items: center; justify-content: center;
  width: 30px; height: 30px; border-radius: var(--dsw-radius-sm, 8px); cursor: pointer;
  color: var(--dsw-alias-label-secondary);
  background: transparent;
  border: 0;
  transition: color 120ms ease, background 120ms ease;
}
.ps-close:hover {
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, .05));
}
.ps-close:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }

/* Header: search field plus the create action. */
.ps-head { display: flex; align-items: center; gap: 8px; margin-bottom: 14px; flex: none; }
.ps-search {
  flex: 1; box-sizing: border-box; font: inherit; font-size: 13px;
  padding: 8px 12px; border-radius: var(--dsw-radius-md, 12px);
  color: var(--dsw-alias-label-primary);
  background: transparent;
  border: 0;
  box-shadow: 0 0 0 .5px var(--dsw-alias-border-l2);
}
.ps-search::placeholder { color: var(--dsw-alias-label-secondary); }
.ps-search:focus {
  outline: none;
  box-shadow: 0 0 0 1px var(--dsw-alias-brand-primary);
}
.ps-icon-btn {
  flex: none; display: inline-flex; align-items: center; justify-content: center;
  width: 36px; height: 36px; border-radius: var(--dsw-radius-md, 12px); cursor: pointer;
  color: var(--dsw-alias-label-primary);
  background: transparent;
  border: 0;
  box-shadow: 0 0 0 .5px var(--dsw-alias-border-l2);
  transition: background 120ms ease, box-shadow 120ms ease;
}
.ps-icon-btn:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, .04));
  box-shadow: var(--dsw-elevation-soft);
}
.ps-icon-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }

/* Browse state: a responsive card grid, one card per saved prompt. */
.ps-grid {
  display: grid; gap: 10px; overflow: auto; padding: 2px;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
}
/*
  * Inside the settings page the shell's content column owns the scroll, so the
  * grid must not clip itself.
  */
.ps-grid-page { overflow: visible; }
/*
  * White tiles need a visible edge against this white panel: DSH's soft
  * elevation gets its outline from a white card sitting on a grey page, which a
  * transparent tile here had none of. border-l2 (10% black) carries the outline,
  * and the hover shadow adds the lift.
  */
.ps-tile {
  display: flex; flex-direction: column; gap: 6px;
  box-sizing: border-box; min-height: 104px;
  padding: 12px; border-radius: var(--dsw-radius-lg, 16px); cursor: pointer; text-align: left;
  font: inherit;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-specific-input-major, var(--dsw-alias-bg-base));
  border: 0;
  box-shadow: 0 0 0 1px var(--dsw-alias-border-l2);
  transition: box-shadow 120ms ease, background 120ms ease;
}
.ps-tile:hover {
  box-shadow: 0 0 0 1px var(--dsw-alias-border-l2), 0 4px 16px 0 rgba(0, 0, 0, .07);
}
.ps-tile:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.ps-tile-head { display: flex; align-items: flex-start; gap: 6px; }
.ps-tile-label { flex: 1; font-size: 13px; font-weight: 600; line-height: 20px; }
.ps-tile-body {
  font-size: 12px; line-height: 17px; color: var(--dsw-alias-label-secondary);
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
  overflow: hidden;
}
.ps-tile-foot { display: flex; align-items: center; gap: 2px; margin-top: auto; flex-wrap: wrap; }
.ps-tile-act {
  display: inline-flex; align-items: center; gap: 3px;
  font: inherit; font-size: 12px; padding: 2px 6px; border-radius: var(--dsw-radius-sm, 8px); cursor: pointer;
  white-space: nowrap;
  color: var(--dsw-alias-label-secondary);
  background: transparent;
  border: 0;
  transition: color 120ms ease, background 120ms ease;
}
.ps-tile-act:hover {
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, .05));
}
.ps-tile-act:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
/* Lit 置顶 state: this entry is one of the buttons above the composer. */
.ps-tile-act-on { color: var(--dsw-alias-brand-primary); }
.ps-tile-act-danger:hover { color: var(--dsw-alias-state-error-primary); }
.ps-confirm { display: inline-flex; align-items: center; gap: 4px; }
.ps-grid-empty {
  padding: 36px 8px; text-align: center;
  font-size: 13px; color: var(--dsw-alias-label-secondary);
}

/* Edit state: one shortcut at a time, reusing the composer's own depth cues. */
.ps-editor { display: flex; flex-direction: column; gap: 14px; overflow: auto; padding: 2px; }
.ps-field { display: flex; flex-direction: column; gap: 6px; }
.ps-field-label { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.ps-input, .ps-area {
  width: 100%; box-sizing: border-box; font: inherit; font-size: 13px;
  padding: 8px 12px; border-radius: var(--dsw-radius-md, 12px);
  color: var(--dsw-alias-label-primary);
  background: transparent;
  border: 0;
  box-shadow: 0 0 0 .5px var(--dsw-alias-border-l2);
}
.ps-area { min-height: 150px; resize: vertical; line-height: 20px; font-family: inherit; }
.ps-area-sm { min-height: 40px; resize: none; }
.ps-input::placeholder, .ps-area::placeholder { color: var(--dsw-alias-label-secondary); }
.ps-input:focus, .ps-area:focus {
  outline: none;
  box-shadow: 0 0 0 1px var(--dsw-alias-brand-primary);
}
.ps-grow { flex: 1; }
.ps-check {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: 12px; color: var(--dsw-alias-label-secondary); cursor: pointer;
}
/* 显示范围 segmented control: three mutually exclusive chips. */
.ps-seg { display: flex; gap: 6px; flex-wrap: wrap; }
.ps-seg-item {
  display: inline-flex; align-items: center;
  padding: 4px 11px; border-radius: var(--dsw-radius-md, 12px); cursor: pointer;
  font: inherit; font-size: 12px; line-height: 18px;
  color: var(--dsw-alias-label-secondary);
  background: transparent; border: 0;
  box-shadow: 0 0 0 .5px var(--dsw-alias-border-l2);
  transition: color 120ms ease, box-shadow 120ms ease, background 120ms ease;
}
.ps-seg-item:hover {
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, .04));
}
.ps-seg-item:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.ps-seg-on {
  color: var(--dsw-alias-label-primary);
  box-shadow: 0 0 0 1px var(--dsw-alias-brand-primary);
}
/* Card badge for entries whose 显示范围 is restricted. */
.ps-scope-tag {
  flex: none; display: inline-flex; align-items: center;
  padding: 0 6px; border-radius: 6px;
  font-size: 11px; line-height: 16px;
  color: var(--dsw-alias-label-secondary);
  box-shadow: 0 0 0 .5px var(--dsw-alias-border-l2);
}
/* 英文版 section in the editor. */
.ps-en-field { gap: 8px; }
.ps-en-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.ps-btn-sm { padding: 4px 12px; font-size: 12px; line-height: 18px; }
.ps-en-error { font-size: 12px; color: var(--dsw-alias-status-error, #d43c3c); }
/* Small EN badge next to a card label when an English variant exists. */
.ps-en-tag { margin-left: 4px; }
/* Detected {{variables}} shown under the prompt editor. */
.ps-vars-hint { display: flex; align-items: center; flex-wrap: wrap; gap: 4px; margin-top: 6px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.ps-var-chip {
  display: inline-flex; align-items: center;
  padding: 1px 7px; border-radius: 6px;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 11px; line-height: 16px;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, .05));
  box-shadow: 0 0 0 .5px var(--dsw-alias-border-l2);
}
.ps-btn {
  display: inline-flex; align-items: center; gap: 5px;
  font: inherit; font-size: 13px; padding: 6px 14px;
  border-radius: var(--dsw-radius-md, 12px); cursor: pointer;
  color: var(--dsw-alias-label-primary);
  background: transparent;
  border: 0;
  box-shadow: 0 0 0 .5px var(--dsw-alias-border-l2);
  transition: background 120ms ease, box-shadow 120ms ease;
}
.ps-btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, .04)); }
.ps-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
/* Primary button: fill + label token pair inverts per theme (light: near-black
   fill with white label; dark: near-white fill with near-black label), exactly
   the pair the shell's own primary buttons use. */
.ps-btn-primary {
  color: var(--dsw-alias-label-primary-foreground, #fff);
  background: var(--dsw-alias-button-primary-fill, #0f1115);
  box-shadow: none;
}
.ps-btn-primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover, #1f2430); filter: none; }
.ps-btn-primary:disabled { opacity: .6; cursor: default; }
.ps-btn-danger { color: var(--dsw-alias-state-error-primary); }
.ps-foot { display: flex; align-items: center; gap: 8px; margin-top: 16px; flex: none; }
.ps-error { color: var(--dsw-alias-state-error-primary); font-size: 12px; margin: 0 0 10px; }

/* Settings page: the shell's content column already provides the padding and
   the scroll, so the page only stacks its own blocks. */
.ps-settings { display: flex; flex-direction: column; gap: 14px; min-height: 0; }
`;

    /*
     * Icons redraw the artwork the shipped UI uses for these exact concepts
     * (16x16 grid, 1px stroke, currentColor), inlined because the primitives
     * package is not an importable module for an installed bundle. Passing
     * currentColor keeps one drawing correct in every state and both themes.
     */
    const STROKE = 1;

    /** Build one 16x16 icon from its path descriptors. */
    function icon(paths, size) {
      return h(
        'svg',
        {
          className: 'ps-ico',
          width: size, height: size, viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: STROKE,
          'aria-hidden': 'true',
          focusable: 'false',
        },
        paths.map((p, i) => h('path', { key: i, ...p })),
      );
    }

    const IconPin = (size) =>
      icon(
        [
          {
            d: 'M9.96976 1.70572L13.1554 3.93629L10.9019 8.12317L11.5158 11.605L10.7192 12.7427L2.52767 7.00693L3.3243 5.86922L6.80612 5.25528L9.96976 1.70572Z',
            strokeLinejoin: 'round',
          },
          {
            d: 'M6.05285 9.47511C6.27284 9.16094 6.70586 9.08458 7.02003 9.30457C7.3342 9.52455 7.41055 9.95757 7.19057 10.2717L3.98587 14.4708L3.21223 13.9291L6.05285 9.47511Z',
            fill: 'currentColor',
          },
        ],
        size,
      );

    const IconEdit = (size) =>
      icon(
        [
          {
            d: 'M8.85596 2.69971H4.19971C3.37141 2.69971 2.69992 3.37146 2.69971 4.19971V11.8003C2.69992 12.6285 3.37141 13.3003 4.19971 13.3003H11.8003C12.6283 13.2999 13.3001 12.6283 13.3003 11.8003V7.89893H14.3003V11.8003C14.3001 13.1806 13.1806 14.2999 11.8003 14.3003H4.19971C2.81913 14.3003 1.69992 13.1808 1.69971 11.8003V4.19971C1.69992 2.81918 2.81913 1.69971 4.19971 1.69971H8.85596V2.69971Z',
            fill: 'currentColor',
            stroke: 'none',
          },
          { d: 'M7.7849 8.23878L13.888 2.13574' },
        ],
        size,
      );

    const IconTrash = (size) =>
      icon(
        [
          { d: 'M1.28149 3.88831H14.7187' },
          {
            d: 'M5.41602 3.88833V2.47962C5.41602 2.29282 5.52492 2.11366 5.71876 1.98157C5.9126 1.84948 6.17551 1.77527 6.44964 1.77527H9.55053C9.82466 1.77527 10.0876 1.84948 10.2814 1.98157C10.4753 2.11366 10.5842 2.29282 10.5842 2.47962V3.88833',
          },
          {
            d: 'M2.57349 3.88831L3.19366 13.2943C3.21937 13.5502 3.33952 13.7872 3.53065 13.9593C3.72178 14.1313 3.97016 14.2259 4.22729 14.2246H11.7728C12.0299 14.2259 12.2783 14.1313 12.4694 13.9593C12.6605 13.7872 12.7807 13.5502 12.8064 13.2943L13.4266 3.88831',
          },
          { d: 'M6.44946 6.98926V11.1238' },
          { d: 'M9.55054 6.98926V11.1238' },
        ],
        size,
      );

    const IconPlus = (size) => icon([{ d: 'M8 2V14' }, { d: 'M2 8H14' }], size);

    const IconChevronDown = (size) =>
      icon(
        [{ d: 'M4 6L7.29289 9.29289C7.68342 9.68342 8.31658 9.68342 8.70711 9.29289L12 6' }],
        size,
      );

    // Named for the row slot it fills: a short list that opens a longer one.
    const IconMore = IconChevronDown;

    const IconClose = (size) => icon([{ d: 'M2.5 2.5L13.5 13.5' }, { d: 'M13.5 2.5L2.5 13.5' }], size);

    /**
     * Fill the composer draft from one shortcut, opening the variable dialog
     * first when the prompt carries {{variables}}.
     * @param entry - the shortcut that was clicked.
     * @param inputActions - the session's input actions.
     * @param requestFill - dialog opener; receives the entry and its variables.
     */
    function activateEntry(entry, inputActions, requestFill) {
      if (!inputActions) return;
      const vars = extractVars(entry.prompt);
      if (vars.length === 0) {
        // The user chose replace semantics: the draft becomes exactly the preset.
        inputActions.setDraft(entry.prompt);
        if (typeof inputActions.focus === 'function') inputActions.focus();
      } else {
        requestFill(entry, vars);
      }
    }

    /**
     * Variable dialog: one auto-growing field per {{variable}}. Submitting
     * requires every field to be non-empty; then the substituted prompt fills
     * the composer. Enter submits (Shift+Enter inserts a newline; IME
     * composition Enter is ignored), Escape cancels.
     * @param props - entry, the variable names, and the fill/close callbacks.
     */
    function VariableDialog(props) {
      const [values, setValues] = React.useState(() => {
        const initial = {};
        for (const name of props.variables) initial[name] = '';
        return initial;
      });
      const [error, setError] = React.useState('');
      const firstRef = React.useRef(null);

      React.useEffect(() => {
        if (firstRef.current && typeof firstRef.current.focus === 'function') firstRef.current.focus();
      }, []);

      const submit = () => {
        for (const name of props.variables) {
          if (String(values[name] ?? '').trim() === '') {
            setError(props.t('dialog_var_required', { name }));
            return;
          }
        }
        setError('');
        props.onFill(renderPrompt(props.entry.prompt, values));
      };

      /** Enter submits, Shift+Enter keeps its newline, IME Enter never submits. */
      const onKey = (event) => {
        if (event.key !== 'Enter' || event.shiftKey) return;
        const native = event.nativeEvent || event;
        if (native.isComposing || native.keyCode === 229) return;
        event.preventDefault();
        submit();
      };

      const grow = (event) => {
        const el = event.target;
        el.style.height = 'auto';
        el.style.height = `${el.scrollHeight + 2}px`;
      };

      return h(
        'div',
        {
          className: 'ps-backdrop',
          role: 'presentation',
          onClick: (event) => {
            if (event.target === event.currentTarget) props.onClose();
          },
        },
        h(
          'div',
          {
            className: 'ps-panel ps-var-panel',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': props.t('dialog_aria', { label: props.entry.label }),
            onKeyDown: (event) => {
              if (event.key === 'Escape') props.onClose();
            },
          },
          h(
            'div',
            { className: 'ps-head-row' },
            h(
              'div',
              { className: 'ps-head-text' },
              h('h2', { className: 'ps-title' }, props.t('dialog_title', { label: props.entry.label })),
              h(
                'p',
                { className: 'ps-hint' },
                props.t('dialog_hint'),
              ),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'ps-close',
                title: props.t('close'),
                'aria-label': props.t('close'),
                onClick: props.onClose,
              },
              IconClose(14),
            ),
          ),
          error ? h('div', { className: 'ps-error', role: 'alert' }, error) : null,
          h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 12, overflow: 'auto', padding: '2px' } },
            props.variables.map((name, index) =>
              h(
                'div',
                { key: name, className: 'ps-field' },
                h('label', { className: 'ps-field-label', htmlFor: `ps-var-${index}` }, name),
                h('textarea', {
                  id: `ps-var-${index}`,
                  ref: index === 0 ? firstRef : null,
                  className: 'ps-area ps-area-sm',
                  rows: 2,
                  value: values[name] ?? '',
                  placeholder: props.t('dialog_var_placeholder', { name }),
                  onChange: (event) => {
                    setValues((current) => ({ ...current, [name]: event.target.value }));
                    if (error) setError('');
                    grow(event);
                  },
                  onKeyDown: onKey,
                }),
              ),
            ),
          ),
          h(
            'div',
            { className: 'ps-foot' },
            h('span', { className: 'ps-grow' }),
            h(
              'button',
              { type: 'button', className: 'ps-btn', onClick: props.onClose },
              props.t('dialog_cancel'),
            ),
            h(
              'button',
              { type: 'button', className: 'ps-btn ps-btn-primary', onClick: submit },
              props.t('dialog_fill'),
            ),
          ),
        ),
      );
    }

    /**
     * The composer-attached shortcut row (active sessions only).
     *
     * The shell's data-phase decides the layout: on the hero (New Session)
     * page this entry renders nothing, because the same shortcuts then sit in
     * the hero options seat right of the mode selector. Management (添加/编辑/
     * 删除) lives in the settings page, so the row carries no 添加指令 button.
     * @param props - the slot supplies the current session's input actions.
     */
    function ShortcutRow(props) {
      const store = props.store;
      const list = useSnapshot(store);
      const [moreOpen, setMoreOpen] = React.useState(false);
      const [filling, setFilling] = React.useState(null);
      const inputActions = props.inputActions;
      const lang = useSnapshot(props.localeStore);
      const t = makeT(lang);

      // A zero-size anchor that stays mounted even while the visible row is
      // hidden, so the phase hook can keep tracking the conversation root
      // through New Session ↔ session transitions (see useComposerPhase).
      // Note: the row's visibility must NOT be an early `return null` here —
      // hooks declared further below would then run a different number of
      // times per render when the phase flips, which React treats as an
      // error. The row is conditionally rendered in the return instead.
      const anchorRef = React.useRef(null);
      const phase = useComposerPhase(anchorRef);
      const rowRef = React.useRef(null);
      // The hero page shows the chips in the hero options seat instead; the
      // settling state keeps the row (the hero row is not visible yet).
      const showRow = inputActions !== undefined && inputActions !== null && phase !== 'hero';

      // This seat only renders in a session that already has a conversation,
      // so entries scoped to the New Session page ('hero') stay hidden here;
      // 'both' and 'active' entries show.
      const visible = list.filter((entry) => {
        const scope = placementOf(entry);
        return entry.enabled && (scope === 'both' || scope === 'active');
      });
      // Display copies under the active UI language: labels and bodies that
      // have an English variant follow the interface language.
      const view = visible.map((entry) => localize(entry, lang));

      /**
       * Fill the composer from one shortcut (with the variable dialog when
       * needed), closing any open menu first.
       * @param entry - the shortcut that was clicked.
       */
      const fill = (entry) => {
        activateEntry(entry, inputActions, (entry2, vars) => setFilling({ entry: entry2, vars }));
        setMoreOpen(false);
      };

      // How many pinned entries actually fit before the trailing control.
      const [fitted, setFitted] = React.useState(visible.length);

      /*
       * Decide the row's contents from real rendered widths rather than a
       * character estimate, so mixed CJK/latin labels and font-size changes all
       * come out right. Chips are measured offscreen at their real styles, then
       * as many as fit beside 更多 are kept and the rest overflow into
       * the menu. The row therefore never wraps.
       *
       * At least one chip stays on the row whenever any are pinned: a row that
       * dropped every button would hide the very thing it exists to offer.
       */
      React.useLayoutEffect(() => {
        const row = rowRef.current;
        if (!row) return undefined;

        const measure = () => {
          const style = getComputedStyle(row);
          const gap = parseFloat(style.columnGap) || 0;
          const padL = parseFloat(style.paddingLeft) || 0;
          const padR = parseFloat(style.paddingRight) || 0;
          const available = row.clientWidth - padL - padR;

          // The trailing control keeps its rendered width; measure it live.
          const trailing = row.querySelectorAll('[data-ps-trailing]');
          let trailingW = 0;
          for (const el of trailing) trailingW += el.getBoundingClientRect().width;
          if (trailing.length > 0) trailingW += gap * trailing.length;

          const probe = row.querySelector('[data-ps-probe]');
          const widths = probe
            ? [...probe.children].map((el) => el.getBoundingClientRect().width)
            : [];

          let used = 0;
          let count = 0;
          for (const w of widths) {
            const next = used + w + (count > 0 ? gap : 0);
            if (next + trailingW > available) break;
            used = next;
            count += 1;
          }
          // Keep one chip on the row whenever anything is pinned, so an
          // extremely narrow row still shows a usable button.
          if (count === 0 && widths.length > 0) count = 1;
          setFitted((prev) => (prev === count ? prev : count));
        };

        measure();
        /*
         * Watch the trailing control as well as the row: its width changes with
         * the badge text, and the badge text changes with the fit count.
         * Observing only the row could settle one render behind, which showed
         * already-visible chips again inside 更多.
         */
        const observer = new ResizeObserver(measure);
        observer.observe(row);
        for (const el of row.querySelectorAll('[data-ps-trailing]')) observer.observe(el);
        return () => observer.disconnect();
      }, [showRow, view.map((e) => `${e.id}:${e.label}`).join('|'), fitted]);

      const shown = view.slice(0, fitted);
      // Everything not on the row — explicitly unpinned entries plus the ones
      // that did not fit — stays reachable through 更多.
      const overflow = view.slice(fitted);
      const menuEntries = [
        ...overflow,
        ...list.filter((entry) => !entry.enabled).map((entry) => localize(entry, lang)),
      ];

      const chipFor = (entry, extra) =>
        h(
          'button',
          {
            key: entry.id,
            type: 'button',
            className: 'ps-chip',
            title: entry.prompt,
            onClick: () => fill(entry),
            ...extra,
          },
          h('span', { className: 'ps-chip-label' }, entry.label),
        );

      const chips = shown.map((entry) => chipFor(entry));

      if (visible.length === 0) {
        chips.push(
          h(
            'span',
            { key: 'empty', className: 'ps-empty' },
            list.length === 0 ? t('row_empty_none') : t('row_empty_active'),
          ),
        );
      }

      const moreRef = React.useRef(null);
      const menuRef = React.useRef(null);

      // Close the popover on an outside click or Escape, the way a menu should.
      React.useEffect(() => {
        if (!moreOpen) return undefined;
        const onDown = (event) => {
          if (menuRef.current?.contains(event.target)) return;
          if (moreRef.current?.contains(event.target)) return;
          setMoreOpen(false);
        };
        const onKey = (event) => {
          if (event.key === 'Escape') setMoreOpen(false);
        };
        document.addEventListener('mousedown', onDown, true);
        document.addEventListener('keydown', onKey, true);
        return () => {
          document.removeEventListener('mousedown', onDown, true);
          document.removeEventListener('keydown', onKey, true);
        };
      }, [moreOpen]);

      if (menuEntries.length > 0) {
        chips.push(
          h(
            'button',
            {
              key: 'more',
              type: 'button',
              ref: moreRef,
              className: 'ps-gear ps-gear-end',
              'data-ps-trailing': '',
              title: t('more_title', { n: menuEntries.length }),
              'aria-haspopup': 'menu',
              'aria-expanded': moreOpen,
              onClick: () => setMoreOpen((v) => !v),
            },
            IconMore(14),
            t('more'),
            h('span', { className: 'ps-count' }, String(menuEntries.length)),
          ),
        );
      }

      return h(
        React.Fragment,
        null,
        // Zero-size phase anchor: keeps useComposerPhase tracking the
        // conversation root even while the visible row is hidden.
        h('div', { ref: anchorRef, style: { display: 'none' } }),
        showRow
          ? h(
            'div',
            { className: 'ps-row', ref: rowRef },
            chips,
          // Offscreen copies of every visible chip at their real styles, so the
          // fit calculation measures text instead of guessing at it. Hidden from
          // layout, painting, and assistive technology.
          h(
            'div',
            { className: 'ps-probe', 'data-ps-probe': '', 'aria-hidden': 'true' },
            view.map((entry) => chipFor(entry, { tabIndex: -1 })),
          ),
          moreOpen
            ? h(
                'div',
                { className: 'ps-menu', ref: menuRef, role: 'menu' },
                h(
                  'div',
                  { className: 'ps-menu-head' },
                  h('span', { className: 'ps-menu-title' }, t('menu_title')),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'ps-menu-close',
                      title: t('close'),
                      'aria-label': t('close'),
                      onClick: () => setMoreOpen(false),
                    },
                    IconClose(12),
                  ),
                ),
                menuEntries.length === 0
                  ? h('div', { className: 'ps-menu-empty' }, t('menu_empty'))
                  : menuEntries.map((entry) =>
                      h(
                        'button',
                        {
                          key: entry.id,
                          type: 'button',
                          className: 'ps-menu-item',
                          role: 'menuitem',
                          title: entry.prompt,
                          onClick: () => fill(entry),
                        },
                        h('span', { className: 'ps-menu-label' }, entry.label),
                        h('span', { className: 'ps-menu-body' }, entry.prompt),
                      ),
                    ),
              )
            : null,
          )
          : null,
        filling
          ? h(VariableDialog, {
              entry: filling.entry,
              variables: filling.vars,
              t,
              onFill: (text) => {
                inputActions.setDraft(text);
                if (typeof inputActions.focus === 'function') inputActions.focus();
                setFilling(null);
              },
              onClose: () => setFilling(null),
            })
          : null,
      );
    }

    /**
     * Hero-page seat: the same shortcuts, as many chips as fit right of the
     * mode (agent preset) selector plus a 更多 menu for the rest. The shell
     * renders this seat only on the blank-session (New Session) row and only
     * with a session, so no phase detection is needed here. With nothing
     * pinned the seat renders nothing, keeping the hero clean.
     * @param props - the slot supplies the current session's input actions.
     */
    function HeroOptions(props) {
      const store = props.store;
      const list = useSnapshot(store);
      const [moreOpen, setMoreOpen] = React.useState(false);
      const [filling, setFilling] = React.useState(null);
      const inputActions = props.inputActions;
      const lang = useSnapshot(props.localeStore);
      const t = makeT(lang);

      const containerRef = React.useRef(null);
      const moreRef = React.useRef(null);
      const menuRef = React.useRef(null);

      // This seat only renders on the New Session (hero) page, so entries
      // scoped to active sessions stay hidden here; 'both' and 'hero' show.
      const visible = list.filter((entry) => {
        const scope = placementOf(entry);
        return entry.enabled && (scope === 'both' || scope === 'hero');
      });
      // Display copies under the active UI language.
      const view = visible.map((entry) => localize(entry, lang));

      /** Width budget for the hero seat: capped so it never squeezes the mode selector. */
      const budget = () => Math.min(window.innerWidth * 0.44, 420);

      const [fitted, setFitted] = React.useState(0);

      React.useLayoutEffect(() => {
        const container = containerRef.current;
        if (!container) return undefined;

        const measure = () => {
          const gap = 6;
          const probe = container.querySelector('[data-ps-probe]');
          const widths = probe ? [...probe.children].map((el) => el.getBoundingClientRect().width) : [];
          const moreW = moreRef.current ? moreRef.current.getBoundingClientRect().width + gap : 0;

          // Conservative pass: assume 更多 keeps its space, fit as many as hold.
          let used = 0;
          let count = 0;
          for (const w of widths) {
            const next = used + w + (count > 0 ? gap : 0);
            if (next + moreW > budget()) break;
            used = next;
            count += 1;
          }
          if (count === widths.length && widths.length > 0) {
            // Everything fit with 更多's space reserved — recompute without it.
            used = 0;
            count = 0;
            for (const w of widths) {
              const next = used + w + (count > 0 ? gap : 0);
              if (next > budget()) break;
              used = next;
              count += 1;
            }
          }
          if (count === 0 && widths.length > 0) count = 1;
          setFitted((prev) => (prev === count ? prev : count));
        };

        measure();
        const onResize = () => measure();
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
      }, [view.map((e) => `${e.id}:${e.label}`).join('|'), fitted]);

      if (visible.length === 0 || !inputActions) return null;

      const shown = view.slice(0, fitted);
      const overflow = view.slice(fitted);

      /** Fill the composer from one shortcut (variable dialog when needed). */
      const fill = (entry) => {
        activateEntry(entry, inputActions, (entry2, vars) => setFilling({ entry: entry2, vars }));
        setMoreOpen(false);
      };

      const chipFor = (entry, extra) =>
        h(
          'button',
          {
            key: entry.id,
            type: 'button',
            className: 'ps-chip',
            title: entry.prompt,
            onClick: () => fill(entry),
            ...extra,
          },
          h('span', { className: 'ps-chip-label' }, entry.label),
        );

      // Close the popover on an outside click or Escape, the way a menu should.
      React.useEffect(() => {
        if (!moreOpen) return undefined;
        const onDown = (event) => {
          if (menuRef.current?.contains(event.target)) return;
          if (moreRef.current?.contains(event.target)) return;
          setMoreOpen(false);
        };
        const onKey = (event) => {
          if (event.key === 'Escape') setMoreOpen(false);
        };
        document.addEventListener('mousedown', onDown, true);
        document.addEventListener('keydown', onKey, true);
        return () => {
          document.removeEventListener('mousedown', onDown, true);
          document.removeEventListener('keydown', onKey, true);
        };
      }, [moreOpen]);

      return h(
        'div',
        { className: 'ps-hero', ref: containerRef },
        shown.map((entry) => chipFor(entry)),
        h(
          'div',
          { className: 'ps-probe', 'data-ps-probe': '', 'aria-hidden': 'true' },
          view.map((entry) => chipFor(entry, { tabIndex: -1 })),
        ),
        overflow.length > 0
          ? h(
              'button',
              {
                type: 'button',
                ref: moreRef,
                className: 'ps-gear',
                title: t('more_title', { n: overflow.length }),
                'aria-haspopup': 'menu',
                'aria-expanded': moreOpen,
                onClick: () => setMoreOpen((v) => !v),
              },
              IconMore(14),
              t('more'),
              h('span', { className: 'ps-count' }, String(overflow.length)),
            )
          : null,
        moreOpen
          ? h(
              'div',
              { className: 'ps-menu', ref: menuRef, role: 'menu' },
              h(
                'div',
                { className: 'ps-menu-head' },
                h('span', { className: 'ps-menu-title' }, t('menu_title')),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'ps-menu-close',
                    title: t('close'),
                    'aria-label': t('close'),
                    onClick: () => setMoreOpen(false),
                  },
                  IconClose(12),
                ),
              ),
              overflow.map((entry) =>
                h(
                  'button',
                  {
                    key: entry.id,
                    type: 'button',
                    className: 'ps-menu-item',
                    role: 'menuitem',
                    title: entry.prompt,
                    onClick: () => fill(entry),
                  },
                  h('span', { className: 'ps-menu-label' }, entry.label),
                  h('span', { className: 'ps-menu-body' }, entry.prompt),
                ),
              ),
            )
          : null,
        filling
          ? h(VariableDialog, {
              entry: filling.entry,
              variables: filling.vars,
              t,
              onFill: (text) => {
                inputActions.setDraft(text);
                if (typeof inputActions.focus === 'function') inputActions.focus();
                setFilling(null);
              },
              onClose: () => setFilling(null),
            })
          : null,
      );
    }

    /**
     * The settings page (settings.section "自定义指令"): a searchable card
     * grid, with one card open for editing at a time. This is the home of the
     * management features; the composer row no longer carries a 添加指令
     * button.
     *
     * Actions per card: 编辑 opens the entry in the editor; 置顶 toggles
     * whether the entry shows as a button. Edits are held in a local draft and
     * committed on 保存, so 取消 leaves the saved list untouched. Settings is a
     * root-scoped seat without composer input actions, so a card click opens
     * the editor rather than filling the draft.
     *
     * @param props - store + save from the Host mirror, and the shell's close.
     */
    function SettingsSection(props) {
      const store = props.store;
      const saved = useSnapshot(store);
      // The page seeds its draft once on mount and owns it until 保存 or 取消.
      // Re-seeding on later store changes would discard unsaved edits, so the
      // live snapshot is deliberately not synced.
      const [draft, setDraft] = React.useState(() => saved);
      const [editingId, setEditingId] = React.useState(null);
      /*
       * Ids created by 新增 during this visit. Only these may be discarded when
       * 返回列表 abandons an incomplete entry: a pre-existing entry that the user
       * blanked out must survive, because backing out of an edit means "keep it
       * as it was", not "delete it".
       */
      const addedIds = React.useRef(new Set());
      const [query, setQuery] = React.useState('');
      const [error, setError] = React.useState('');
      // Card id whose delete button is currently showing its confirm prompt.
      const [confirmId, setConfirmId] = React.useState(null);
      // True while the Host write is in flight, so 保存 cannot double-submit.
      const [saving, setSaving] = React.useState(false);
      // Active UI language ('zh' | 'en') from the shared locale service.
      const lang = useSnapshot(props.localeStore);
      const t = makeT(lang);
      // True while the LLM translate call is in flight.
      const [translating, setTranslating] = React.useState(false);
      const [translateError, setTranslateError] = React.useState('');

      /**
       * Close the settings panel. The shell renders this section with the
       * owner prop `close` (renderSlot passes { close } to the active
       * section); guard so a missing prop can never surface as an error.
       */
      const closePanel = () => {
        if (typeof props.close === 'function') props.close();
      };

      const editing = editingId === null ? null : draft.find((entry) => entry.id === editingId) ?? null;

      /** Patch one draft entry by id. */
      const patch = (id, changes) => {
        setDraft((current) => current.map((entry) => (entry.id === id ? { ...entry, ...changes } : entry)));
      };

      /** Append a fresh entry and open it for editing immediately. */
      const add = () => {
        const entry = { id: newId(), label: '', prompt: '', enabled: true, placement: 'both', labelEn: '', promptEn: '' };
        addedIds.current.add(entry.id);
        setDraft((current) => [...current, entry]);
        setEditingId(entry.id);
        setError('');
      };

      /** Remove one entry, leaving the editor when it was the open one. */
      const remove = (id) => {
        addedIds.current.delete(id);
        setDraft((current) => current.filter((entry) => entry.id !== id));
        if (editingId === id) setEditingId(null);
      };

      /**
       * Ask the Host to translate the entry's current label/prompt into
       * English with the user's currently selected model. The result fills
       * the English fields for review — nothing is persisted until 保存, and
       * the user can edit or discard the generated text.
       */
      const generateEn = async () => {
        if (translating || editing === null) return;
        const label = (editing.label ?? '').trim();
        const prompt = editing.prompt ?? '';
        if (label === '' || prompt.trim() === '') {
          setTranslateError(t('en_need_base'));
          return;
        }
        setTranslating(true);
        setTranslateError('');
        const result = await props.translate({ label, prompt });
        setTranslating(false);
        if (!result?.ok) {
          setTranslateError(result?.error ?? t('en_failed'));
          return;
        }
        patch(editing.id, { labelEn: result.labelEn, promptEn: result.promptEn });
      };

      /**
       * Validate the draft locally, then persist it through the Host.
       *
       * Local validation gives an immediate, field-level message; the Host
       * re-validates as the single authority and its refusal is shown verbatim.
       * The page stays open on failure so nothing the user typed is lost.
       */
      const save = async () => {
        const cleaned = [];
        for (const [index, entry] of draft.entries()) {
          const label = (entry.label ?? '').trim();
          const prompt = entry.prompt ?? '';
          if (label === '') {
            setError(t('err_no_label', { n: index + 1 }));
            return;
          }
          if (prompt.trim() === '') {
            setError(t('err_no_prompt', { n: index + 1, label }));
            return;
          }
          // English variants are optional; the Host drops them when empty.
          cleaned.push({
            ...entry,
            label,
            prompt,
            labelEn: (entry.labelEn ?? '').trim().slice(0, MAX_LABEL),
            promptEn: (entry.promptEn ?? '').trim(),
          });
        }
        setError('');
        setSaving(true);
        const result = await props.save(cleaned);
        setSaving(false);
        if (!result?.ok) {
          setError(result?.error ?? t('save_failed'));
          return;
        }
        closePanel();
      };

      /**
       * Leave the editor for the list, abandoning whatever was in progress.
       *
       * Validation belongs to 保存, not to navigation: 返回列表 means "never mind
       * this one", so it must never be blocked by an empty field. An entry left
       * incomplete is discarded outright — keeping a blank card in the grid
       * would only stall the next 保存 with the same complaint.
       */
      const backToList = () => {
        const entry = draft.find((item) => item.id === editingId);
        const incomplete =
          entry !== undefined &&
          ((entry.label ?? '').trim() === '' || (entry.prompt ?? '').trim() === '');
        // Drop the entry only when this visit created it and never finished it.
        // An existing entry left half-edited simply reverts to its stored form,
        // which is what abandoning an edit is supposed to mean.
        if (incomplete && addedIds.current.has(editingId)) {
          addedIds.current.delete(editingId);
          setDraft((current) => current.filter((item) => item.id !== editingId));
        } else if (incomplete) {
          const original = saved.find((item) => item.id === editingId);
          if (original) {
            setDraft((current) => current.map((item) => (item.id === editingId ? original : item)));
          }
        }
        setError('');
        setEditingId(null);
      };

      const needle = query.trim().toLowerCase();
      const matches = needle === ''
        ? draft
        : draft.filter(
            (entry) =>
              entry.label.toLowerCase().includes(needle) || entry.prompt.toLowerCase().includes(needle),
          );

      const head = h(
        'div',
        { className: 'ps-head' },
        h('input', {
          className: 'ps-search',
          type: 'search',
          value: query,
          placeholder: t('search_placeholder'),
          'aria-label': t('search_aria'),
          onChange: (event) => setQuery(event.target.value),
        }),
        h(
          'button',
          { type: 'button', className: 'ps-icon-btn', title: t('add_title'), 'aria-label': t('add_title'), onClick: add },
          IconPlus(15),
        ),
      );

      /** Browse state: the card grid. */
      const grid = h(
        'div',
        { className: 'ps-grid ps-grid-page' },
        matches.length === 0
          ? h(
              'div',
              { className: 'ps-grid-empty' },
              draft.length === 0 ? t('grid_empty_none') : t('grid_empty_nomatch'),
            )
          : matches.map((entry) =>
              h(
                'div',
                {
                  key: entry.id,
                  className: 'ps-tile',
                  role: 'button',
                  tabIndex: 0,
                  title: t('tile_title'),
                  onClick: () => {
                    setEditingId(entry.id);
                    setError('');
                    setConfirmId(null);
                  },
                  onKeyDown: (event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      setEditingId(entry.id);
                      setError('');
                      setConfirmId(null);
                    }
                  },
                },
                h(
                  'div',
                  { className: 'ps-tile-head' },
                  h('span', { className: 'ps-tile-label' }, displayLabel(entry, lang) || t('tile_label_empty')),
                  (entry.labelEn || entry.promptEn)
                    ? h(
                        'span',
                        { className: 'ps-scope-tag ps-en-tag', title: t('en_tag_title') },
                        'EN',
                      )
                    : null,
                  placementOf(entry) !== 'both'
                    ? h(
                        'span',
                        {
                          className: 'ps-scope-tag',
                          title:
                            placementOf(entry) === 'hero'
                              ? t('scope_hero_title')
                              : t('scope_active_title'),
                        },
                        t(SCOPE_TAG_KEYS[placementOf(entry)]),
                      )
                    : null,
                ),
                h('div', { className: 'ps-tile-body' }, displayPrompt(entry, lang) || t('tile_body_empty')),
                h(
                  'div',
                  { className: 'ps-tile-foot' },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'ps-tile-act',
                      onClick: (event) => {
                        // Card actions must not also fire the card's open action.
                        event.stopPropagation();
                        setEditingId(entry.id);
                        setError('');
                        setConfirmId(null);
                      },
                    },
                    IconEdit(13),
                    t('edit'),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: `ps-tile-act${entry.enabled ? ' ps-tile-act-on' : ''}`,
                      title: entry.enabled
                        ? t('pin_title_on')
                        : t('pin_title_off'),
                      'aria-pressed': entry.enabled,
                      onClick: (event) => {
                        event.stopPropagation();
                        patch(entry.id, { enabled: !entry.enabled });
                        setConfirmId(null);
                      },
                    },
                    IconPin(13),
                    entry.enabled ? t('pin_on') : t('pin_off'),
                  ),
                  // Deletion is confirmed in place: the button becomes the
                  // confirm prompt, so one card can never be removed by a
                  // single stray click while its neighbours stay untouched.
                  confirmId === entry.id
                    ? h(
                        'span',
                        { className: 'ps-confirm' },
                        h(
                          'button',
                          {
                            type: 'button',
                            className: 'ps-tile-act ps-tile-act-danger',
                            onClick: (event) => {
                              event.stopPropagation();
                              remove(entry.id);
                              setConfirmId(null);
                            },
                          },
                          IconTrash(13),
                          t('delete_confirm'),
                        ),
                        h(
                          'button',
                          {
                            type: 'button',
                            className: 'ps-tile-act',
                            onClick: (event) => {
                              event.stopPropagation();
                              setConfirmId(null);
                            },
                          },
                          t('cancel'),
                        ),
                      )
                    : h(
                        'button',
                        {
                          type: 'button',
                          className: 'ps-tile-act ps-tile-act-danger',
                          onClick: (event) => {
                            event.stopPropagation();
                            setConfirmId(entry.id);
                          },
                        },
                        IconTrash(13),
                        t('delete'),
                      ),
                ),
              ),
            ),
      );

      /** Edit state: one entry's fields plus its own actions. */
      const editingVars = editing ? extractVars(editing.prompt) : [];
      const editor = editing
        ? h(
            'div',
            { className: 'ps-editor' },
            h(
              'div',
              { className: 'ps-field' },
              h('label', { className: 'ps-field-label', htmlFor: 'ps-edit-label' }, t('field_label')),
              h('input', {
                id: 'ps-edit-label',
                className: 'ps-input',
                value: editing.label,
                maxLength: MAX_LABEL,
                placeholder: t('field_label_ph'),
                onChange: (event) => patch(editing.id, { label: event.target.value }),
              }),
            ),
            h(
              'div',
              { className: 'ps-field' },
              h('label', { className: 'ps-field-label', htmlFor: 'ps-edit-prompt' }, t('field_prompt')),
              h('textarea', {
                id: 'ps-edit-prompt',
                className: 'ps-area',
                value: editing.prompt,
                placeholder: t('field_prompt_ph'),
                onChange: (event) => patch(editing.id, { prompt: event.target.value }),
              }),
              editingVars.length > 0
                ? h(
                    'div',
                    { className: 'ps-vars-hint' },
                    t('vars_hint'),
                    editingVars.map((name) => h('span', { key: name, className: 'ps-var-chip' }, `{{${name}}}`)),
                  )
                : null,
            ),
            h(
              'div',
              { className: 'ps-field' },
              h('span', { className: 'ps-field-label' }, t('scope_field')),
              h(
                'div',
                { className: 'ps-seg', role: 'group', 'aria-label': t('scope_aria') },
                SCOPE_OPTIONS.map((option) =>
                  h(
                    'button',
                    {
                      key: option.value,
                      type: 'button',
                      className: `ps-seg-item${placementOf(editing) === option.value ? ' ps-seg-on' : ''}`,
                      'aria-pressed': placementOf(editing) === option.value,
                      onClick: () => patch(editing.id, { placement: option.value }),
                    },
                    t(option.key),
                  ),
                ),
              ),
            ),
            h(
              'div',
              { className: 'ps-field ps-en-field' },
              h('span', { className: 'ps-field-label' }, t('en_section')),
              h('input', {
                className: 'ps-input',
                value: editing.labelEn ?? '',
                maxLength: MAX_LABEL,
                placeholder: t('en_label_ph'),
                'aria-label': t('en_label_aria'),
                onChange: (event) => patch(editing.id, { labelEn: event.target.value }),
              }),
              h('textarea', {
                className: 'ps-area',
                value: editing.promptEn ?? '',
                placeholder: t('en_prompt_ph'),
                'aria-label': t('en_prompt_aria'),
                onChange: (event) => patch(editing.id, { promptEn: event.target.value }),
              }),
              h(
                'div',
                { className: 'ps-en-actions' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'ps-btn ps-btn-sm',
                    disabled: translating,
                    onClick: generateEn,
                  },
                  translating ? t('en_generating') : t('en_generate'),
                ),
                translateError !== ''
                  ? h('span', { className: 'ps-en-error', role: 'alert' }, translateError)
                  : null,
              ),
            ),
            h(
              'label',
              { className: 'ps-check', title: t('pin_check_title') },
              h('input', {
                type: 'checkbox',
                checked: editing.enabled,
                onChange: (event) => patch(editing.id, { enabled: event.target.checked }),
              }),
              t('pin_check'),
            ),
          )
        : null;

      return h(
        'div',
        {
          className: 'ps-settings',
          onKeyDown: (event) => {
            if (event.key !== 'Escape') return;
            // Escape steps back out of the editor first; the shell owns
            // closing the panel itself.
            if (editingId !== null) backToList();
          },
        },
        h(
          'div',
          { className: 'ps-head-row' },
          h(
            'div',
            { className: 'ps-head-text' },
            h('h2', { className: 'ps-title' }, editing ? t('settings_title_edit') : t('settings_title')),
            h(
              'p',
              { className: 'ps-hint' },
              editing
                ? t('settings_hint_edit')
                : t('settings_hint_browse'),
            ),
          ),
        ),
        editing ? null : head,
        error ? h('div', { className: 'ps-error', role: 'alert' }, error) : null,
        editing ? editor : grid,
        h(
          'div',
          { className: 'ps-foot' },
          h('span', { className: 'ps-grow' }),
          // 返回列表 backs out of the editor first; only from the grid does
          // the same control discard the draft and close the page.
          h(
            'button',
            {
              type: 'button',
              className: 'ps-btn',
              onClick: () => {
                if (editingId !== null) backToList();
                else closePanel();
              },
            },
            editing ? t('back') : t('cancel'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'ps-btn ps-btn-primary',
              disabled: saving,
              onClick: () => {
                save().catch((error) => setError(String(error?.message ?? error)));
              },
            },
            saving ? t('saving') : t('save'),
          ),
        ),
      );
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        /**
         * Call this package's Host half over its own HTTP route.
         *
         * A plain fetch is used instead of Connection RPC: the plugin owns one
         * fixed path, so the transport stays verifiable (curl can hit exactly
         * the URL the browser hits) and needs no service handshake.
         *
         * @param action - Host action name.
         * @param payload - action payload.
         * @returns the Host's `{ ok, ... }` answer, or a failure result.
         */
        const call = async (action, payload) => {
          try {
            const response = await fetch(ROUTE_PATH, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ action, ...(payload ?? {}) }),
              cache: 'no-store',
            });
            if (!response.ok) {
              return { ok: false, error: makeT(localeStore.getSnapshot())('http_error', { code: response.status }) };
            }
            return await response.json();
          } catch (error) {
            return { ok: false, error: String(error?.message ?? error) };
          }
        };

        const handle = createStore(call);

        // Seed the store on activation; a failure leaves the row empty and
        // surfaces through the page rather than throwing during apply.
        ctx.effect(() => {
          handle.refresh().catch(() => {});
        });

        // Track the active UI language from the shared locale service (with a
        // <html lang> fallback). Entries that carry an English variant
        // display it while the interface language is English.
        const localeStore = createSnapshotStore('zh');
        const applyLang = (value) =>
          localeStore.set(String(value ?? '').toLowerCase().startsWith('zh') ? 'zh' : 'en');
        if (
          ctx.locale &&
          typeof ctx.locale.getSnapshot === 'function' &&
          typeof ctx.locale.subscribe === 'function'
        ) {
          const face = ctx.locale;
          const syncLocale = () => applyLang(face.getSnapshot()?.active);
          syncLocale();
          ctx.effect(() => face.subscribe(syncLocale), 'prompt-shortcuts: UI language tracking');
        } else {
          const root = document.documentElement;
          const syncLang = () => applyLang(root.lang);
          syncLang();
          const langObserver = new MutationObserver(syncLang);
          langObserver.observe(root, { attributes: true, attributeFilter: ['lang'] });
          ctx.effect(() => () => langObserver.disconnect(), 'prompt-shortcuts: html lang fallback');
        }

        /*
         * Seat 1: the full-width row above the composer card, active sessions
         * only. The Hero (New Session) page hides it via the shell's
         * data-phase; management lives in the settings page, so the row no
         * longer carries a 添加指令 button.
         */
        ctx.effect(() => ctx.slots.inject('conversation.input.dock', () =>
          ctx.slots.register(
            { name: 'conversation.input.dock', id: 'prompt-shortcuts', order: 20, label: () => makeT(localeStore.getSnapshot())('dock_label') },
            (props) => h(ShortcutRow, { ...props, store: handle.store, localeStore }),
          ),
        ));

        /*
         * Seat 2: the New Session (hero) row, right of the workspace and mode
         * selectors. As many chips as fit the budget plus a 更多 menu; renders
         * nothing while nothing is pinned.
         */
        ctx.effect(() => ctx.slots.inject('conversation.hero.options', () =>
          ctx.slots.register(
            { name: 'conversation.hero.options', id: 'prompt-shortcuts', order: 20, label: () => makeT(localeStore.getSnapshot())('dock_label') },
            (props) => h(HeroOptions, { ...props, store: handle.store, localeStore }),
          ),
        ));

        /*
         * Seat 3: the settings page. First-class nav entry (自定义指令 /
         * Prompt shortcuts, between the agent presets and the other profile
         * plugins); the shell renders it inside the content column, which
         * owns the padding and the scroll. The nav label follows the UI
         * language, so the registration is re-issued on every language
         * change.
         */
        ctx.effect(() => {
          let unregister;
          const register = () => {
            const t = makeT(localeStore.getSnapshot());
            if (unregister) unregister();
            unregister = ctx.slots.inject('settings.section', () =>
              ctx.slots.register(
                { name: 'settings.section', id: 'prompt-shortcuts', order: 30, label: t('settings_title') },
                (props) => h(SettingsSection, { ...props, store: handle.store, save: handle.save, translate: handle.translate, localeStore }),
              ),
            );
          };
          register();
          const unsubscribe = localeStore.subscribe(register);
          return () => {
            unsubscribe();
            if (unregister) unregister();
          };
        }, 'prompt-shortcuts: settings section (label follows the UI language)');

        // The sheets and chips are styled with theme tokens; the style tag
        // lives with the plugin run.
        ctx.effect(() => {
          const style = document.createElement('style');
          style.textContent = CSS;
          document.head.appendChild(style);
          return () => style.remove();
        });
      },
    };
  },
});
