import { requestUrl } from 'obsidian';
import { debugLog } from '../helpers';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const MINERU_BASE = 'https://mineru.net/api/v4';
const MAX_POLL_ATTEMPTS = 300;
const POLL_INTERVAL_MS = 3000;

export interface MineruConvertSettings {
  apiToken: string;
  modelVersion?: string;
}

export interface MineruConvertResult {
  mdContent: string;
  imageCount: number;
}

type MineruProgressFn = (current: number, total: number, message?: string) => void;

/**
 * Convert a PDF to Markdown using the MinerU extraction API.
 *
 * Handles images, formulas (LaTeX), tables and references automatically.
 * Workflow:
 *   1. Request a presigned upload URL for the PDF.
 *   2. Upload the PDF bytes to the presigned URL.
 *   3. Poll the batch extract result until the task is done.
 *   4. Download the result zip archive.
 *   5. Extract full.md and the associated images, saving images into imagesDir and
 *      rewriting the image references in the markdown to point at the saved files.
 */
export async function convertPdfWithMineru(
  pdfPath: string,
  imagesDir: string,
  imageRelativePrefix: string,
  settings: MineruConvertSettings,
  onProgress?: MineruProgressFn
): Promise<MineruConvertResult> {
  if (!settings.apiToken) {
    throw new Error('Please configure the MinerU API token in settings.');
  }

  const modelVersion = settings.modelVersion || 'vlm';
  const fileName = path.basename(pdfPath);
  const dataId = fileName.replace(/\.[^.]+$/, '');

  debugLog('MineruConverter', 'Starting MinerU conversion', { fileName, modelVersion });

  onProgress?.(0, 1, 'Requesting MinerU upload URL...');
  const { batchId, uploadUrl } = await getUploadUrls(fileName, dataId, modelVersion, settings.apiToken);

  onProgress?.(0, 1, 'Uploading PDF to MinerU...');
  await uploadFile(uploadUrl, pdfPath);

  onProgress?.(0, 1, 'MinerU is processing the PDF...');
  const result = await pollBatchResult(batchId, settings.apiToken, onProgress);

  onProgress?.(0, 1, 'Downloading MinerU result...');
  const zipPath = path.join(imagesDir, `${dataId}-mineru-result.zip`);
  await downloadFile(result.fullZipUrl, zipPath, settings.apiToken);

  const extracted = extractZip(zipPath, imagesDir, imageRelativePrefix);

  try {
    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
  } catch (e) {
    debugLog('MineruConverter', 'Failed to remove temp zip', { zipPath, error: e });
  }

  debugLog('MineruConverter', 'MinerU conversion completed', {
    mdLength: extracted.mdContent.length,
    imageCount: extracted.imageCount,
  });

  return extracted;
}

async function getUploadUrls(
  fileName: string,
  dataId: string,
  modelVersion: string,
  token: string
): Promise<{ batchId: string; uploadUrl: string }> {
  const response = await requestUrl({
    url: `${MINERU_BASE}/file-urls/batch`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      files: [{ name: fileName, data_id: dataId }],
      model_version: modelVersion,
    }),
  }).catch((e: any) => {
    throw new Error(
      `MinerU upload URL request failed (${e?.status ?? 'error'})${e?.message ? `: ${e.message}` : ''}.`
    );
  });

  const json = response.json;
  if (!json || json.code !== 0) {
    throw new Error(json?.msg || 'Failed to request MinerU upload URL.');
  }

  const batchId = json.data?.batch_id;
  const uploadUrl = json.data?.file_urls?.[0];
  if (!batchId || !uploadUrl) {
    throw new Error('MinerU did not return an upload URL.');
  }

  debugLog('MineruConverter', 'Upload URL obtained', { batchId, uploadUrl });
  return { batchId, uploadUrl };
}

function uploadFile(uploadUrl: string, filePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(uploadUrl);
    const mod = urlObj.protocol === 'http:' ? http : https;
    const fileSize = fs.statSync(filePath).size;

    // The MinerU presigned OSS URL only signs the PUT method + host header.
    // Sending extra headers such as Content-Type breaks the signature and
    // causes a 403 SignatureDoesNotMatch, so omit them. Content-Length is
    // required to avoid Transfer-Encoding: chunked.
    const req = mod.request(
      urlObj,
      {
        method: 'PUT',
        headers: {
          'Content-Length': fileSize,
        },
      },
      (res: any) => {
        let body = '';
        res.on('data', (chunk: any) => (body += chunk));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve();
          } else {
            reject(
              new Error(
                `MinerU upload failed with status ${res.statusCode}${body ? `: ${body}` : ''}.`
              )
            );
          }
        });
      }
    );

    req.on('error', (e: any) => reject(e));
    fs.createReadStream(filePath)
      .on('error', (e: any) => reject(e))
      .pipe(req);
  });
}

