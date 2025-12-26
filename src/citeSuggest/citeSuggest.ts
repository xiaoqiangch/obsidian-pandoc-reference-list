import Fuse from 'fuse.js';
import {
  App,
  Editor,
  EditorPosition,
  EditorSuggest,
  EditorSuggestContext,
  EditorSuggestTriggerInfo,
  MarkdownView,
  Platform,
} from 'obsidian';
import { PartialCSLEntry } from 'src/bib/types';
import ReferenceList from 'src/main';

interface Loading {
  loading: boolean;
}

const triggerRE = /(^|[ \t\v[\-\r\n;])([\[【]?@)([\p{L}\p{N}:.#$%&\-+?<>~_/]*)$/u;

export class CiteSuggest extends EditorSuggest<
  Fuse.FuseResult<PartialCSLEntry> | Loading
> {
  private plugin: ReferenceList;
  private app: App;

  limit: number = 20;

  constructor(app: App, plugin: ReferenceList) {
    super(app);

    this.app = app;
    this.plugin = plugin;

    (this as any).suggestEl.addClass('pwc-suggest');
    (this as any).scope.register(['Mod'], 'Enter', (evt: KeyboardEvent) => {
      (this as any).suggestions.useSelectedItem(evt);
      return false;
    });

    (this as any).scope.register(['Alt'], 'Enter', (evt: KeyboardEvent) => {
      (this as any).suggestions.useSelectedItem(evt);
      return false;
    });

    this.setInstructions([
      {
        command: Platform.isMacOS ? '⌘ ↵' : 'ctrl ↵',
        purpose: 'Wrap cite key with brackets',
      },
      {
        command: Platform.isMacOS ? '⌥ ↵' : 'alt ↵',
        purpose: 'Insert using template',
      },
    ]);
  }

  getSuggestions(context: EditorSuggestContext) {
    console.log('CiteSuggest: getSuggestions called', context.query);
    if (
      context.query === undefined ||
      context.query.includes(' ')
    ) {
      console.log('CiteSuggest: query is undefined or contains space');
      return null;
    }

    const { plugin } = this;
    if (!plugin.initPromise.settled) {
      console.log('CiteSuggest: plugin not settled');
      return null;
    }

    const { bibManager } = plugin;

    let fuse = bibManager.fuse;
    if (bibManager.fileCache.has(context.file)) {
      const cache = bibManager.fileCache.get(context.file);
      fuse = cache.source.fuse;
      console.log('CiteSuggest: using file-specific fuse');
    } else {
      console.log('CiteSuggest: using global fuse');
    }

    if (!fuse) {
      console.log('CiteSuggest: no fuse instance found');
      return null;
    }

    if (context.query.length === 0) {
      console.log('CiteSuggest: empty query, returning default suggestions');
      // Return some default suggestions if query is empty
      let entries: PartialCSLEntry[] = [];
      if (bibManager.fileCache.has(context.file)) {
        const cache = bibManager.fileCache.get(context.file);
        entries = Array.from(cache.source.bibCache.values());
      } else {
        entries = Array.from(bibManager.bibCache.values());
      }

      console.log(`CiteSuggest: found ${entries.length} entries`);
      return entries.slice(0, this.limit).map((item, index) => ({
        item,
        refIndex: index,
      }));
    }

    const results = fuse.search(context.query, {
      limit: this.limit,
    });

    console.log(`CiteSuggest: search results count: ${results?.length || 0}`);
    return results?.length ? results : null;
  }

  renderSuggestion(
    suggestion: Fuse.FuseResult<PartialCSLEntry> | Loading,
    el: HTMLElement
  ): void {
    console.log('CiteSuggest: rendering suggestion', suggestion);
    const frag = createFragment();

    if ((suggestion as { loading: boolean }).loading) {
      frag
        .createSpan({ cls: 'pwc-suggest-loading-wrapper' })
        .createSpan({ cls: 'pwc-suggest-loading' });
      el.setText(frag);
      return;
    }

    const sugg = suggestion as Fuse.FuseResult<PartialCSLEntry>;
    const item = sugg.item;

    if (!sugg.matches || !sugg.matches.length) {
      frag.createSpan({ text: `@${item.id}` });
      if (item.title)
        frag.createSpan({ text: item.title, cls: 'pwc-suggest-title' });
      return el.setText(frag);
    }

    const citekey = frag.createSpan({ text: '@' });
    const title = frag.createSpan('pwc-suggest-title');

    let prevTitleIndex = 0;
    let prevCiteIndex = 0;

    sugg.matches.forEach((m) => {
      m.indices.forEach((indices) => {
        const start = indices[0];
        const stop = indices[1] + 1;

        const target = m.key === 'title' ? title : citekey;
        const prev = m.key === 'title' ? prevTitleIndex : prevCiteIndex;

        target.appendText(m.value.substring(prev, start));
        target.append(
          createEl('strong', {
            text: m.value.substring(start, stop),
          })
        );

        if (m.key === 'title') {
          prevTitleIndex = stop;
        } else {
          prevCiteIndex = stop;
        }
      });
    });

    if (item.title) title.appendText(item.title.substring(prevTitleIndex));
    citekey.appendText(item.id.substring(prevCiteIndex));

    el.setText(frag);
  }

  lastSelect: EditorPosition = null;
  selectSuggestion(
    suggestion: Fuse.FuseResult<PartialCSLEntry>,
    event: KeyboardEvent | MouseEvent
  ): void {
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!activeView) {
      return;
    }

    const { start, end } = this.context;
    const line = activeView.editor.getLine(start.line);
    const trigger = line.substring(start.ch, end.ch - this.context.query.length);

    // Check if there's a closing bracket after the cursor to avoid duplicates
    const nextChar = line.substring(end.ch, end.ch + 1);
    const hasClosingBracket = nextChar === ']';

    let replaceStr = '';
    let actualEnd = end;

    if (trigger.startsWith('[') || trigger.startsWith('【')) {
      // Replace both [ and 【 with [
      replaceStr = `[@${suggestion.item.id}]`;
      if (hasClosingBracket) {
        // If there's already a closing bracket, include it in the replacement range
        actualEnd = { ...end, ch: end.ch + 1 };
      }
    } else if (event.metaKey || event.ctrlKey) {
      replaceStr = `[@${suggestion.item.id}]`;
    } else {
      replaceStr = `@${suggestion.item.id}`;
    }

    activeView.editor.replaceRange(replaceStr, start, actualEnd);

    this.lastSelect = {
      ch: start.ch + replaceStr.length,
      line: start.line,
    };
    this.close();
  }

  isRefreshing: boolean = false;
  async refreshZBib() {
    if (this.isRefreshing) return;
    this.isRefreshing = true;
    await this.plugin.bibManager.refreshGlobalZBib();
    this.isRefreshing = false;
  }

  onTrigger(cursor: EditorPosition, editor: Editor): EditorSuggestTriggerInfo {
    const { enableCiteKeyCompletion, pullFromZotero } = this.plugin.settings;
    if (!enableCiteKeyCompletion) {
      return null;
    }

    const { lastSelect } = this;
    if (
      lastSelect &&
      cursor.ch === lastSelect.ch &&
      cursor.line === lastSelect.line
    ) {
      return null;
    }

    const line = (editor.getLine(cursor.line) || '').substring(0, cursor.ch);
    const match = line.match(triggerRE);

    if (!match) {
      return null;
    }
    console.log('CiteSuggest: onTrigger matched', match[0]);
    this.lastSelect = null;

    if (!this.context && pullFromZotero) {
      this.refreshZBib();
    }

    const triggerIndex = match.index + match[1].length;
    const startPos = {
      line: cursor.line,
      ch: triggerIndex,
    };

    console.log('CiteSuggest: trigger query', match[3]);
    return {
      start: startPos,
      end: cursor,
      query: match[3],
    };
  }
}
