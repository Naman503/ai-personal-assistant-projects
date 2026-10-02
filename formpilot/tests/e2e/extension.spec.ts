import { test as base, expect, chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { resolve } from 'node:path';

const EXT = resolve('.output/chrome-mv3');
const FORM = 'http://localhost:4173/form.html';
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

async function configure(sw: Worker, patch: Record<string, unknown> = {}) {
  await sw.evaluate(async (patch) => {
    await chrome.storage.local.set({
      settings: {
        providers: [
          { id: 'mock', kind: 'openai', label: 'Mock LLM', enabled: true, apiKey: 'test-key', baseUrl: 'http://localhost:4174/v1', model: 'mock-model', jsonMode: true, headers: {} },
        ],
        behavior: { generateDelayMs: 0 },
        debug: { logLevel: 'debug', console: true },
        ...patch,
      },
    });
  }, patch);
  await fetch(`${LLM}/reset`);
}

const requests = async () => (await (await fetch(`${LLM}/requests`)).json()) as { url: string; auth: string; prompt: string; stream: boolean }[];
const host = (page: Page) => page.locator('formpilot-ui');

async function waitReady(page: Page, minItems = 1) {
  await expect(host(page)).toHaveAttribute('data-open', 'true');
  await expect.poll(async () => Number(await host(page).getAttribute('data-items')), { timeout: 15_000 }).toBeGreaterThanOrEqual(minItems);
  await expect(host(page)).toHaveAttribute('data-status', /done|instant/, { timeout: 15_000 });
}

test('streams AI suggestions under a textarea and inserts with Enter', async ({ context, sw }) => {
  await configure(sw);
  const page = await context.newPage();
  const logs: string[] = [];
  page.on('console', (m) => m.text().includes('FormPilot') && logs.push(m.text()));
  await page.goto(FORM);
  await page.click('#why');
  await waitReady(page);
  await expect(host(page)).toHaveAttribute('data-status', 'done');
  await page.keyboard.press('Enter');
  await expect(page.locator('#why')).toHaveValue('I want to build developer tools that millions rely on.');

  const [r] = await requests();
  expect(r.auth).toBe('Bearer test-key');
  expect(r.stream).toBe(true);
  expect(r.prompt).toContain('Question: Why do you want to join Acme?');
  expect(r.prompt).toContain('developer tools used by millions'); // page context
  expect(r.prompt).toContain('max length 600');
  expect(logs.some((l) => l.includes('inserted ai suggestion'))).toBe(true);
});

test('arrow keys pick the second option; Escape closes', async ({ context, sw }) => {
  await configure(sw);
  const page = await context.newPage();
  await page.goto(FORM);
  await page.click('#why');
  await waitReady(page, 2);
  await expect(host(page)).toHaveAttribute('data-status', 'done');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.locator('#why')).toHaveValue(/Acme builds the tools I use every day/);
  await page.click('#company');
  await expect(host(page)).toHaveAttribute('data-open', 'true');
  await page.keyboard.press('Escape');
  await expect(host(page)).toHaveAttribute('data-open', 'false');
});

test('works with React-style controlled inputs', async ({ context, sw }) => {
  await configure(sw);
  const page = await context.newPage();
  await page.goto(FORM);
  await page.click('#company');
  await waitReady(page);
  await expect(host(page)).toHaveAttribute('data-status', 'done');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300); // let the fake "re-render" loop run
  await expect(page.locator('#company')).toHaveValue('Acme Corp');
  expect(await page.evaluate(() => (window as unknown as { __companyState: string }).__companyState)).toBe('Acme Corp');
});

test('facts added in settings fill instantly without calling the AI', async ({ context, sw, extId }) => {
  await configure(sw);
  const opts = await context.newPage();
  await opts.goto(`chrome-extension://${extId}/options.html#memory`);
  await opts.getByPlaceholder('Label (e.g. Email)').fill('Email');
  await opts.getByPlaceholder('Value').fill('jane@doe.dev');
  await opts.getByRole('button', { name: 'Add' }).click();
  await expect(opts.getByText('jane@doe.dev')).toBeVisible();

  const page = await context.newPage();
  await page.goto(FORM);
  await page.click('#email');
  await waitReady(page);
  await page.keyboard.press('Enter');
  await expect(page.locator('#email')).toHaveValue('jane@doe.dev');
  expect((await requests()).filter((r) => r.prompt.includes('Question: Email'))).toHaveLength(0);
});

test('never touches passwords and stays quiet on search boxes', async ({ context, sw }) => {
  await configure(sw);
  const page = await context.newPage();
  await page.goto(FORM);
  await page.click('#pw');
  await page.waitForTimeout(800);
  await page.click('#site-search');
  await page.waitForTimeout(800);
  expect(await requests()).toHaveLength(0);
  const open = await host(page).getAttribute('data-open').catch(() => null);
  expect(open === null || open === 'false').toBe(true);
});

