import { FileSystemAdapter, htmlToMarkdown } from 'obsidian';
import { shellPath } from 'shell-path';
import { PartialCSLEntry } from './bib/types';

export function getVaultRoot() {
  // This is a desktop only plugin, so assume adapter is FileSystemAdapter
  return (app.vault.adapter as FileSystemAdapter).getBasePath();
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

export function debugLog(module: string, message: string, data?: any) {
  const timestamp = new Date().toISOString();
  const logMessage = `[BibShower][${timestamp}][${module}] ${message}`;
  if (data) {
    console.log(logMessage, data);
  } else {
    console.log(logMessage);
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
