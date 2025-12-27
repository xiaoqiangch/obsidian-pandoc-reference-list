import { requestUrl } from 'obsidian';
import { PartialCSLEntry } from './types';

export async function callDeepSeek(text: string, apiUrl: string, apiKey: string): Promise<PartialCSLEntry[]> {
    console.log('callDeepSeek: started', { textLength: text.length, apiUrl });
    if (!apiKey) {
        throw new Error('Please configure DeepSeek API Key in settings.');
    }

    // Ensure apiUrl doesn't end with a slash and handle missing /v1
    let normalizedUrl = apiUrl.trim().replace(/\/+$/, '');
    if (!normalizedUrl.endsWith('/v1') && !normalizedUrl.includes('/v1/')) {
        // If it's just the base domain, add /v1
        if (normalizedUrl.includes('api.deepseek.com') && !normalizedUrl.endsWith('/v1')) {
            normalizedUrl += '/v1';
        }
    }

    const prompt = `你是一个参考文献专家。请将以下文本内容转换为 BibTeX 格式。
如果文本中包含多个参考文献，请全部转换。
只返回 BibTeX 代码块，不要有其他解释。
如果无法转换，请返回空。

文本内容：
${text}`;

    try {
        const response = await requestUrl({
            url: `${normalizedUrl}/chat/completions`,
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: "deepseek-chat",
                messages: [
                    { role: "system", content: "You are a helpful assistant that converts text to BibTeX." },
                    { role: "user", content: prompt }
                ],
                temperature: 0
            })
        });

        console.log('callDeepSeek: response received', response.status);
        const content = response.json.choices[0].message.content;
        console.log('callDeepSeek: content', content);
        const entries = parseBibtexFromText(content);
        console.log('callDeepSeek: parsed entries', entries.length);
        return entries;
    } catch (e) {
        console.error('callDeepSeek: error', e);
        throw e;
    }
}

export function parseBibtexFromText(text: string): PartialCSLEntry[] {
    const entries: PartialCSLEntry[] = [];
    // Remove markdown code blocks if present
    // Don't aggressively remove % as it might be part of the content (e.g., "34%")
    const cleanedText = text.replace(/```(?:bibtex)?/g, '').replace(/```/g, '');
    const entryRegex = /@(\w+)\s*{\s*([^,]+),/g;
    let match;

    console.log('parseBibtexFromText: cleaned text length', cleanedText.length);

    while ((match = entryRegex.exec(cleanedText)) !== null) {
        const type = match[1].toLowerCase();
        const key = match[2].trim();
        const startIndex = match.index;
        
        console.log('parseBibtexFromText: found entry', { type, key, startIndex });
        
        let depth = 1;
        let endIndex = -1;
        for (let i = startIndex + match[0].length; i < cleanedText.length; i++) {
            if (cleanedText[i] === '{') depth++;
            else if (cleanedText[i] === '}') depth--;
            
            if (depth === 0) {
                endIndex = i + 1;
                break;
            }
        }

        if (endIndex !== -1) {
            const body = cleanedText.substring(startIndex + match[0].length, endIndex - 1);
            
            const entry: PartialCSLEntry = {
                id: key,
                type: type,
                title: extractField(body, 'title') || 'Untitled',
            };

            const author = extractField(body, 'author');
            if (author) {
                entry.author = author.split(/\s+and\s+/i).map(a => {
                    const parts = a.split(',');
                    if (parts.length >= 2) {
                        return { family: parts[0].trim(), given: parts[1].trim() };
                    }
                    const spaceParts = a.trim().split(/\s+/);
                    if (spaceParts.length >= 2) {
                        return { family: spaceParts[spaceParts.length - 1], given: spaceParts[0] };
                    }
                    return { family: a.trim() };
                });
            }

            entry.year = extractField(body, 'year');
            entry.journal = extractField(body, 'journal') || extractField(body, 'booktitle');
            entry.doi = extractField(body, 'doi');
            entry.url = extractField(body, 'url');
            entry.abstract = extractField(body, 'abstract');
            entry.note = extractField(body, 'note');
            entry.publisher = extractField(body, 'publisher');

            entries.push(entry);
            console.log('parseBibtexFromText: added entry', entry.id);
        }
    }

    return entries;
}

function extractField(content: string, fieldName: string): string | null {
    const regexStart = new RegExp(`\\b${fieldName}\\s*=\\s*`, 'i');
    const match = content.match(regexStart);
    if (!match || match.index === undefined) return null;

    const valueStart = content.substring(match.index + match[0].length).trim();
    let value = '';
    
    if (valueStart.startsWith('{')) {
        let depth = 0;
        for (let i = 0; i < valueStart.length; i++) {
            if (valueStart[i] === '{') depth++;
            else if (valueStart[i] === '}') depth--;
            if (depth === 0) {
                value = valueStart.substring(1, i);
                break;
            }
        }
    } else if (valueStart.startsWith('"')) {
        const endQuote = valueStart.indexOf('"', 1);
        if (endQuote !== -1) value = valueStart.substring(1, endQuote);
    } else {
        const endMatch = valueStart.match(/^([^,}\s]+)/);
        if (endMatch) value = endMatch[1];
    }
    
    return value.replace(/^\{|\}$/g, '').trim().replace(/\s+/g, ' ');
}