test('fills the whole form in one request, skipping passwords and consent boxes', async ({ context, sw }) => {
  await configure(sw);
  const page = await context.newPage();
  await page.goto(FORM);
  await page.click('#first');
  await page.keyboard.press('Escape');
  await sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'http://localhost:4173/*' });
    await chrome.tabs.sendMessage(tab.id!, { type: 'command', name: 'fill-form' });
  });
  await expect(page.locator('#why')).toHaveValue('Because I love building developer tools.', { timeout: 15_000 });
  await expect(page.locator('#first')).not.toHaveValue('');
  await expect(page.locator('#country')).toHaveValue('IN');
  await expect(page.locator('input[name=relocate][value=yes]')).toBeChecked();
  await expect(page.locator('#pw')).toHaveValue('');
  await expect(page.locator('#agree')).not.toBeChecked();
  const batch = (await requests()).filter((r) => r.prompt.includes('Fill in ALL'));
  expect(batch).toHaveLength(1);
  expect(batch[0].prompt).not.toContain('Create a password');
});

test('rich-text editor via keyboard command', async ({ context, sw }) => {
  await configure(sw);
  const page = await context.newPage();
  await page.goto(FORM);
  await page.click('#note');
  await sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'http://localhost:4173/*' });
    await chrome.tabs.sendMessage(tab.id!, { type: 'command', name: 'open-suggestions' });
  });
  await waitReady(page);
  await expect(host(page)).toHaveAttribute('data-status', 'done');
  await page.keyboard.press('Enter');
  await expect(page.locator('#note')).toContainText('Answer for Anything else?');
});

test('shows a clear error when the provider fails', async ({ context, sw }) => {
  await configure(sw, {
    providers: [{ id: 'bad', kind: 'openai', label: 'Broken', enabled: true, apiKey: 'x', baseUrl: 'http://localhost:4174/v1/broken', model: 'm', jsonMode: false, headers: {} }],
    generation: { maxRetries: 0 },
  });
  const page = await context.newPage();
  await page.goto(FORM);
  await page.click('#why');
  await expect(host(page)).toHaveAttribute('data-status', 'error', { timeout: 15_000 });
});

