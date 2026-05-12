'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PORT || 3000);
const MODEL = process.env.OPENAI_MODEL || 'gpt-5.4-nano';
const API_KEY = process.env.OPENAI_API_KEY;
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav'
};

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
  });
  res.end(JSON.stringify(payload));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 100_000) {
        req.destroy();
        reject(new Error('Request body is too large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function extractOutputText(data) {
  if (typeof data.output_text === 'string') return data.output_text.trim();
  const parts = [];
  for (const item of data.output || []) {
    for (const content of item.content || []) {
      if (content.type === 'output_text' && content.text) parts.push(content.text);
      if (content.type === 'text' && content.text) parts.push(content.text);
    }
  }
  return parts.join('').trim();
}

async function translate({ text, kind, context }) {
  if (!API_KEY) {
    const error = new Error('OPENAI_API_KEY is not set');
    error.status = 503;
    throw error;
  }
  const source = String(text || '').trim();
  if (!source) {
    const error = new Error('No text to translate');
    error.status = 400;
    throw error;
  }

  const isWord = kind === 'word';
  const instructions = isWord
    ? 'You translate English vocabulary for a Japanese English learner. Reply with only a short natural Japanese meaning. No markdown.'
    : 'You translate English transcript paragraphs into natural Japanese for shadowing study. Preserve speaker nuance, keep it concise, and reply with only the Japanese translation. No markdown.';
  const input = isWord
    ? `Word: ${source}\nExample sentence: ${String(context || '')}`
    : source;

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: MODEL,
      instructions,
      input,
      reasoning: { effort: 'none' },
      max_output_tokens: isWord ? 80 : 700
    })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data.error?.message || `OpenAI API error: ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }

  const translation = extractOutputText(data);
  if (!translation) {
    const error = new Error('No translation returned');
    error.status = 502;
    throw error;
  }
  return translation;
}

function serveFile(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const rawPath = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  const filePath = path.normalize(path.join(ROOT, rawPath));
  const rel = path.relative(ROOT, filePath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
    });
    res.end();
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/health') {
    sendJson(res, 200, { ok: true, model: MODEL, hasKey: Boolean(API_KEY) });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/translate') {
    try {
      const body = await readJson(req);
      const translation = await translate(body);
      sendJson(res, 200, { translation, model: MODEL });
    } catch (error) {
      sendJson(res, error.status || 500, { error: error.message || 'Translation failed' });
    }
    return;
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    serveFile(req, res);
    return;
  }

  res.writeHead(405);
  res.end('Method not allowed');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Shadowing app server: http://localhost:${PORT}`);
  console.log(`Translation model: ${MODEL}`);
  if (!API_KEY) console.log('OPENAI_API_KEY is not set; translation calls will return 503.');
});