async function pollBatchResult(
  batchId: string,
  token: string,
  onProgress?: MineruProgressFn
): Promise<{ fullZipUrl: string; errMsg?: string }> {
  const url = `${MINERU_BASE}/extract-results/batch/${batchId}`;

  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    const response = await requestUrl({
      url,
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
    }).catch((e: any) => {
      throw new Error(
        `MinerU result query failed (${e?.status ?? 'error'})${e?.message ? `: ${e.message}` : ''}.`
      );
    });

    const json = response.json;
    if (!json || json.code !== 0) {
      throw new Error(json?.msg || 'Failed to query MinerU extraction result.');
    }

    const result = json.data?.extract_result?.[0];
    if (!result) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    const state = result.state;
    if (state === 'done') {
      if (!result.full_zip_url) {
        throw new Error('MinerU task completed but no result archive was returned.');
      }
      return { fullZipUrl: result.full_zip_url, errMsg: result.err_msg };
    }

    if (state === 'failed') {
      throw new Error(result.err_msg || 'MinerU extraction failed.');
    }

    const progress = result.extract_progress;
    if (progress) {
      onProgress?.(
        progress.extracted_pages || 0,
        progress.total_pages || 1,
        `MinerU is extracting pages (${progress.extracted_pages || 0}/${progress.total_pages || 1})...`
      );
    } else {
      onProgress?.(0, 1, 'MinerU is processing the PDF...');
    }

    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error('MinerU extraction timed out.');
}

function downloadFile(url: string, destPath: string, token?: string, useAuth?: boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const mod = urlObj.protocol === 'http:' ? http : https;
    const options: any = useAuth && token ? { headers: { Authorization: `Bearer ${token}` } } : {};

    const handle = (res: any) => {
      if (
        res.statusCode &&
        (res.statusCode === 301 ||
          res.statusCode === 302 ||
          res.statusCode === 303 ||
          res.statusCode === 307 ||
          res.statusCode === 308)
      ) {
        res.resume();
        if (res.headers.location) {
          downloadFile(new URL(res.headers.location, url).toString(), destPath, token, useAuth).then(
            resolve,
            reject
          );
          return;
        }
        reject(new Error('MinerU download redirect with no location.'));
        return;
      }

      if (res.statusCode === 403 && token && !useAuth) {
        res.resume();
        downloadFile(url, destPath, token, true).then(resolve, reject);
        return;
      }

      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`MinerU result download failed with status ${res.statusCode}.`));
        return;
      }

      const file = fs.createWriteStream(destPath);
      res.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve();
      });
      file.on('error', (e: any) => {
        try {
          if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
        } catch {
          // ignore cleanup errors
        }
        reject(e);
      });
    };

    mod.get(urlObj, options, handle).on('error', (e: any) => reject(e));
  });
}

function extractZip(
  zipPath: string,
  imagesDir: string,
  imageRelativePrefix: string
): MineruConvertResult {
  const AdmZip = require('adm-zip');
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();

  let mdContent = '';
  let imageCount = 0;

  for (const entry of entries) {
    const entryName = entry.entryName;
    if (entry.isDirectory) continue;

    if (/full\.md$/i.test(entryName)) {
      mdContent = entry.getData().toString('utf-8');
      continue;
    }

    if (/^images?\//i.test(entryName)) {
      const relName = entryName.replace(/^images?\//i, '');
      const destPath = path.join(imagesDir, relName);
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.writeFileSync(destPath, entry.getData());
      imageCount++;
    }
  }

  if (!mdContent) {
    mdContent = '';
  }

  if (imageCount > 0) {
    mdContent = mdContent.replace(/\]\((?!(?:https?:)?\/\/)images?\//gi, `](${imageRelativePrefix}/`);
    mdContent = mdContent.replace(/src="images?\//gi, `src="${imageRelativePrefix}/`);
  }

  return { mdContent, imageCount };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}