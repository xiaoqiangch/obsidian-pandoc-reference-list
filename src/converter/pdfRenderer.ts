import { debugLog } from '../helpers';

const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
const OPS = pdfjsLib.OPS;

try {
  pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.js`;
} catch (e) {
  debugLog('PdfRenderer', 'Failed to set workerSrc', e);
}

export interface ExtractedImage {
  fileName: string;
}

export interface RenderedPage {
  pageNumber: number;
  imageDataUrl: string;
  width: number;
  height: number;
  extractedImages: ExtractedImage[];
}

export async function renderPdfPages(
  pdfPath: string,
  imagesDir: string,
  onProgress?: (current: number, total: number) => void,
  scale: number = 2.0
): Promise<RenderedPage[]> {
  debugLog('PdfRenderer', 'renderPdfPages started', { pdfPath, scale });

  const fs = require('fs');
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const loadingTask = pdfjsLib.getDocument({ data });

  const pdfDoc = await loadingTask.promise;
  const totalPages = pdfDoc.numPages;
  debugLog('PdfRenderer', 'PDF loaded', { totalPages });

  const pages: RenderedPage[] = [];

  for (let i = 1; i <= totalPages; i++) {
    const page = await pdfDoc.getPage(i);
    const viewport = page.getViewport({ scale });

    const canvas = createCanvas(viewport.width, viewport.height);
    const context = canvas.getContext('2d');

    await page.render({
      canvasContext: context,
      viewport: viewport,
    }).promise;

    const imageDataUrl = canvas.toDataURL('image/png');

    const extractedImages = await extractImagesFromPage(page, i, imagesDir);

    pages.push({
      pageNumber: i,
      imageDataUrl,
      width: viewport.width,
      height: viewport.height,
      extractedImages,
    });

    page.cleanup();

    if (onProgress) {
      onProgress(i, totalPages);
    }

    debugLog('PdfRenderer', `Page ${i}/${totalPages} rendered, ${extractedImages.length} images extracted`);
  }

  await pdfDoc.destroy();
  debugLog('PdfRenderer', 'renderPdfPages finished', { pagesRendered: pages.length });

  return pages;
}

export async function getPdfPageCount(pdfPath: string): Promise<number> {
  const fs = require('fs');
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const loadingTask = pdfjsLib.getDocument({ data });
  const pdfDoc = await loadingTask.promise;
  const count = pdfDoc.numPages;
  await pdfDoc.destroy();
  return count;
}

/** PDF user-space (pt) size of a single page at scale 1. */
export async function getPdfPageSize(
  pdfPath: string,
  pageNumber: number
): Promise<{ width: number; height: number } | null> {
  try {
    const fs = require('fs');
    const data = new Uint8Array(fs.readFileSync(pdfPath));
    const loadingTask = pdfjsLib.getDocument({ data });
    const pdfDoc = await loadingTask.promise;
    const page = await pdfDoc.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    const size = { width: viewport.width, height: viewport.height };
    page.cleanup();
    await pdfDoc.destroy();
    return size;
  } catch (e) {
    debugLog('PdfRenderer', `Failed to get page size for page ${pageNumber}`, e);
    return null;
  }
}

async function extractImagesFromPage(
  page: any,
  pageNumber: number,
  imagesDir: string
): Promise<ExtractedImage[]> {
  const result: ExtractedImage[] = [];

  try {
    const opList = await page.getOperatorList();
    const fnArray = opList.fnArray;
    const argsArray = opList.argsArray;

    let imgIndex = 0;

    for (let i = 0; i < fnArray.length; i++) {
      const fn = fnArray[i];
      const args = argsArray[i];

      if (fn === OPS.paintImageXObject || fn === OPS.paintJpegXObject) {
        const imgName = args[0];
        const fileName = await extractXObjectImage(page, imgName, pageNumber, ++imgIndex, imagesDir);
        if (fileName) result.push({ fileName });
      } else if (fn === OPS.paintInlineImageXObject) {
        const imgData = args[0];
        const fileName = saveImageObject(imgData, pageNumber, ++imgIndex, imagesDir);
        if (fileName) result.push({ fileName });
      }
    }
  } catch (e) {
    debugLog('PdfRenderer', `Image extraction failed for page ${pageNumber}`, e);
  }

  return result;
}

async function extractXObjectImage(
  page: any,
  imgName: string,
  pageNumber: number,
  imgIndex: number,
  imagesDir: string
): Promise<string | null> {
  try {
    const imgObj = await new Promise<any>((resolve) => {
      let resolved = false;
      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          resolve(null);
        }
      }, 5000);
      page.objs.get(imgName, (o: any) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          resolve(o);
        }
      });
    });

    if (!imgObj) return null;
    return saveImageObject(imgObj, pageNumber, imgIndex, imagesDir);
  } catch (e) {
    debugLog('PdfRenderer', `Failed to extract XObject image ${imgName}`, e);
    return null;
  }
}

function saveImageObject(
  imgObj: any,
  pageNumber: number,
  imgIndex: number,
  imagesDir: string
): string | null {
  if (!imgObj) return null;

  const fs = require('fs');
  const path = require('path');
  const fileName = `p${pageNumber}_img${imgIndex}.png`;
  const imgPath = path.join(imagesDir, fileName);

  try {
    if (typeof imgObj === 'string' && imgObj.startsWith('data:')) {
      const base64Data = imgObj.replace(/^data:image\/\w+;base64,/, '');
      fs.writeFileSync(imgPath, Buffer.from(base64Data, 'base64'));
      return fileName;
    }

    if (imgObj.bitmap) {
      const w = imgObj.width || imgObj.bitmap.width || 100;
      const h = imgObj.height || imgObj.bitmap.height || 100;
      const canvas = createCanvas(w, h);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(imgObj.bitmap, 0, 0);
      const dataUrl = canvas.toDataURL('image/png');
      const base64Data = dataUrl.replace(/^data:image\/png;base64,/, '');
      fs.writeFileSync(imgPath, Buffer.from(base64Data, 'base64'));
      return fileName;
    }

    if (imgObj.data && imgObj.width && imgObj.height) {
      const { width, height, data, kind } = imgObj;
      const canvas = createCanvas(width, height);
      const ctx = canvas.getContext('2d');
      const imageData = ctx.createImageData(width, height);

      if (data.length === width * height * 4) {
        imageData.data.set(data);
      } else if (data.length === width * height * 3) {
        for (let j = 0; j < width * height; j++) {
          imageData.data[j * 4] = data[j * 3];
          imageData.data[j * 4 + 1] = data[j * 3 + 1];
          imageData.data[j * 4 + 2] = data[j * 3 + 2];
          imageData.data[j * 4 + 3] = 255;
        }
      } else if (kind === 1) {
        const pixels = width * height;
        for (let j = 0; j < pixels; j++) {
          const byte = data[Math.floor(j / 8)];
          const bit = (byte >> (7 - (j % 8))) & 1;
          const val = bit ? 0 : 255;
          imageData.data[j * 4] = val;
          imageData.data[j * 4 + 1] = val;
          imageData.data[j * 4 + 2] = val;
          imageData.data[j * 4 + 3] = 255;
        }
      } else {
        imageData.data.set(data);
      }

      ctx.putImageData(imageData, 0, 0);
      const dataUrl = canvas.toDataURL('image/png');
      const base64Data = dataUrl.replace(/^data:image\/png;base64,/, '');
      fs.writeFileSync(imgPath, Buffer.from(base64Data, 'base64'));
      return fileName;
    }
  } catch (e) {
    debugLog('PdfRenderer', `Failed to save image p${pageNumber}_img${imgIndex}`, e);
  }

  return null;
}

function createCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(width);
  canvas.height = Math.ceil(height);
  return canvas;
}
