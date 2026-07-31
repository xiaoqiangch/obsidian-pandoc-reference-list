import { requestUrl } from 'obsidian';
import { debugLog } from '../helpers';

export interface LlmConvertSettings {
  apiUrl: string;
  apiKey: string;
  modelName: string;
}

export async function convertImageToMarkdown(
  imageDataUrl: string,
  settings: LlmConvertSettings,
  context?: string
): Promise<string> {
  debugLog('LlmConverter', 'convertImageToMarkdown called', {
    model: settings.modelName,
    hasContext: !!context,
  });

  if (!settings.apiKey) {
    throw new Error('Please configure the conversion model API key in settings.');
  }

  const normalizedUrl = normalizeApiUrl(settings.apiUrl);

  const systemPrompt = `You are an expert academic document converter. Convert the provided page image to well-structured Markdown.

Rules:
1. Preserve all text content faithfully.
2. Convert mathematical formulas to LaTeX: inline math with $...$ and display math with $$...$$.
3. Preserve document structure: headings (#, ##, ###), lists, tables, blockquotes.
4. For figures/images in the page, describe them briefly using the format: ![Description](image-placeholder)
5. For tables, convert them to Markdown table format.
6. Preserve footnotes using [^N] syntax.
7. Do not add any commentary or explanation - output ONLY the markdown content.
8. If the page contains references/bibliography, preserve them in their original format.`;

  const userContent: any[] = [
    {
      type: 'text',
      text: context
        ? `Context: This is page ${context} of an academic document. Convert this page to Markdown.`
        : 'Convert this page to Markdown.',
    },
    {
      type: 'image_url',
      image_url: {
        url: imageDataUrl,
        detail: 'high',
      },
    },
  ];

  const body = {
    model: settings.modelName,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
    temperature: 0.1,
    max_tokens: 4096,
  };

  const response = await requestUrl({
    url: `${normalizedUrl}/chat/completions`,
    method: 'POST',
    headers: {
      Authorization: `Bearer ${settings.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const content = response.json.choices[0].message.content;
  debugLog('LlmConverter', 'convertImageToMarkdown response received', {
    contentLength: content?.length,
  });

  return content || '';
}

export async function convertTextToMarkdown(
  text: string,
  settings: LlmConvertSettings,
  context?: string
): Promise<string> {
  debugLog('LlmConverter', 'convertTextToMarkdown called', {
    model: settings.modelName,
    textLength: text.length,
  });

  if (!settings.apiKey) {
    throw new Error('Please configure the conversion model API key in settings.');
  }

  const normalizedUrl = normalizeApiUrl(settings.apiUrl);

  const systemPrompt = `You are an expert academic document formatter. Convert the provided text to well-structured Markdown.

Rules:
1. Preserve all text content faithfully.
2. Convert mathematical formulas to LaTeX: inline math with $...$ and display math with $$...$$.
3. Preserve document structure: headings (#, ##, ###), lists, tables, blockquotes.
4. For figures/images, use the format: ![Description](image-placeholder)
5. For tables, convert them to Markdown table format.
6. Do not add any commentary or explanation - output ONLY the markdown content.
7. If the text contains references/bibliography, preserve them in their original format.`;

  const body = {
    model: settings.modelName,
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: context
          ? `Context: This is ${context} of an academic document.\n\nConvert the following text to well-structured Markdown:\n\n${text}`
          : `Convert the following text to well-structured Markdown:\n\n${text}`,
      },
    ],
    temperature: 0.1,
    max_tokens: 8192,
  };

  const response = await requestUrl({
    url: `${normalizedUrl}/chat/completions`,
    method: 'POST',
    headers: {
      Authorization: `Bearer ${settings.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const content = response.json.choices[0].message.content;
  debugLog('LlmConverter', 'convertTextToMarkdown response received', {
    contentLength: content?.length,
  });

  return content || '';
}

function extractReferencesSection(markdownContent: string): string | null {
  const patterns = [
    /^#{1,3}\s*References?\s*$/im,
    /^#{1,3}\s*Bibliography\s*$/im,
    /^#{1,3}\s*参考文献\s*$/im,
    /^#{1,3}\s*Works Cited\s*$/im,
    /^#{1,3}\s*引用文献\s*$/im,
    /^#{1,3}\s*文獻\s*$/im,
    /^#{1,3}\s*Literature Cited\s*$/im,
    /^References?\s*\n/m,
    /^Bibliography\s*\n/m,
    /^参考文献\s*\n/m,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(markdownContent);
    if (match) {
      const startIdx = match.index;
      const headingLine = match[0];
      const headingLevelMatch = headingLine.match(/^(#+)/);
      const headingLevel = headingLevelMatch ? headingLevelMatch[1].length : 0;

      const afterHeading = markdownContent.substring(startIdx + headingLine.length);

      if (headingLevel > 0) {
        const nextHeadingRe = new RegExp(`^#{1,${headingLevel}}\\s`, 'm');
        const nextMatch = nextHeadingRe.exec(afterHeading);
        if (nextMatch) {
          return headingLine + afterHeading.substring(0, nextMatch.index);
        }
      }

      return markdownContent.substring(startIdx);
    }
  }

  return null;
}

function chunkText(text: string, chunkSize: number): string[] {
  if (text.length <= chunkSize) return [text];

  const chunks: string[] = [];
  const lines = text.split('\n');
  let currentChunk = '';

  for (const line of lines) {
    if (currentChunk.length + line.length + 1 > chunkSize && currentChunk.length > 0) {
      chunks.push(currentChunk);
      currentChunk = '';
    }
    currentChunk += (currentChunk ? '\n' : '') + line;
  }

  if (currentChunk.trim()) chunks.push(currentChunk);
  return chunks;
}

async function extractBibFromChunk(
  chunk: string,
  settings: LlmConvertSettings,
  chunkIndex: number,
  totalChunks: number
): Promise<string> {
  const normalizedUrl = normalizeApiUrl(settings.apiUrl);

  const systemPrompt = `You are a bibliography expert. Extract the references/bibliography from the given markdown content and convert them to BibTeX format.

Rules:
1. Extract only the references/bibliography entries.
2. Convert each reference to a proper BibTeX entry with appropriate type (@article, @book, @inproceedings, etc.).
3. Generate reasonable citation keys in the format AuthorYear (e.g., Smith2023).
4. Include all available fields: title, author, year, journal, volume, pages, doi, url, publisher, etc.
5. Output ONLY the BibTeX content, no markdown code blocks or explanations.
6. If no references are found, return an empty string.`;

  const context = totalChunks > 1
    ? `This is chunk ${chunkIndex} of ${totalChunks} of the references section.`
    : '';

  const body = {
    model: settings.modelName,
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: `${context ? context + '\n\n' : ''}Extract and convert references from this markdown content to BibTeX:\n\n${chunk}`,
      },
    ],
    temperature: 0.1,
    max_tokens: 8192,
  };

  try {
    const response = await requestUrl({
      url: `${normalizedUrl}/chat/completions`,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${settings.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const content = response.json.choices[0].message.content;
    const cleaned = content.replace(/```(?:bibtex)?/g, '').replace(/```/g, '').trim();
    debugLog('LlmConverter', 'extractBibFromChunk response', {
      chunk: chunkIndex,
      bibLength: cleaned.length,
    });
    return cleaned;
  } catch (e) {
    debugLog('LlmConverter', `extractBibFromChunk failed for chunk ${chunkIndex}`, e);
    return '';
  }
}

export async function extractReferencesToBib(
  markdownContent: string,
  settings: LlmConvertSettings
): Promise<string> {
  debugLog('LlmConverter', 'extractReferencesToBib called', {
    contentLength: markdownContent.length,
  });

  if (!settings.apiKey) {
    return '';
  }

  const refsSection = extractReferencesSection(markdownContent);

  if (!refsSection || refsSection.trim().length === 0) {
    debugLog('LlmConverter', 'No references section found in markdown');
    return '';
  }

  debugLog('LlmConverter', 'References section found', { length: refsSection.length });

  const CHUNK_SIZE = 8000;
  const chunks = chunkText(refsSection, CHUNK_SIZE);

  debugLog('LlmConverter', 'References chunked', {
    count: chunks.length,
    sizes: chunks.map((c) => c.length),
  });

  const results: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const result = await extractBibFromChunk(chunks[i], settings, i + 1, chunks.length);
    if (result) results.push(result);
  }

  return results.join('\n\n').trim();
}

function normalizeApiUrl(url: string): string {
  let normalized = url.trim().replace(/\/+$/, '');
  if (normalized.includes('ark.cn-beijing.volces.com')) {
    return normalized;
  }
  if (!normalized.endsWith('/v1') && !normalized.includes('/v1/')) {
    if (normalized.includes('api.deepseek.com') && !normalized.endsWith('/v1')) {
      normalized += '/v1';
    }
    if (normalized.includes('api.openai.com') && !normalized.endsWith('/v1')) {
      normalized += '/v1';
    }
  }
  return normalized;
}
