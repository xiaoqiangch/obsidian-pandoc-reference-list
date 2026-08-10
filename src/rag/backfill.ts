import { readMineruContentList } from '../converter/mineruConverter';
import { writeLayoutFile } from './layout';
import { ragLog } from './log';

const fs = require('fs');
const path = require('path');

/**
 * Backfill layout.json for documents that were converted before layout output
 * existed, by re-parsing the preserved MinerU result zip
 * (literature/images/<citekey>/<dataId>-mineru-result.zip).
 */
export function backfillLiteratureLayouts(vaultRoot: string, outputPath: string): number {
  const imagesRoot = path.join(vaultRoot, outputPath, 'images');
  if (!fs.existsSync(imagesRoot)) return 0;

  let backfilled = 0;
  for (const citekey of fs.readdirSync(imagesRoot)) {
    const imagesDir = path.join(imagesRoot, citekey);
    if (!fs.statSync(imagesDir).isDirectory()) continue;
    if (fs.existsSync(path.join(imagesDir, 'layout.json'))) continue;

    let zipPath: string | null = null;
    try {
      for (const name of fs.readdirSync(imagesDir)) {
        if (/mineru-result\.zip$/i.test(name)) {
          zipPath = path.join(imagesDir, name);
          break;
        }
      }
    } catch {
      continue;
    }
    if (!zipPath) continue;

    const mdPath = path.join(vaultRoot, outputPath, `${citekey}.md`);
    if (!fs.existsSync(mdPath)) continue;

    const layout = readMineruContentList(zipPath);
    if (!layout || layout.length === 0) continue;

    const mdContent = fs.readFileSync(mdPath, 'utf-8');
    if (writeLayoutFile(layout, mdContent, imagesDir)) {
      backfilled++;
      ragLog('RagBackfill', 'Backfilled layout', { citekey, blocks: layout.length });
    }
  }
  return backfilled;
}
