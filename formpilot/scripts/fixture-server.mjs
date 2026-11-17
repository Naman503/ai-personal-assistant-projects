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
  // Site Pilot's look-and-act step: submit when nothing is missing, else stop for the user.
  if (prompt.includes('Your one next action as JSON')) {
    if (/MISSING: none/.test(prompt) && /ERRORS SHOWN: none/.test(prompt)) return JSON.stringify({ do: 'submit', why: 'all filled' });
    const m = prompt.match(/MISSING \(required, empty\): ([^\n]*)/);
    return JSON.stringify({ do: 'stop', why: `mock: missing ${m ? m[1] : 'something'}`, needsYou: true });
  }
  if (prompt.includes('Fill in ALL')) {
    const ids = [...prompt.matchAll(/"id": "([a-z]\d+)",\s*"question": "([^"]*)"/g)];
 // Choice fields: like a real model, answer with one of the options.
    const fitOptions = (id, value) => {
      const from = prompt.indexOf(`"id": "${id}"`);
      const next = prompt.indexOf('"id": "', from + 5);
      const block = prompt.slice(from, next === -1 ? undefined : next);
      const m = block.match(/"options": (\[[^\]]*\])/);
      if (!m || !value || /^f\d/.test(id)) return value; // f-ids: the extension's own fitting is under test
      let opts = [];
      try {
        opts = JSON.parse(m[1]);
      } catch {
        return value;
      }
      const parts = value.split(/\s*\|\s*/);
      if (parts.every((p) => opts.includes(p))) return value;
      const n = parseFloat(value);
      const inRange = opts.find((o) => {
        const r = o.match(/(\d+)\s*[-–]\s*(\d+)/);
        return r && n >= +r[1] && n <= +r[2];
      });
      return inRange ?? opts.find((o) => o.toLowerCase().includes(value.toLowerCase().split(' ')[0])) ?? opts[0];
    };
    const raw = (q) => /^address/i.test(q) ? 'HSR Layout, Bengaluru, Karnataka' : /email/i.test(q) ? 'jane@doe.dev' : /linkedin/i.test(q) ? 'https://www.linkedin.com/in/janedoe' : null;
    return JSON.stringify({
      fields: ids.map(([, id, q]) => ({
        id,
        value: raw(q) ?? fitOptions(id, /industr/i.test(q) ? 'IT/Tech | E-Commerce' : /platforms/i.test(q) ? 'iOS | Android' : /^city|current city|which city/i.test(q) ? 'Indore' : /current location|^location/i.test(q) ? 'Bengaluru' : /start date/i.test(q) ? '2025-03-01' : /notice/i.test(q) ? '30 days' : /ctc|salary/i.test(q) ? '10,75,000' : /experience/i.test(q) ? '3+ years' : /lwd|last working/i.test(q) ? '15 Dec 2026' : /mobile|phone/i.test(q) ? '+91 62645 79927' : /country/i.test(q) ? 'India' : /relocat|commut|interested|jd meets|meets your profile|authori[sz]ed|eligible/i.test(q) ? 'Yes' : /name/i.test(q) ? 'Jane Doe' : /why|motivat/i.test(q) ? 'Because I love building developer tools.' : ''),
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

let quotaUsedUp = false;
createServer((req, res) => {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS' };
  if (req.method === 'OPTIONS') return res.writeHead(204, cors).end();
  if (req.url === '/requests') return res.writeHead(200, { 'content-type': 'application/json', ...cors }).end(JSON.stringify(requests));
  // /quota-used-up: every model call answers 429 "per day" (like Gemini's free tier) until /reset.
  if (req.url === '/quota-used-up') {
    quotaUsedUp = true;
    return res.writeHead(200, cors).end('ok');
  }
  if (req.url === '/reset') {
    quotaUsedUp = false;
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
    if (quotaUsedUp && !prompt.includes('Extract short key facts')) {
      return res
        .writeHead(429, { 'content-type': 'application/json', ...cors })
        .end(JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20, model: mock. quotaId: GenerateRequestsPerDayPerProjectPerModel-FreeTier' } }));
    }
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
