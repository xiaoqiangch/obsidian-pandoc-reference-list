import { FileSystemAdapter, htmlToMarkdown } from 'obsidian';
import { shellPath } from 'shell-path';
import { PartialCSLEntry } from './bib/types';

const os = require('os');
const path = require('path');
const { createHash } = require('crypto');

export function getVaultRoot() {
  // This is a desktop only plugin, so assume adapter is FileSystemAdapter.
  // The global `app` is provided by Obsidian's runtime; guard the cast so a
  // missing / differently-shaped adapter fails loudly instead of returning an
  // undefined base path that silently corrupts cache locations.
  const adapter = (app.vault?.adapter as FileSystemAdapter) ?? null;
  const base = adapter?.getBasePath();
  if (!base) {
    throw new Error('getVaultRoot: Obsidian vault adapter is unavailable.');
  }
  return base;
}

/**
 * Vault-external cache root (~/.bib-manager-index/<vaultHash>). Indexes and
 * conversion state live here instead of inside the vault so iCloud sync can
 * never evict, truncate, or race them (which previously caused repeated
 * full rebuilds on every restart).
 */
/**
 * True when an API URL points at a loopback / local-machine address (localhost,
 * 127.0.0.1, ::1, 0.0.0.0, or a .local/.lan host). Local Docker services
 * (e.g. jina-embeddings / jina-reranker) are served this way and usually need
 * no API key.
 */
export function isLocalApiUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host === '0.0.0.0' ||
      host.endsWith('.local') ||
      host.endsWith('.lan')
    );
  } catch {
    return false;
  }
}

export function getCacheRoot(): string {
  const vaultRoot = getVaultRoot();
  const hash = createHash('md5').update(vaultRoot).digest('hex').slice(0, 12);
  return path.join(os.homedir(), '.bib-manager-index', hash);
}

export function copyElToClipboard(el: HTMLElement) {
  require('electron').clipboard.write({
    html: el.outerHTML,
    text: htmlToMarkdown(el.outerHTML),
  });
}

export class PromiseCapability<T> {
  settled = false;
  promise: Promise<T>;
  resolve: (data: T) => void;
  reject: (reason?: any) => void;

  constructor() {
    this.promise = new Promise((resolve, reject) => {
      this.resolve = (data) => {
        resolve(data);
        this.settled = true;
      };

      this.reject = (reason) => {
        reject(reason);
        this.settled = true;
      };
    });
  }
}

export async function fixPath() {
  if (process.platform === 'win32') {
    return;
  }

  try {
    const path = await shellPath();

    process.env.PATH =
      path ||
      [
        './node_modules/.bin',
        '/.nodebrew/current/bin',
        '/usr/local/bin',
        process.env.PATH,
      ].join(':');
  } catch (e) {
    console.error(e);
  }
}

export function areSetsEqual<T>(as: Set<T>, bs: Set<T>) {
  if (as.size !== bs.size) return false;
  for (const a of as) if (!bs.has(a)) return false;
  return true;
}

export function debounce<T extends (...args: any[]) => any>(
  func: T,
  wait: number
): (...args: Parameters<T>) => void {
  let timeout: NodeJS.Timeout | null = null;
  return function (...args: Parameters<T>) {
    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(() => func(...args), wait);
  };
}

export async function openPdfInPreview(filePath: string) {
  if (process.platform !== 'darwin') {
    return;
  }

  const { exec } = require('child_process');
  
  // AppleScript to open file in Preview, set to full screen and two pages mode
  const script = `
    tell application "Preview"
      activate
      open POSIX file "${filePath}"
      delay 0.5
      tell application "System Events"
        tell process "Preview"
          -- Two Pages mode (Cmd+3)
          keystroke "3" using {command down}
          delay 0.2
          -- Full Screen (Ctrl+Cmd+F)
          keystroke "f" using {command down, control down}
        end tell
      end tell
    end tell
  `;

  exec(`osascript -e '${script.replace(/'/g, "'\\''")}'`, (error: any) => {
    if (error) {
      console.error('Failed to open PDF in Preview with AppleScript:', error);
      // Fallback: just open the file
      require('electron').shell.openPath(filePath);
    }
  });
}

export async function openEpubInDefaultReader(filePath: string) {
  require('electron').shell.openPath(filePath);
}

const BIB_DEBUG_ENABLED = false;

export function debugLog(module: string, message: string, data?: any) {
  const timestamp = new Date().toISOString();
  // Record to a global array for inspection if needed. Bound the array so a
  // long-running session never leaks unbounded memory.
  if (!(window as any).BIB_DEBUG_LOGS) (window as any).BIB_DEBUG_LOGS = [];
  (window as any).BIB_DEBUG_LOGS.push({ timestamp, module, message, data });
  const logs = (window as any).BIB_DEBUG_LOGS;
  if (logs.length > 500) logs.splice(0, logs.length - 500);
  // Only write to the console when debugging is explicitly enabled.
  if (BIB_DEBUG_ENABLED) {
    const logMessage = `[BibShower][${timestamp}][${module}] ${message}`;
    if (data) {
      console.log(logMessage, data);
    } else {
      console.log(logMessage);
    }
  }
}

export function showDetailedTooltip(entry: PartialCSLEntry, el: HTMLElement) {
  const existing = document.querySelector('.pwc-detailed-tooltip');
  if (existing) existing.remove();

  const tooltip = document.body.createDiv({ cls: 'pwc-detailed-tooltip' });
  const rect = el.getBoundingClientRect();

  tooltip.style.left = `${Math.max(10, rect.left - 300)}px`;
  tooltip.style.top = `${rect.bottom + 5}px`;

  const content = tooltip.createDiv({ cls: 'pwc-detailed-tooltip-content' });
  content.createEl('h4', { text: entry.id });

  const table = content.createEl('table');
  for (const [key, value] of Object.entries(entry)) {
    if (value && typeof value !== 'object' && key !== 'id') {
      const row = table.createEl('tr');
      row.createEl('td', { text: key, cls: 'pwc-tooltip-key' });
      row.createEl('td', { text: value.toString(), cls: 'pwc-tooltip-value' });
    } else if (key === 'author' && Array.isArray(value)) {
      const row = table.createEl('tr');
      row.createEl('td', { text: key, cls: 'pwc-tooltip-key' });
      row.createEl('td', {
        text: value.map((a: any) => `${a.family}, ${a.given}`).join('; '),
        cls: 'pwc-tooltip-value',
      });
    }
  }

  const hideTooltip = (e: MouseEvent) => {
    if (!tooltip.contains(e.target as Node) && !el.contains(e.target as Node)) {
      tooltip.remove();
      document.removeEventListener('mousedown', hideTooltip);
    }
  };

  document.addEventListener('mousedown', hideTooltip);
}
