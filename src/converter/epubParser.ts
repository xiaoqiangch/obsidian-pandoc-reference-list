import { debugLog } from '../helpers';

const fs = require('fs');
const path = require('path');

export interface EpubChapter {
  title: string;
  html: string;
  images: { name: string; data: Buffer }[];
}

export async function parseEpub(epubPath: string): Promise<{
  chapters: EpubChapter[];
  images: { name: string; data: Buffer }[];
}> {
  debugLog('EpubParser', 'parseEpub started', { epubPath });

  const AdmZip = require('adm-zip');
  const zip = new AdmZip(epubPath);
  const entries = zip.getEntries();

  const allImages: { name: string; data: Buffer }[] = [];
  const htmlEntries: { name: string; content: string }[] = [];
  let opfContent: string | null = null;
  let opfPath: string = '';

  for (const entry of entries) {
    const entryName = entry.entryName;
    if (entryName.endsWith('.opf')) {
      opfContent = entry.getData().toString('utf-8');
      opfPath = entryName;
    } else if (entryName.endsWith('.html') || entryName.endsWith('.xhtml') || entryName.endsWith('.htm')) {
      htmlEntries.push({
        name: entryName,
        content: entry.getData().toString('utf-8'),
      });
    } else if (isImageFile(entryName)) {
      const imgName = path.basename(entryName);
      allImages.push({
        name: imgName,
        data: entry.getData(),
      });
    }
  }

  let spineOrder: string[] = [];
  let manifestMap: { [id: string]: string } = {};

  if (opfContent) {
    const { spine, manifest } = parseOpf(opfContent);
    spineOrder = spine;
    manifestMap = manifest;
  }

  const chapters: EpubChapter[] = [];
  const opfDir = opfPath ? path.dirname(opfPath) : '';

  if (spineOrder.length > 0) {
    for (const itemId of spineOrder) {
      const href = manifestMap[itemId];
      if (!href) continue;

      const resolvedName = opfDir ? path.join(opfDir, href) : href;
      const entry = htmlEntries.find(
        (e) => e.name === resolvedName || e.name === href || e.name.endsWith(href)
      );
      if (entry) {
        const title = extractTitleFromHtml(entry.content);
        chapters.push({
          title: title || `Chapter ${chapters.length + 1}`,
          html: entry.content,
          images: [],
        });
      }
    }
  }

  if (chapters.length === 0) {
    for (const entry of htmlEntries) {
      const title = extractTitleFromHtml(entry.content);
      chapters.push({
        title: title || `Chapter ${chapters.length + 1}`,
        html: entry.content,
        images: [],
      });
    }
  }

  debugLog('EpubParser', 'parseEpub finished', {
    chapters: chapters.length,
    images: allImages.length,
  });

  return { chapters, images: allImages };
}

export function htmlToMarkdown(html: string): string {
  let md = html;

  md = md.replace(/<!DOCTYPE[^>]*>/gi, '');
  md = md.replace(/<\?xml[^>]*\?>/gi, '');
  md = md.replace(/<html[^>]*>/gi, '');
  md = md.replace(/<\/html>/gi, '');
  md = md.replace(/<head[^>]*>[\s\S]*?<\/head>/gi, '');
  md = md.replace(/<body[^>]*>/gi, '');
  md = md.replace(/<\/body>/gi, '');

  md = md.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n# $1\n');
  md = md.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n## $1\n');
  md = md.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n### $1\n');
  md = md.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, '\n#### $1\n');
  md = md.replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, '\n##### $1\n');
  md = md.replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, '\n###### $1\n');

  md = md.replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, '**$1**');
  md = md.replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, '**$1**');
  md = md.replace(/<i[^>]*>([\s\S]*?)<\/i>/gi, '*$1*');
  md = md.replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, '*$1*');

  md = md.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)');

  md = md.replace(/<img[^>]*src="([^"]*)"[^>]*\/?>/gi, '![]($1)');
  md = md.replace(/<img[^>]*src='([^']*)'[^>]*\/?>/gi, '![]($1)');

  md = md.replace(/<p[^>]*>/gi, '\n');
  md = md.replace(/<\/p>/gi, '\n');
  md = md.replace(/<br\s*\/?>/gi, '\n');
  md = md.replace(/<div[^>]*>/gi, '\n');
  md = md.replace(/<\/div>/gi, '\n');

  md = md.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '- $1\n');
  md = md.replace(/<ul[^>]*>/gi, '\n');
  md = md.replace(/<\/ul>/gi, '\n');
  md = md.replace(/<ol[^>]*>/gi, '\n');
  md = md.replace(/<\/ol>/gi, '\n');

  md = md.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, '\n> $1\n');

  md = md.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`');
  md = md.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, '\n```\n$1\n```\n');

  md = md.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
  md = md.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  md = md.replace(/<[^>]+>/g, '');

  const entities: { [key: string]: string } = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&apos;': "'",
    '&nbsp;': ' ',
    '&#160;': ' ',
    '&ldquo;': '"',
    '&rdquo;': '"',
    '&lsquo;': "'",
    '&rsquo;': "'",
    '&mdash;': '—',
    '&ndash;': '–',
    '&hellip;': '…',
  };
  for (const [entity, char] of Object.entries(entities)) {
    md = md.replace(new RegExp(entity, 'g'), char);
  }
  md = md.replace(/&#(\d+);/g, (_, num) => String.fromCharCode(parseInt(num)));
  md = md.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));

  md = md.replace(/\n{3,}/g, '\n\n');
  md = md.replace(/[ \t]+$/gm, '');
  md = md.trim();

  return md;
}

function isImageFile(name: string): boolean {
  const ext = name.toLowerCase();
  return (
    ext.endsWith('.png') ||
    ext.endsWith('.jpg') ||
    ext.endsWith('.jpeg') ||
    ext.endsWith('.gif') ||
    ext.endsWith('.svg') ||
    ext.endsWith('.bmp') ||
    ext.endsWith('.webp')
  );
}

function parseOpf(opfContent: string): { spine: string[]; manifest: { [id: string]: string } } {
  const manifest: { [id: string]: string } = {};
  const spine: string[] = [];

  const itemRegex = /<item[^>]*id="([^"]*)"[^>]*href="([^"]*)"[^>]*>/gi;
  let match;
  while ((match = itemRegex.exec(opfContent)) !== null) {
    manifest[match[1]] = match[2];
  }

  const itemrefRegex = /<itemref[^>]*idref="([^"]*)"[^>]*>/gi;
  while ((match = itemrefRegex.exec(opfContent)) !== null) {
    spine.push(match[1]);
  }

  return { spine, manifest };
}

function extractTitleFromHtml(html: string): string {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch) return titleMatch[1].trim();

  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1Match) return h1Match[1].trim();

  return '';
}
