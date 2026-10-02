// Dev/test helper: serves tests/fixtures on :4173 and a mock OpenAI-compatible LLM on :4174.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

const FIXTURES = join(process.cwd(), 'tests/fixtures');
const PAGE_PORT = Number(process.env.PAGE_PORT ?? 4173);
const LLM_PORT = Number(process.env.LLM_PORT ?? 4174);
export const requests = [];

createServer(async (req, res) => {
  const path = req.url === '/' ? '/form.html' : req.url.split('?')[0];
  try {
    const body = await readFile(join(FIXTURES, path));
    res.writeHead(200, { 'content-type': extname(path) === '.html' ? 'text/html; charset=utf-8' : 'text/plain' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(PAGE_PORT, () => console.log(`fixtures on http://localhost:${PAGE_PORT}/form.html`));

function answerFor(prompt) {
  if (prompt.includes('Fill in ALL')) {
    const ids = [...prompt.matchAll(/"id": "(f\d+)",\s*"question": "([^"]*)"/g)];
    return JSON.stringify({
      fields: ids.map(([, id, q]) => ({
        id,
        value: /country/i.test(q) ? 'India' : /relocat/i.test(q) ? 'Yes' : /name/i.test(q) ? 'Jane Doe' : /why|motivat/i.test(q) ? 'Because I love building developer tools.' : '',
      })),
    });
  }
  if (prompt.includes('Extract short key facts')) return JSON.stringify({ facts: [{ label: 'Email', value: 'jane@doe.dev' }] });
  const q = prompt.match(/Question: (.*)/)?.[1] ?? '';
  if (/why/i.test(q)) {
    return JSON.stringify({
      suggestions: [
        { title: 'Concise', text: 'I want to build developer tools that millions rely on.' },
        { title: 'Detailed', text: 'Acme builds the tools I use every day, and I want to help shape them.' },
      ],
    });
  }
  if (/relocate/i.test(q)) return JSON.stringify({ suggestions: [{ title: 'Answer', text: 'Yes' }] });
  if (/years of experience/i.test(q)) return JSON.stringify({ suggestions: [{ title: 'Years', text: '4' }] });
  if (/company/i.test(q)) return JSON.stringify({ suggestions: [{ title: 'Company', text: 'Acme Corp' }] });
  return JSON.stringify({ suggestions: [{ title: 'Answer', text: `Answer for ${q}` }] });
}

createServer((req, res) => {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS' };
  if (req.method === 'OPTIONS') return res.writeHead(204, cors).end();
  if (req.url === '/requests') return res.writeHead(200, { 'content-type': 'application/json', ...cors }).end(JSON.stringify(requests));
  if (req.url === '/reset') {
    requests.length = 0;
    return res.writeHead(200, cors).end('ok');
  }
  if (req.url?.includes('/broken')) return res.writeHead(500, { 'content-type': 'application/json', ...cors }).end(JSON.stringify({ error: { message: 'mock upstream failure' } }));
  if (req.url?.endsWith('/models')) return res.writeHead(200, { 'content-type': 'application/json', ...cors }).end(JSON.stringify({ data: [{ id: 'mock-model' }] }));
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', async () => {
    const body = JSON.parse(raw || '{}');
    const prompt = body.messages?.map((m) => m.content).join('\n') ?? '';
    requests.push({ url: req.url, auth: req.headers.authorization, prompt, stream: body.stream });
    const content = answerFor(prompt);
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream', ...cors });
      // Stream in small pieces to exercise partial JSON parsing.
      for (let i = 0; i < content.length; i += 12) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: content.slice(i, i + 12) } }] })}\n\n`);
        await new Promise((r) => setTimeout(r, 5));
      }
      res.end('data: [DONE]\n\n');
    } else {
      res.writeHead(200, { 'content-type': 'application/json', ...cors }).end(JSON.stringify({ choices: [{ message: { content } }] }));
    }
  });
}).listen(LLM_PORT, () => console.log(`mock LLM on http://localhost:${LLM_PORT}/v1`));