test('options and popup pages render', async ({ context, sw, extId }) => {
  await configure(sw);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  for (const section of ['overview', 'providers', 'local', 'memory', 'generation', 'behavior', 'cache', 'privacy', 'appearance', 'logs', 'about']) {
    await page.goto(`chrome-extension://${extId}/options.html#${section}`);
    await expect(page.locator('h1')).toBeVisible();
  }
  await page.goto(`chrome-extension://${extId}/popup.html`);
  await expect(page.getByText('FormPilot', { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test.describe('modal / drawer questionnaires (job-portal chatbots)', () => {
  const MODAL = 'http://localhost:4173/modal.html';

  test('auto-opens on a chat box inside a modal, reads the question from the conversation, renders on top', async ({ context, sw }) => {
    await configure(sw);
    const page = await context.newPage();
    await page.goto(MODAL);
    await page.click('#chat-input');
    await waitReady(page);
    await expect(host(page)).toHaveAttribute('data-status', 'done');

    // The prompt used the chat bubble, not the "Type message here..." placeholder.
    const r = (await requests()).find((x) => x.prompt.includes('Question:'))!;
    expect(r.prompt).toContain('Question: How many years of experience do you have in Postgresql?');
    expect(r.prompt).toContain('chat-style questionnaire');

    // Host lives inside the modal and in the top layer, so it is the topmost element under the dropdown.
    const info = await page.evaluate(() => {
      const h = document.querySelector('formpilot-ui')!;
      const r = document.getElementById('chat-input')!.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + 40, r.bottom + 24);
      return { insideDrawer: !!h.closest('#drawer'), topLayer: h.matches(':popover-open'), hitIsOurs: hit === h, x: r.left + 40, y: r.bottom + 24 };
    });
    expect(info.insideDrawer).toBe(true);
    expect(info.topLayer).toBe(true);
    expect(info.hitIsOurs).toBe(true);

    // Clicking on the dropdown must not count as an "outside click" that closes the modal.
    await page.mouse.click(info.x, info.y);
    await expect(page.locator('#status')).toHaveText('open');

    await page.click('#chat-input');
    await waitReady(page);
    await expect(host(page)).toHaveAttribute('data-status', 'done');
    await page.keyboard.press('Enter');
    await expect(page.locator('#chat-input')).toHaveText('4');
    await expect(page.locator('#status')).toHaveText('open');
  });

  test('plain input with a generic placeholder also uses the latest question', async ({ context, sw }) => {
    await configure(sw);
    const page = await context.newPage();
    await page.goto(MODAL);
    await page.click('#plain');
    await waitReady(page);
    await expect(host(page)).toHaveAttribute('data-status', 'done');
    await page.keyboard.press('Enter');
    await expect(page.locator('#plain')).toHaveValue('4');
  });
});

test.describe('learning from corrections', () => {
  test('typing your own answer instead of the suggestion saves it; next time it is offered first with no AI call', async ({ context, sw }) => {
    await configure(sw, { cache: { learn: 'auto' } });
    const page = await context.newPage();
    await page.goto(FORM);
    await page.click('#why');
    await waitReady(page);
    await expect(host(page)).toHaveAttribute('data-status', 'done');
    await page.keyboard.type('Because I have shipped three design systems.');
    await page.click('#email'); // leave the field → correction detected
    await expect(host(page)).toHaveAttribute('data-toast', 'success');

    await fetch(`${LLM}/reset`);
    await page.reload();
    await page.click('#why');
    await waitReady(page);
    await page.keyboard.press('Enter');
    await expect(page.locator('#why')).toHaveValue('Because I have shipped three design systems.');
    expect((await requests()).filter((r) => r.prompt.includes('Question: Why do you want to join Acme?'))).toHaveLength(0);
  });

  test('"Ask me" mode shows a prompt instead of saving silently', async ({ context, sw }) => {
    await configure(sw);
    const page = await context.newPage();
    await page.goto(FORM);
    await page.click('#company');
    await waitReady(page);
    await page.keyboard.type('Globex');
    await page.click('#email');
    await expect(host(page)).toHaveAttribute('data-toast', 'info');
  });

  test('chat questionnaire: replying with Enter learns the answer for that question', async ({ context, sw, extId }) => {
    await configure(sw, { cache: { learn: 'auto' } });
    const page = await context.newPage();
    await page.goto('http://localhost:4173/modal.html');
    await page.click('#chat-input');
    await waitReady(page);
    await expect(host(page)).toHaveAttribute('data-status', 'done');
    await page.keyboard.type('6');
    await page.keyboard.press('Enter');
    await expect(host(page)).toHaveAttribute('data-toast', 'success');

    const opts = await context.newPage();
    await opts.goto(`chrome-extension://${extId}/options.html#memory`);
    await expect(opts.getByText('How many years of experience do you have in Postgresql?')).toBeVisible();
    await expect(opts.getByText('Learned')).toBeVisible();
  });
});

test.describe('drawer chatbot without ARIA (Naukri-style)', () => {
  const DRAWER = 'http://localhost:4173/drawer.html';

  test('opens by itself once the bot asks, survives a capture-phase click-outside handler, follows the conversation', async ({ context, sw }) => {
    await configure(sw);
    const page = await context.newPage();
    await page.goto(DRAWER);
    await page.click('#apply');
    // Input is focused before the question renders; the dropdown must appear once it does.
    await waitReady(page);
    await expect(host(page)).toHaveAttribute('data-status', 'done');
    expect((await requests()).some((r) => r.prompt.includes('Question: How many years of experience do you have in SQL Database?'))).toBe(true);

    const info = await page.evaluate(() => {
      const h = document.querySelector('formpilot-ui')!;
      const r = document.querySelector('._in')!.getBoundingClientRect();
      const x = r.left + 60;
      const y = r.bottom + 24;
      return { insideDrawer: !!h.closest('._dr'), hitIsOurs: document.elementFromPoint(x, y) === h, x, y };
    });
    expect(info.insideDrawer).toBe(true);
    expect(info.hitIsOurs).toBe(true);
    await page.mouse.click(info.x, info.y); // click on our dropdown
    expect(await page.evaluate(() => (window as unknown as { __closed?: number }).__closed ?? 0)).toBe(0);

    await page.locator('._in').focus();
    await waitReady(page);
    await page.keyboard.press('Enter'); // insert "4"
    await expect(page.locator('._in')).toHaveText('4');
    await page.keyboard.press('Enter'); // send it
    // The bot asks the next question → suggestions refresh for it automatically.
    await expect.poll(async () => (await requests()).some((r) => r.prompt.includes('Question: Are you willing to relocate to Pune?')), { timeout: 10_000 }).toBe(true);
    await waitReady(page);
    expect(await page.evaluate(() => (window as unknown as { __closed?: number }).__closed ?? 0)).toBe(0);
    expect(await page.evaluate(() => (window as unknown as { __answers?: string[] }).__answers)).toEqual(['4']);
  });

  test('clicking the field icon opens suggestions and does not close the drawer', async ({ context, sw }) => {
    await configure(sw, { behavior: { trigger: 'icon', generateDelayMs: 0 } });
    const page = await context.newPage();
    await page.goto(DRAWER);
    await page.click('#apply');
    await page.waitForTimeout(900); // question rendered
    const pt = await page.evaluate(() => {
      const r = document.querySelector('._in')!.getBoundingClientRect();
      return { x: r.right - 6 - 8 - 12, y: r.top + 6 + 12 };
    });
    expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName, pt)).toBe('FORMPILOT-UI');
    await page.mouse.click(pt.x, pt.y);
    await waitReady(page);
    expect(await page.evaluate(() => (window as unknown as { __closed?: number }).__closed ?? 0)).toBe(0);
  });
});

test.describe('chat questionnaire sites (site list)', () => {
  test('opens as soon as the popup focuses the input, waits for a late question, mounts inside the panel', async ({ context, sw }) => {
    await configure(sw, { behavior: { generateDelayMs: 0, chatSites: ['localhost'] } });
    const page = await context.newPage();
    const logs: string[] = [];
    page.on('console', (m) => logs.push(m.text()));
    await page.goto('http://localhost:4173/drawer2.html');
    await page.click('#apply');
    // No click on FormPilot at all: it opens by itself once the bot's question renders (1.2s later).
    await waitReady(page);
    await expect(host(page)).toHaveAttribute('data-status', 'done');
    expect((await requests()).some((r) => r.prompt.includes('Question: How many years of experience do you have in SQL Database?'))).toBe(true);
    expect(logs.some((l) => l.includes('chat field diagnostics'))).toBe(true);

    const info = await page.evaluate(() => {
      const h = document.querySelector('formpilot-ui')!;
      const r = document.querySelector('._in')!.getBoundingClientRect();
      return { insidePanel: !!h.closest('._panel'), x: r.left + 60, y: r.bottom + 24, hit: document.elementFromPoint(r.left + 60, r.bottom + 24) === h };
    });
    expect(info.insidePanel).toBe(true);
    expect(info.hit).toBe(true);
    await page.mouse.click(info.x, info.y);
    expect(await page.evaluate(() => (window as unknown as { __closed?: number }).__closed ?? 0)).toBe(0);

    await page.locator('._in').focus();
    await waitReady(page);
    await page.keyboard.press('Enter');
    await expect(page.locator('._in')).toHaveText('4');
  });
});

test.describe('Naukri drawer structure + visual question detection', () => {
  test('Naukri structure: waits past the greeting, reads the real question, answers briefly, follows the next question', async ({ context, sw }) => {
    await configure(sw, { behavior: { generateDelayMs: 0, chatSites: ['localhost'] } });
    const page = await context.newPage();
    const logs: string[] = [];
    page.on('console', (m) => logs.push(m.text()));
    await page.goto('http://localhost:4173/naukri-real.html');
    await page.click('#apply-button');
    await waitReady(page);
    await expect(host(page)).toHaveAttribute('data-status', 'done');
    const asked = (await requests()).map((r) => r.prompt.match(/Question: (.*)/)?.[1]);
    expect(asked).toContain('How many years of experience do you have in React.Js Or Nodejs?');
    expect(asked.some((q) => q?.startsWith('Hi Alex'))).toBe(false); // greeting never treated as the question
    expect(logs.some((l) => l.includes('chat question found via site'))).toBe(true);
    expect(await page.evaluate(() => !!document.querySelector('formpilot-ui')?.closest('.chatbot_Drawer'))).toBe(true);

    await page.keyboard.press('Enter'); // insert suggestion
    await expect(page.locator('.textArea')).toHaveText('4');
    await page.keyboard.press('Enter'); // send
    await expect.poll(async () => (await requests()).some((r) => r.prompt.includes('Question: What is your notice period?')), { timeout: 10_000 }).toBe(true);
    expect(await page.evaluate(() => (window as unknown as { __answers?: string[] }).__answers)).toEqual(['4']);
    expect(await page.evaluate(() => (window as unknown as { __closed?: number }).__closed ?? 0)).toBe(0);
  });

  test('visual scan finds the question displayed above the input even when it comes later in the DOM', async ({ context, sw }) => {
    await configure(sw, { behavior: { generateDelayMs: 0, chatSites: ['localhost'] } });
    const page = await context.newPage();
    await page.goto('http://localhost:4173/chat-reversed.html');
    await page.click('#in');
    await waitReady(page);
    expect((await requests()).some((r) => r.prompt.includes('Question: How many years of experience do you have in SQL Database?'))).toBe(true);
  });
});
