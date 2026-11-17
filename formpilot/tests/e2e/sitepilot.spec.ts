/**
 * Site Pilot end to end on offline copies of real application systems (tests/fixtures/sites):
 * it opens each form in its own window, uploads the resume, answers through the "local" model
 * (the mock server), ticks consent, and submits (live) or stops before Submit (dry run).
 */
import { test as base, expect, chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { resolve } from 'node:path';

const EXT = resolve('.output/chrome-mv3');
const SITES = 'http://localhost:4173/sites';
const LLM = 'http://localhost:4174';

const test = base.extend<{ context: BrowserContext; sw: Worker; extId: string }>({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: !process.env.HEADED,
      args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
    });
    await use(context);
    await context.close();
  },
  sw: async ({ context }, use) => {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker');
    await use(sw);
  },
  extId: async ({ sw }, use) => use(sw.url().split('/')[2]),
});

async function configure(sw: Worker, liveAts: string[], vision = false) {
  await sw.evaluate(
    async ({ liveAts, vision }) => {
      await chrome.storage.local.set({
        settings: {
          providers: [{ id: 'mock', kind: 'openai', label: 'Mock LLM', enabled: true, apiKey: 'k', baseUrl: 'http://localhost:4174/v1', model: 'mock-model', jsonMode: true, headers: {} }],
          debug: { logLevel: 'debug', console: true },
          localAi: { whenActive: 'full', rpmIdle: 60, rpmActive: 30 },
          sitePilot: { kind: 'openai', baseUrl: 'http://localhost:4174/v1', model: 'mock-model', liveAts, vision, pauseMinSec: 0, pauseMaxSec: 0, harvestNaukri: false, maxMinutes: 5, resumeLink: 'https://drive.google.com/file/d/jane-doe-resume/view' },
        },
      });
    },
    { liveAts, vision },
  );
  await fetch(`${LLM}/reset`);
}

/** An extension page to talk to the background and Site Pilot's database from. */
async function extPage(context: BrowserContext, extId: string): Promise<Page> {
  const p = await context.newPage();
  await p.goto(`chrome-extension://${extId}/options.html#sitepilot`);
  // A one-page PDF stands in for the resume.
  await p.evaluate(async () => {
    const pdf = new TextEncoder().encode('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
    await new Promise<void>((res, rej) => {
      const r = indexedDB.open('formpilot-sitepilot', 10);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains('jobs')) {
          const j = db.createObjectStore('jobs', { keyPath: 'id' });
          for (const k of ['status', 'addedAt', 'updatedAt', 'doneAt', 'source']) j.createIndex(k, k);
          db.createObjectStore('shots', { keyPath: 'id' }).createIndex('jobId', 'jobId');
          db.createObjectStore('files', { keyPath: 'key' });
        }
      };
      r.onsuccess = () => {
        const tx = r.result.transaction('files', 'readwrite');
        tx.objectStore('files').put({ key: 'resume', name: 'Jane_Doe_Resume.pdf', type: 'application/pdf', size: pdf.byteLength, data: pdf.buffer, updatedAt: Date.now() });
        tx.oncomplete = () => (r.result.close(), res());
        tx.onerror = () => rej(tx.error);
      };
      r.onerror = () => rej(r.error);
    });
  });
  return p;
}

type Job = { status: string; reason?: string; ats?: string; answers: { q: string; a: string; src?: string }[]; steps: { what: string }[]; shots: string[] };

async function runOne(p: Page, url: string): Promise<Job> {
  await p.evaluate(async (url) => {
    await chrome.runtime.sendMessage({ type: 'sp-add', jobs: [{ url, source: 'manual', title: 'Senior React Native Engineer', company: `Acme ${Math.random()}` }] });
    await chrome.runtime.sendMessage({ type: 'sp', action: 'start' });
  }, url);
  const read = () =>
    p.evaluate(
      () =>
        new Promise<Job | null>((res) => {
          const r = indexedDB.open('formpilot-sitepilot');
          r.onsuccess = () => {
            const q = r.result.transaction('jobs').objectStore('jobs').getAll();
            q.onsuccess = () => {
              r.result.close();
              const done = (q.result as Job[]).find((j) => !['queued', 'working'].includes(j.status));
              res(done ?? null);
            };
          };
        }),
    );
  await expect.poll(read, { timeout: 150_000, intervals: [2000] }).not.toBeNull();
  const job = (await read())!;
  await p.evaluate(() => chrome.runtime.sendMessage({ type: 'sp', action: 'stop' }));
  return job;
}

const SYSTEMS: [string, string][] = [
  ['lever', 'lever.html'],
  ['greenhouse', 'greenhouse.html'],
  ['google-forms', 'google-form.html'],
  ['ashby', 'ashby.html'],
  ['workable', 'workable.html'],
  ['other', 'generic-career.html'],
];

for (const [ats, file] of SYSTEMS) {
  test(`Site Pilot applies on a ${ats} form (live)`, async ({ context, sw, extId }) => {
    test.setTimeout(200_000);
    await configure(sw, ['google-forms', 'greenhouse', 'lever', 'ashby', 'workable', 'other']);
    const p = await extPage(context, extId);
    const job = await runOne(p, `${SITES}/${file}`);
    const logs = (await p.evaluate(() => chrome.runtime.sendMessage({ type: 'get-logs' }))) as { data: { ns: string; msg: string; data?: unknown }[] };
    const info = `${job.status}: ${job.reason}\n${job.steps.map((s) => s.what).join('\n')}\n--- logs ---\n${logs.data
      .filter((l) => /sitepilot|fill/.test(l.ns))
      .slice(-60)
      .map((l) => `${l.ns}: ${l.msg} ${l.data ? JSON.stringify(l.data).slice(0, 160) : ''}`)
      .join('\n')}`;
    expect(job.status, info).toBe('sent');
    expect(job.answers.length, info).toBeGreaterThan(2);
    // Never a marketing / newsletter box.
    expect(job.answers.some((a) => /newsletter|marketing|future (job )?opportunities|talent community/i.test(a.q) && /tick|check|yes|true/i.test(a.a)), info).toBe(false);
  });
}

test('Site Pilot dry run stops before Submit and saves screenshots', async ({ context, sw, extId }) => {
  test.setTimeout(200_000);
  await configure(sw, [], true);
  const p = await extPage(context, extId);
  const job = await runOne(p, `${SITES}/lever.html`);
  const info = `${job.status}: ${job.reason}\n${job.steps.map((s) => s.what).join('\n')}`;
  expect(job.status, info).toBe('ready');
  expect(job.shots.length, info).toBeGreaterThan(0);
  expect(job.steps.some((s) => /resume uploaded/.test(s.what)), info).toBe(true);
});
