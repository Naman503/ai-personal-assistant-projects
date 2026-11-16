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
  for (const section of ['overview', 'providers', 'local', 'memory', 'generation', 'behavior', 'popup', 'cache', 'privacy', 'appearance', 'logs', 'about']) {
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

test.describe('password-protected API keys', () => {
  test('save key → create password → encrypted at rest → reveal needs password → AI uses it; strict mode locks after restart', async ({ context, sw, extId }) => {
    await configure(sw, {
      providers: [{ id: 'mock', kind: 'openai', label: 'Mock LLM', enabled: true, apiKey: '', hasKey: false, baseUrl: 'http://localhost:4174/v1', model: 'mock-model', jsonMode: true, headers: {} }],
    });
    const opts = await context.newPage();
    await opts.goto(`chrome-extension://${extId}/options.html#providers`);

    // 1) Paste a key → asked to create a password
    await opts.getByPlaceholder('Paste your key').fill('secret-123');
    await opts.getByRole('button', { name: 'Save key' }).click();
    await expect(opts.getByText('Protect your API keys')).toBeVisible();
    await opts.getByPlaceholder('New password or PIN').fill('Sup3r-secret');
    await opts.getByPlaceholder('Confirm password or PIN').fill('Sup3r-secret');
    await opts.getByRole('button', { name: 'Set password' }).click();
    await expect(opts.getByTitle('Show key (needs password)')).toBeVisible();

    // 2) Nothing readable in storage: neither the key nor the password
    const raw = await sw.evaluate(async () => JSON.stringify(await chrome.storage.local.get(null)));
    expect(raw).not.toContain('secret-123');
    expect(raw).not.toContain('Sup3r-secret');

    // 3) A fresh settings page must ask for the password to show the key
    await opts.reload();
    await opts.getByTitle('Show key (needs password)').click();
    await expect(opts.getByText('Enter your FormPilot password')).toBeVisible();
    await opts.getByPlaceholder('Password', { exact: true }).fill('wrong-pass1');
    await opts.getByRole('button', { name: 'Unlock' }).click();
    await expect(opts.getByText('Wrong password. Try again.')).toBeVisible();
    await opts.getByPlaceholder('Password', { exact: true }).fill('Sup3r-secret');
    await opts.getByRole('button', { name: 'Unlock' }).click();
    await expect(opts.getByText('secret-123')).toBeVisible();

    // 4) Suggestions use the decrypted key, with no password prompt (standard mode)
    const page = await context.newPage();
    await page.goto(FORM);
    await page.click('#why');
    await waitReady(page);
    await expect(host(page)).toHaveAttribute('data-status', 'done');
    expect((await requests()).at(-1)?.auth).toBe('Bearer secret-123');

    // 5) Strict mode: lock after a browser restart
    await opts.goto(`chrome-extension://${extId}/options.html#privacy`);
    await opts.locator('div.flex').filter({ has: opts.locator('label', { hasText: 'Lock after the browser restarts' }) }).last().getByRole('switch').click();
    // Changing the mode needs the password; this tab may still be unlocked from step 3 (5-minute window).
    if (await opts.getByPlaceholder('Password', { exact: true }).isVisible().catch(() => false)) {
      await opts.getByPlaceholder('Password', { exact: true }).fill('Sup3r-secret');
      await opts.getByRole('button', { name: 'Unlock' }).click();
    }
    await expect.poll(async () => sw.evaluate(async () => ((await chrome.storage.local.get('vault')).vault as { mode: string }).mode)).toBe('strict');
    await sw.evaluate(async () => chrome.storage.session.clear()); // what a browser restart does
    await fetch(`${LLM}/reset`);
    await page.reload();
    await page.click('#company'); // a new question (cached answers still work while locked; they need no key)
    await expect(host(page)).toHaveAttribute('data-status', 'error', { timeout: 15_000 });
    expect(await requests()).toHaveLength(0);

    // Unlock from the deep link the dropdown's "Unlock" button opens
    const unlock = await context.newPage();
    await unlock.goto(`chrome-extension://${extId}/options.html#providers?unlock=1`);
    await unlock.getByPlaceholder('Password', { exact: true }).fill('Sup3r-secret');
    await unlock.getByRole('button', { name: 'Unlock' }).click();
    await expect(unlock.getByText(/Unlocked/)).toBeVisible();
    await page.reload();
    await page.click('#company');
    await waitReady(page);
    await expect(host(page)).toHaveAttribute('data-status', 'done');
    expect((await requests()).at(-1)?.auth).toBe('Bearer secret-123');
  });
});

test.describe('popup: move, pin, reopen, shortcuts', () => {
  const hitIsPopup = (page: Page, x: number, y: number) => page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.tagName === 'FORMPILOT-UI', [x, y] as const);

  test('drag the popup by its header; position is remembered per site and can be reset', async ({ context, sw, extId }) => {
    await configure(sw, { panel: { placement: 'below' } });
    const page = await context.newPage();
    await page.goto(FORM);
    await page.click('#first');
    await waitReady(page);
    const r = await page.locator('#first').boundingBox();
    // Header sits right under the field: grab its title area and drag to the top-right.
    const start = { x: r!.x + 160, y: r!.y + r!.height + 6 + 22 };
    expect(await hitIsPopup(page, start.x, start.y)).toBe(true);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + 300, start.y - 150, { steps: 8 });
    await page.mouse.move(1100, 60, { steps: 8 });
    await page.mouse.up();
    await expect.poll(async () => sw.evaluate(async () => Object.keys(((await chrome.storage.local.get('panelPositions')).panelPositions as object) ?? {}))).toEqual(['localhost']);
    const spot = { x: 1100, y: 70 };
    expect(await hitIsPopup(page, spot.x, spot.y)).toBe(true);

    // Reload: the popup opens at the saved spot.
    await page.reload();
    await page.click('#company');
    await waitReady(page);
    expect(await hitIsPopup(page, spot.x, spot.y)).toBe(true);

    // Reset from settings → back next to the field.
    const opts = await context.newPage();
    await opts.goto(`chrome-extension://${extId}/options.html#popup`);
    await opts.getByRole('button', { name: 'Reset all positions' }).click();
    await page.bringToFront();
    await expect.poll(() => hitIsPopup(page, spot.x, spot.y)).toBe(false);
  });

  test('pinned popup stays on screen when clicking elsewhere; unpinned closes', async ({ context, sw }) => {
    await configure(sw, { panel: { pinnedByDefault: true } });
    const page = await context.newPage();
    await page.goto(FORM);
    await page.click('#why');
    await waitReady(page);
    await page.click('h1');
    await page.waitForTimeout(400);
    await expect(host(page)).toHaveAttribute('data-open', 'true');

    await configure(sw, { panel: { pinnedByDefault: false } });
    await page.reload();
    await page.click('#why');
    await waitReady(page);
    await page.click('h1');
    await expect(host(page)).toHaveAttribute('data-open', 'false');
  });

  test('clicking the field reopens a closed popup; Alt+2 inserts the 2nd suggestion; typing can keep it open', async ({ context, sw }) => {
    await configure(sw, { panel: { hideWhileTyping: false } });
    const page = await context.newPage();
    await page.goto(FORM);
    await page.click('#why');
    await waitReady(page, 2);
    await page.keyboard.press('Escape');
    await expect(host(page)).toHaveAttribute('data-open', 'false');
    await page.click('#why'); // same field, still focused
    await waitReady(page, 2);
    await page.keyboard.type('I ');
    await expect(host(page)).toHaveAttribute('data-open', 'true'); // hideWhileTyping off
    await page.keyboard.press('Alt+Digit2');
    await expect(page.locator('#why')).toHaveValue(/Acme builds the tools I use every day/);
  });
});

test('records an application in the job tracker when the site confirms it', async ({ context, sw }) => {
  // A stand-in job tracker that remembers what it was sent.
  const { createServer } = await import('node:http');
  const got: Record<string, unknown>[] = [];
  const tracker = createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      if (req.url === '/api/record-application') got.push(JSON.parse(b));
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, id: 'x1', created: true, status: 'applied', applications: [] }));
    });
  });
  await new Promise<void>((r) => tracker.listen(4175, r));
  try {
    await configure(sw, { tracker: { enabled: true, url: 'http://localhost:4175', autoRecord: true, includeAnswers: true }, behavior: { enabled: false } });
    const page = await context.newPage();
    await page.goto('http://localhost:4173/apply.html');
    await page.fill('#name', 'Jane Doe');
    await page.fill('#ectc', '15 LPA');
    await page.click('#next');
    await page.fill('#notice', '30 days');
    await page.fill('#pwd', 'secret-should-not-be-sent');
    await page.click('#submit');
    await expect.poll(() => got.length, { timeout: 10_000 }).toBe(1);
    const rec = got[0] as { kind: string; role: string; company: string; location: string; url: string; answers: { q: string; a: string }[] };
    expect(rec.kind).toBe('applied');
    expect(rec.role).toBe('Senior Mobile Engineer');
    expect(rec.company).toBe('Acme');
    expect(rec.location).toBe('Bengaluru, KA');
    expect(rec.url).toBe('http://localhost:4173/apply.html');
    const answers = Object.fromEntries(rec.answers.map((x) => [x.q, x.a]));
    expect(answers['Expected CTC']).toBe('15 LPA'); // from the step that was already gone
    expect(answers['Notice period']).toBe('30 days');
    expect(JSON.stringify(rec)).not.toContain('secret-should-not-be-sent');
    await expect(page.locator('formpilot-ui')).toBeAttached();
  } finally {
    tracker.close();
  }
});

test('records a LinkedIn-style Easy Apply whose dialog lives in a shadow root', async ({ context, sw }) => {
  const { createServer } = await import('node:http');
  const got: Record<string, unknown>[] = [];
  const tracker = createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      if (req.url === '/api/record-application') got.push(JSON.parse(b));
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, id: 'x2', created: true, status: 'applied' }));
    });
  });
  await new Promise<void>((r) => tracker.listen(4176, r));
  try {
    await configure(sw, { tracker: { enabled: true, url: 'http://localhost:4176', autoRecord: true, includeAnswers: true }, behavior: { enabled: false } });
    const page = await context.newPage();
    await page.goto('http://localhost:4173/apply-shadow.html');
    await page.click('#easy');
    await page.locator('#interop-outlet').locator('#ctc').fill('10.75');
    await page.locator('#interop-outlet').locator('#next span').click();
    await page.locator('#interop-outlet').locator('#np').fill('30 days');
    await page.locator('#interop-outlet').locator('#send span').click();
    await expect.poll(() => got.length, { timeout: 10_000 }).toBe(1);
    const rec = got[0] as { role: string; company: string; location: string; answers: { q: string; a: string }[] };
    expect(rec.role).toBe('Staff Engineer');
    expect(rec.company).toBe('Beta Labs');
    expect(rec.location).toBe('Pune, Maharashtra');
    const answers = Object.fromEntries(rec.answers.map((x) => [x.q, x.a]));
    expect(answers['Current CTC (INR, annual, in lacs)']).toBe('10.75');
    expect(answers['Notice period']).toBe('30 days');
  } finally {
    tracker.close();
  }
});

test('popup shows the job on the page, whether it is tracked, and today from the tracker', async ({ context, sw, extId }) => {
  const { createServer } = await import('node:http');
  let tracked = false;
  const tracker = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    const send = (o: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(o));
    if (u.pathname === '/api/digest') return send({ toApply: 12, toSend: 3, due: ['Acme: Engineer'], interviews: [], waiting: 0, week: 7 });
    if (u.pathname === '/api/lookup') return send(tracked ? { found: true, id: 'j1', status: 'applied', label: 'Applied', appliedOn: '2026-11-13', fitAuto: 4, fitWhy: ['Mentions React Native'], people: 2 } : { found: false });
    send({ ok: true });
  });
  await new Promise<void>((r) => tracker.listen(4177, r));
  try {
    await configure(sw, { tracker: { enabled: true, url: 'http://localhost:4177', autoRecord: true, includeAnswers: true, walkToSubmit: false } });
    const job = await context.newPage();
    await job.goto('http://localhost:4173/apply-shadow.html');
    const open = async () => {
      const popup = await context.newPage();
      // The popup reads "the active tab": point it at the job page.
      await popup.addInitScript(() => {
        const q = chrome.tabs.query.bind(chrome.tabs);
        (chrome.tabs as { query: unknown }).query = (info: chrome.tabs.QueryInfo) => (info.active ? q({ url: 'http://localhost:4173/apply-shadow.html' }) : q(info));
      });
      await popup.setViewportSize({ width: 360, height: 640 });
      await popup.goto(`chrome-extension://${extId}/popup.html`);
      return popup;
    };
    let popup = await open();
    await expect(popup.getByText('Staff Engineer')).toBeVisible();
    await expect(popup.getByText('Beta Labs · Pune, Maharashtra')).toBeVisible();
    await expect(popup.getByText('Not tracked yet')).toBeVisible();
    await expect(popup.getByRole('button', { name: /Save/ })).toBeVisible();
    await expect(popup.getByRole('button', { name: /Send/ })).toContainText('3');
    if (process.env.SHOTS) await popup.screenshot({ path: `${process.env.SHOTS}/popup-new.png`, fullPage: true });
    await popup.close();
    tracked = true;
    popup = await open();
    await expect(popup.getByText(/^Applied (13 Nov|Nov 13)$/)).toBeVisible();
    await expect(popup.getByRole('button', { name: 'Open', exact: true })).toBeVisible();
    await expect(popup.getByRole('button', { name: /I applied/ })).toHaveCount(0);
    if (process.env.SHOTS) await popup.screenshot({ path: `${process.env.SHOTS}/popup-tracked.png`, fullPage: true });
  } finally {
    tracker.close();
  }
});

test('walks a shadow-root Easy Apply to the Submit button and stops there', async ({ context, sw }) => {
  await configure(sw, { tracker: { enabled: true, url: 'http://localhost:4176', autoRecord: true, includeAnswers: true, walkToSubmit: true }, behavior: { enabled: false } });
  const page = await context.newPage();
  await page.goto('http://localhost:4173/apply-shadow.html');
  await page.click('#easy');
  const dialog = page.locator('#interop-outlet');
  await dialog.locator('#ctc').focus();
  await page.keyboard.press('Escape');
  await sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'http://localhost:4173/*' });
    await chrome.tabs.sendMessage(tab.id!, { type: 'command', name: 'fill-form' });
  });
  // Step 1 filled, Next pressed for us, step 2 filled, Submit highlighted and not pressed.
  await expect(dialog.locator('#np')).toHaveValue('30', { timeout: 15_000 });
  await expect(dialog.locator('#s1')).toHaveCount(0);
  await expect.poll(() => dialog.locator('#send').evaluate((b) => (b as HTMLElement).style.outline), { timeout: 10_000 }).toMatch(/solid 3px|3px solid/);
  await expect(page.locator('formpilot-ui')).toHaveAttribute('data-toast', 'success');
  await expect(dialog.locator('h2')).toHaveText('Apply to Beta Labs');
});

test('fills hidden-input Yes/No radios (LinkedIn style) and walks on to Submit', async ({ context, sw }) => {
  await configure(sw, { tracker: { enabled: true, url: 'http://localhost:4176', autoRecord: true, includeAnswers: true, walkToSubmit: true }, behavior: { enabled: false } });
  const page = await context.newPage();
  await page.goto('http://localhost:4173/apply-radios.html');
  // Nothing typeable on this step: anchor the fill on the first radio, as the walker does.
  await page.locator('#c-yes').focus();
  await sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'http://localhost:4173/*' });
    await chrome.tabs.sendMessage(tab.id!, { type: 'command', name: 'fill-form' });
  });
  await expect(page.locator('#s2')).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => page.locator('#send').evaluate((b) => (b as HTMLElement).style.outline), { timeout: 10_000 }).toMatch(/solid 3px|3px solid/);
});

test('toolbar Fill on a LinkedIn-style closed shadow-root Easy Apply: radios, phone, walk to Submit', async ({ context, sw }) => {
  await configure(sw, { tracker: { enabled: true, url: 'http://localhost:4176', autoRecord: true, includeAnswers: true, walkToSubmit: true }, behavior: { enabled: false } });
  const page = await context.newPage();
  await page.goto('http://localhost:4173/apply-linkedin.html');
  await page.click('#easy');
  // No field is focused: LinkedIn focuses the dialog itself (frameShouldAct covers the popup's focus loss).
  await sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'http://localhost:4173/apply-linkedin.html' });
    await chrome.tabs.sendMessage(tab.id!, { type: 'command', name: 'fill-form', via: 'toolbar' });
  });
  const state = () => page.evaluate(() => {
    const r = (window as unknown as { __root: ShadowRoot }).__root;
    const send = r.getElementById('send') as HTMLElement | null;
    return { onStep2: !!send && !(r.getElementById('s2') as HTMLElement).hidden, outline: send?.style.outline ?? '', submitted: !!(window as unknown as { __submitted?: boolean }).__submitted };
  });
  await expect.poll(async () => (await state()).onStep2, { timeout: 20_000 }).toBe(true);
  await expect.poll(async () => (await state()).outline, { timeout: 10_000 }).toMatch(/solid 3px|3px solid/);
  expect((await state()).submitted).toBe(false);
});

test('LinkedIn salary step: plain numbers, lakhs when asked, fixes "Invalid input" and range errors, stops at Submit', async ({ context, sw }) => {
  await configure(sw, {
    tracker: { enabled: true, url: 'http://localhost:4176', autoRecord: false, includeAnswers: false, walkToSubmit: true },
    behavior: { enabled: false },
  });
  const page = await context.newPage();
  await page.goto('http://localhost:4173/apply-ctc.html');
  await page.click('#easy');
  await sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'http://localhost:4173/apply-ctc.html' });
    await chrome.tabs.sendMessage(tab.id!, { type: 'command', name: 'fill-form', via: 'toolbar' });
  });
  // The mock AI answers "10,75,000" for every salary box and "30 days" for the notice period.
  await expect.poll(() => page.evaluate(() => !(document.getElementById('s2') as HTMLElement).hidden), { timeout: 30_000 }).toBe(true);
  const v = await page.evaluate(() => Object.fromEntries(['cur', 'lpa', 'exp', 'np'].map((id) => [id, (document.getElementById(id) as HTMLInputElement).value])));
  expect(v).toEqual({ cur: '1075000', lpa: '10.75', exp: '11', np: '30' });
  await expect(page.locator('#send')).toHaveCSS('outline-width', '3px');
  expect(await page.evaluate(() => (window as unknown as { __submitted?: boolean }).__submitted)).toBeFalsy();
  // Every field and the repair are in the log, for reading back from Options → Logs.
  const msgs = () => sw.evaluate(async () => (((await chrome.storage.session.get('fpLogs')).fpLogs ?? []) as { msg: string }[]).map((e) => e.msg));
  await expect.poll(async () => (await msgs()).some((m) => m.startsWith('repair: "Expected CTC ?" "1075000" → "11"')), { timeout: 10_000 }).toBe(true);
  const all = await msgs();
  expect(all).toContain('✓ "What\'s your Current CTC ?" ← "1075000"');
  expect(all.some((m) => m.startsWith('walk: 1 field error(s) on this step'))).toBe(true);
});

test('LinkedIn Edit experience: fills employment Month/Year without AI, leaves unknown months to you and remembers your pick', async ({ context, sw }) => {
  await configure(sw, { tracker: { enabled: true, url: 'http://localhost:4176', autoRecord: false, includeAnswers: false, walkToSubmit: true }, behavior: { enabled: false } });
  // Metafic's months were picked on an earlier form; Eazeebox is "Present" with no month known.
  await sw.evaluate(() => chrome.storage.local.set({ fpWorkHistory: { metafic: { from: { y: 2023, m: 6 }, to: { y: 2025, m: 3 } }, eazeebox: { from: { y: 2025 }, to: 'present' } } }));
  const page = await context.newPage();
  await page.goto('http://localhost:4173/apply-experience.html');
  await page.click('#easy');
  // The cursor is in a LinkedIn chat box outside the application (what happened live).
  await page.locator('#msg').click();
  await sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'http://localhost:4173/apply-experience.html' });
    await chrome.tabs.sendMessage(tab.id!, { type: 'command', name: 'fill-form', via: 'toolbar' });
  });
  const val = (id: string) => page.locator(id).inputValue();
  await expect.poll(() => val('#m-fy'), { timeout: 20_000 }).toBe('2023');
  expect([await val('#m-fm'), await val('#m-tm'), await val('#m-ty')]).toEqual(['6', '3', '2025']);
  expect(await page.locator('#e-cur').isChecked()).toBe(true);
  await expect.poll(() => val('#e-fy'), { timeout: 10_000 }).toBe('2025');
  // The Eazeebox start month isn't known: left empty, and the walk stops on it by name.
  expect(await val('#e-fm')).toBe('');
  await expect.poll(() => page.locator('#e-fm').evaluate((el) => document.activeElement === el), { timeout: 15_000 }).toBe(true);
  expect(await page.locator('#s2').isHidden()).toBe(true);
  // The chat box was left alone, and "Save" in the experience block wasn't taken for Submit.
  expect(await page.locator('#msg').innerText()).toBe('');
  expect(await page.locator('#send').evaluate((b) => (b as HTMLElement).style.outline)).toBe('');
  // You pick it: FormPilot remembers it for Eazeebox.
  await page.selectOption('#e-fm', '4');
  await expect.poll(() => sw.evaluate(async () => ((await chrome.storage.local.get('fpWorkHistory')).fpWorkHistory as Record<string, { from?: { m?: number } }>).eazeebox?.from?.m), { timeout: 10_000 }).toBe(4);
  // The dates never went to the AI: the mock was not asked about Month / Year.
  const msgs = () => sw.evaluate(async () => (((await chrome.storage.session.get('fpLogs')).fpLogs ?? []) as { msg: string }[]).map((e) => e.msg));
  await expect.poll(async () => (await msgs()).join('\n'), { timeout: 10_000 }).toContain('walk stopped: "Start month at Eazeebox');
  expect(await msgs()).toContain('✓ "Start month at Metafic" ← "June"');
  expect((await msgs()).some((m) => m.startsWith('walk stopped: "Start month at Eazeebox'))).toBe(true);
  expect((await msgs()).some((m) => /fill-form: \d+ fields?, .*to the model/.test(m) && /Month|Year/.test(m))).toBe(false);
});

test('LinkedIn Edit experience that opens on a later step (live markup): the walk fills its Month/Year and goes on to Submit', async ({ context, sw }) => {
  await configure(sw, { tracker: { enabled: true, url: 'http://localhost:4176', autoRecord: false, includeAnswers: false, walkToSubmit: true }, behavior: { enabled: false } });
  await sw.evaluate(() => chrome.storage.local.set({ fpWorkHistory: { metafic: { from: { y: 2023, m: 4 }, to: { y: 2025, m: 8 } } } }));
  const page = await context.newPage();
  await page.goto('http://localhost:4173/apply-experience-live.html');
  await page.click('#easy');
  await page.locator('#city').click();
  await sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'http://localhost:4173/apply-experience-live.html' });
    await chrome.tabs.sendMessage(tab.id!, { type: 'command', name: 'fill-form', via: 'toolbar' });
  });
  await expect.poll(() => page.evaluate(() => !(document.getElementById('s3') as HTMLElement).hidden), { timeout: 40_000 }).toBe(true);
  const v = await page.evaluate(() => ['x-fm', 'x-fy', 'x-tm', 'x-ty'].map((id) => (document.getElementById(id) as HTMLSelectElement).value));
  expect(v).toEqual(['4', '2023', '8', '2025']);
  await expect(page.locator('#send')).toHaveCSS('outline-width', '3px');
  expect(await page.evaluate(() => (window as unknown as { __submitted?: boolean }).__submitted)).toBeFalsy();
  const msgs = () => sw.evaluate(async () => (((await chrome.storage.session.get('fpLogs')).fpLogs ?? []) as { msg: string }[]).map((e) => e.msg));
  await expect.poll(async () => (await msgs()).includes('✓ "Start month at Metafic" ← "April"'), { timeout: 10_000 }).toBe(true);
});

test('LinkedIn radio questions without a legend (live markup): the question reaches the AI and the right range is picked', async ({ context, sw }) => {
  await configure(sw, { tracker: { enabled: true, url: 'http://localhost:4176', autoRecord: false, includeAnswers: false, walkToSubmit: true }, behavior: { enabled: false } });
  const page = await context.newPage();
  await page.goto('http://localhost:4173/apply-radios-live.html');
  await page.click('#easy');
  await sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'http://localhost:4173/apply-radios-live.html' });
    await chrome.tabs.sendMessage(tab.id!, { type: 'command', name: 'fill-form', via: 'toolbar' });
  });
  // The mock answers "3+ years" to experience questions → "Less than 5 years".
  await expect.poll(() => page.evaluate(() => !(document.getElementById('s2') as HTMLElement).hidden), { timeout: 30_000 }).toBe(true);
  expect(await page.evaluate(() => ['g1', 'g2'].map((g) => [...document.querySelectorAll<HTMLInputElement>(`input[name="radio-group-${g}"]`)].findIndex((r) => r.checked)))).toEqual([0, 0]);
  const prompts = (await requests()).map((r) => r.prompt).join('\n');
  expect(prompts).toContain('How many years of hands-on experience do you have developing and maintaining production applications using React Native?');
  expect(prompts).toContain('5–7 years — I have solid experience');
  expect(prompts).not.toContain('radio-group-g1');
});

test('apply queue with "submit for me" on: counts down and presses Submit itself', async ({ context, sw }) => {
  test.setTimeout(150_000);
  await configure(sw, {
    tracker: { enabled: true, url: 'http://localhost:4176', autoRecord: true, includeAnswers: true, walkToSubmit: true, queueDailyCap: 10, queueDelaySec: 0, queueSkipTitles: 'Engineering Manager', queueAutoSubmit: true },
    behavior: { enabled: false },
  });
  await sw.evaluate(() => chrome.storage.local.remove('fpQueueDay'));
  const page = await context.newPage();
  await page.goto('http://localhost:4173/linkedin-list.html');
  // The fixture's Submit accepts a scripted click, and closes the dialog straight after it (no
  // "Application sent" dialog), as LinkedIn did on the first live run.
  await page.evaluate(() => Object.assign(window, { __allowScripted: true, __closeOnSubmit: true }));
  await sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'http://localhost:4173/linkedin-list.html*' });
    await chrome.tabs.sendMessage(tab.id!, { type: 'command', name: 'apply-queue', via: 'toolbar' }, { frameId: 0 });
  });
  await expect.poll(() => page.evaluate(() => (window as unknown as { __sent: string[] }).__sent), { timeout: 120_000 }).toEqual(['Mobile Engineer', 'SDE 2 - React Native']);
  const msgs = () => sw.evaluate(async () => (((await chrome.storage.session.get('fpLogs')).fpLogs ?? []) as { msg: string }[]).map((e) => e.msg));
  await expect.poll(async () => (await msgs()).filter((m) => m.startsWith('auto-submit: pressing "Submit application"')).length, { timeout: 10_000 }).toBe(2);
  // Both counted as sent although LinkedIn closed the dialog, so the limits hold.
  await expect.poll(async () => (await msgs()).filter((m) => m.includes('LinkedIn closed the dialog after Submit')).length, { timeout: 10_000 }).toBe(2);
  expect(await sw.evaluate(async () => ((await chrome.storage.local.get('fpQueueDay')).fpQueueDay as { n: number }).n)).toBe(2);
});

test('LinkedIn checkbox list, City typeahead, start date; and your own answer is remembered for next time', async ({ context, sw }) => {
  await configure(sw, { tracker: { enabled: true, url: 'http://localhost:4176', autoRecord: false, includeAnswers: false, walkToSubmit: false }, behavior: { enabled: false }, cache: { learn: 'auto' } });
  const page = await context.newPage();
  await page.goto('http://localhost:4173/apply-checkbox-live.html');
  const fill = () => sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'http://localhost:4173/apply-checkbox-live.html' });
    await chrome.tabs.sendMessage(tab.id!, { type: 'command', name: 'fill-form', via: 'toolbar' });
  });
  await page.click('#easy');
  await fill();
  const ticked = () => page.evaluate(() => [...document.querySelectorAll<HTMLInputElement>('#ind input')].filter((b) => b.checked).map((b) => b.getAttribute('aria-label')));
  await expect.poll(ticked, { timeout: 20_000 }).toEqual(['E-Commerce', 'IT/Tech']);
  // Typed "Indore", then picked from the suggestions (the site rejects a typed-only city).
  await expect.poll(() => page.evaluate(() => (document.getElementById('city') as HTMLInputElement).dataset.picked), { timeout: 10_000 }).toBe('1');
  expect(await page.locator('#city').inputValue()).toBe('Indore, Madhya Pradesh, India');
  // The mock AI would say 2025-03-01; the rule gives today + 30 days instead.
  const start = await page.locator('#start').inputValue();
  expect(new Date(start).getTime()).toBeGreaterThan(Date.now());
  // The AI had no answer to "worked for us before?": you pick No yourself, FormPilot remembers.
  expect(await page.locator('#wb-n').isChecked()).toBe(false);
  await page.locator('#wb-n').check();
  const msgs = () => sw.evaluate(async () => (((await chrome.storage.session.get('fpLogs')).fpLogs ?? []) as { msg: string }[]).map((e) => e.msg));
  await expect.poll(async () => (await msgs()).some((m) => m.startsWith('you answered "Have you worked for Wing Assistant before?" yourself')), { timeout: 10_000 }).toBe(true);
  // Next application with the same question: answered from what you picked, no AI needed.
  await page.reload();
  await page.click('#easy');
  await page.waitForTimeout(800);
  await fill();
  await expect.poll(() => page.locator('#wb-n').isChecked(), { timeout: 20_000 }).toBe(true);
});

test('autopilot: opens its own unfocused window, runs a dry-run batch on the job list, sends nothing', async ({ context, sw, extId }) => {
  test.setTimeout(180_000);
  await configure(sw, {
    tracker: { enabled: true, url: 'http://localhost:4176', autoRecord: true, includeAnswers: true, walkToSubmit: false, queueDailyCap: 10, queueDelaySec: 0, queueSkipTitles: 'Engineering Manager' },
    behavior: { enabled: false },
    autopilot: { titles: 'Mobile Engineer', dryRun: true, batchMin: 1, batchMax: 1, pauseMinSec: 1, pauseMaxSec: 2, skipWords: '', startTime: '00:00', endTime: '24:00', days: [0, 1, 2, 3, 4, 5, 6], searchUrl: 'http://localhost:4173/linkedin-list.html?q={title}' },
  });
  await sw.evaluate(() => chrome.storage.local.remove(['fpAutopilot', 'fpQueueDay']));
  const ui = await context.newPage();
  await ui.goto(`chrome-extension://${extId}/popup.html`);
  const before = context.pages().length;
  await ui.evaluate(() => chrome.runtime.sendMessage({ type: 'autopilot', action: 'start' }));
  // Its own window, with the search for the first title.
  await expect.poll(() => context.pages().some((p) => p.url().includes('linkedin-list.html?q=Mobile')), { timeout: 15_000 }).toBe(true);
  expect(context.pages().length).toBeGreaterThan(before);
  const win = await sw.evaluate(async () => {
    const st = (await chrome.storage.local.get('fpAutopilot')).fpAutopilot as { windowId: number };
    return chrome.windows.get(st.windowId);
  });
  expect(win.focused).toBe(false);
  const list = context.pages().find((p) => p.url().includes('linkedin-list.html?q=Mobile'))!;
  // One dry-run batch: one job filled to Submit, recorded as "would apply", nothing sent.
  const state = () => sw.evaluate(async () => (await chrome.storage.local.get('fpAutopilot')).fpAutopilot as { day: { dry: number; sent: number }; phase: string; message: string });
  // While it works, the live status says what it's doing in that window.
  await expect.poll(async () => ((await state()) as { progress?: { text: string } }).progress?.text ?? '', { timeout: 90_000 }).toMatch(/Reading|Filling|Opening/);
  await expect.poll(async () => (await state()).day.dry, { timeout: 120_000 }).toBe(1);
  // The Autopilot page shows the break and offers to skip it.
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extId}/options.html#autopilot`);
  await expect(page.getByText('Break between batches', { exact: true }).first()).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('button', { name: /Skip break/ })).toBeEnabled();
  await page.close();
  expect((await state()).day.sent).toBe(0);
  expect((await state()).phase).toBe('waiting');
  expect(await list.evaluate(() => (window as unknown as { __sent: string[] }).__sent)).toEqual([]);
  // FormPilot restarts (an update, a Brave restart) and its alarms are gone: on start-up it
  // picks up again by itself (the worker runs resume() when it starts).
  await sw.evaluate(() => chrome.alarms.clearAll());
  await ui.evaluate(() => chrome.runtime.sendMessage({ type: 'autopilot', action: 'resume' }));
  await expect.poll(() => sw.evaluate(async () => !!((await chrome.alarms.get('fp-ap-tick')) || (await chrome.alarms.get('fp-ap-go')))), { timeout: 15_000 }).toBe(true);
  // Stop: nothing more is scheduled.
  await ui.evaluate(() => chrome.runtime.sendMessage({ type: 'autopilot', action: 'stop' }));
  await expect.poll(async () => (await state()).phase, { timeout: 5000 }).toBe('stopped');
  expect(await sw.evaluate(() => chrome.alarms.get('fp-ap-tick'))).toBeFalsy();
  expect(await sw.evaluate(() => chrome.alarms.get('fp-ap-go'))).toBeFalsy();
});


test('autopilot on Naukri (live: Apply + chatbot) then Cutshort (dry run: form filled, closed unsent)', async ({ context, sw, extId }) => {
  test.setTimeout(330_000);
  await configure(sw, {
    tracker: { enabled: true, url: 'http://localhost:4176', autoRecord: false, includeAnswers: true, walkToSubmit: false },
    behavior: { enabled: false },
    autopilot: {
      titles: 'React Native Developer',
      batchMin: 1,
      batchMax: 1,
      gapMinMin: 30,
      gapMaxMin: 30,
      startTime: '00:00',
      endTime: '24:00',
      days: [0, 1, 2, 3, 4, 5, 6],
      skipWords: '',
      linkedinEnabled: false,
      naukri: { enabled: true, dryRun: false, dailyCap: 5, maxExpMin: 5, mode: 'search' },
      cutshort: { enabled: true, dryRun: true, dailyCap: 5, maxExpMin: 5 },
      searchUrl: 'http://localhost:4173/{platform}-search.html?q={title}',
    },
  });
  await sw.evaluate(() => chrome.storage.local.remove(['fpAutopilot']));
  const ui = await context.newPage();
  await ui.goto(`chrome-extension://${extId}/popup.html`);
  await ui.evaluate(() => chrome.runtime.sendMessage({ type: 'autopilot', action: 'start' }));
  type St = { day: { byPlatform: Record<string, { sent: number; dry: number; skipped: number }>; seen: string[] }; phase: string; history: { msg: string }[] };
  const state = () => sw.evaluate(async () => (await chrome.storage.local.get('fpAutopilot')).fpAutopilot as St);
  // Naukri: the relevant job only (Operations Manager is off-topic, 8+ years is too senior).
  await expect.poll(async () => (await state()).day.byPlatform.naukri.sent, { timeout: 150_000 }).toBe(1);
  const nk = context.pages().find((p) => p.url().includes('naukri-job.html'))!;
  const ans = await nk.evaluate(() => (window as unknown as { __answers: string[] }).__answers);
  expect(ans[0]).toMatch(/^3\b/); // years of React Native
  expect(ans[1]).toBe('Yes'); // relocating
  expect((await state()).day.seen.filter((u) => u.includes('naukri-job'))).toHaveLength(1);
  // Skip the break: Cutshort is next.
  await expect.poll(async () => (await state()).phase, { timeout: 10_000 }).toBe('waiting');
  await ui.evaluate(() => chrome.runtime.sendMessage({ type: 'autopilot', action: 'run-now' }));
  await expect.poll(async () => (await state()).day.byPlatform.cutshort.dry, { timeout: 150_000 }).toBe(1);
  const cs = context.pages().find((p) => p.url().includes('cutshort-job.html'))!;
  expect(await cs.evaluate(() => (window as unknown as { __applied: boolean }).__applied)).toBe(false);
  expect(await cs.evaluate(() => (window as unknown as { __other: boolean }).__other)).toBe(false); // the similar job's "Apply now" was never pressed
  expect(await cs.locator('[role=dialog]').count()).toBe(0);
  const hist = (await state()).history.map((h) => h.msg).join('\n');
  expect(hist).toContain('Naukri · Applied: React Native Developer - Wissen');
  expect(hist).toContain('Cutshort · Would apply: Junior React Native Developer');
  await ui.evaluate(() => chrome.runtime.sendMessage({ type: 'autopilot', action: 'stop' }));
});

test('autopilot: when the AI\'s daily quota is used up, it waits for the reset instead of skipping jobs', async ({ context, sw, extId }) => {
  test.setTimeout(180_000);
  await configure(sw, {
    tracker: { enabled: true, url: 'http://localhost:4176', autoRecord: false, includeAnswers: false, walkToSubmit: false, queueSkipTitles: 'Engineering Manager' },
    behavior: { enabled: false },
    autopilot: { titles: 'Mobile Engineer', dryRun: true, batchMin: 2, batchMax: 2, pauseMinSec: 1, pauseMaxSec: 2, skipWords: '', startTime: '00:00', endTime: '24:00', days: [0, 1, 2, 3, 4, 5, 6], searchUrl: 'http://localhost:4173/linkedin-list.html?q={title}' },
  });
  await fetch(`${LLM}/quota-used-up`);
  await sw.evaluate(() => chrome.storage.local.remove(['fpAutopilot', 'fpQueueDay']));
  const ui = await context.newPage();
  await ui.goto(`chrome-extension://${extId}/popup.html`);
  await ui.evaluate(() => chrome.runtime.sendMessage({ type: 'autopilot', action: 'start' }));
  type St = { phase: string; nextAt?: number; message: string; day: { skipped: number; dry: number } };
  const state = () => sw.evaluate(async () => (await chrome.storage.local.get('fpAutopilot')).fpAutopilot as St);
  await expect.poll(async () => (await state()).phase, { timeout: 120_000 }).toBe('ai-wait');
  const st = await state();
  expect(st.message).toMatch(/daily quota is used up/);
  // Waits until after the next midnight in California, and skipped nothing.
  expect(st.nextAt! - Date.now()).toBeGreaterThan(60 * 60_000);
  expect(st.day.skipped).toBe(0);
  expect(st.day.dry).toBe(0);
  await fetch(`${LLM}/reset`);
  await ui.evaluate(() => chrome.runtime.sendMessage({ type: 'autopilot', action: 'stop' }));
});

test('autopilot on Naukri Recommended jobs: ticks the jobs that fit (up to 5), presses Apply once, answers the chatbot, counts what Naukri confirms', async ({ context, sw, extId }) => {
  test.setTimeout(240_000);
  await configure(sw, {
    tracker: { enabled: true, url: 'http://localhost:4176', autoRecord: false, includeAnswers: true, walkToSubmit: false },
    behavior: { enabled: false },
    autopilot: {
      titles: 'React Native Developer, Mobile Engineer',
      batchMin: 3,
      batchMax: 3,
      startTime: '00:00',
      endTime: '24:00',
      days: [0, 1, 2, 3, 4, 5, 6],
      skipWords: '',
      linkedinEnabled: false,
      naukri: { enabled: true, dryRun: false, dailyCap: 5, maxExpMin: 5, mode: 'recommended', recUrl: 'http://localhost:4173/naukri-rec.html' },
      cutshort: { enabled: false, dryRun: true, dailyCap: 5, maxExpMin: 5 },
    },
  });
  await sw.evaluate(() => chrome.storage.local.remove(['fpAutopilot']));
  const ui = await context.newPage();
  await ui.goto(`chrome-extension://${extId}/popup.html`);
  await ui.evaluate(() => chrome.runtime.sendMessage({ type: 'autopilot', action: 'start' }));
  type St = { phase: string; day: { byPlatform: Record<string, { sent: number; dry: number; skipped: number }>; seen: string[] }; history: { msg: string }[] };
  const state = () => sw.evaluate(async () => (await chrome.storage.local.get('fpAutopilot')).fpAutopilot as St);
  // Angular is off-topic, 9+ years is too senior: the React Native job on the first tab.
  await expect.poll(async () => (await state()).day.byPlatform.naukri.sent, { timeout: 180_000 }).toBe(1);
  expect((await state()).history.map((h) => h.msg).join('\n')).toContain('Naukri · Applied: React Native Developer · Acme Apps');
  // The next batch (skip the break) takes the next tab's fitting job; the first isn't tried again.
  await expect.poll(async () => (await state()).phase, { timeout: 15_000 }).toBe('waiting');
  await ui.evaluate(() => chrome.runtime.sendMessage({ type: 'autopilot', action: 'run-now' }));
  await expect.poll(async () => (await state()).day.byPlatform.naukri.sent, { timeout: 150_000 }).toBe(2);
  const hist = (await state()).history.map((h) => h.msg).join('\n');
  expect(hist).toContain('Naukri · Applied: Mobile Engineer (React Native) · Zeta');
  expect(hist).not.toContain('Angular');
  expect((await state()).day.seen).toEqual(expect.arrayContaining(['naukri:12', 'naukri:14']));
  expect((await state()).phase).toBe('waiting');
  await ui.evaluate(() => chrome.runtime.sendMessage({ type: 'autopilot', action: 'stop' }));
});

test('apply queue works down a LinkedIn-style job list, stopping at Submit for the user each time', async ({ context, sw }) => {
  test.setTimeout(150_000);
  await configure(sw, {
    tracker: { enabled: true, url: 'http://localhost:4176', autoRecord: true, includeAnswers: true, walkToSubmit: true, queueDailyCap: 10, queueDelaySec: 0, queueSkipTitles: 'Engineering Manager' },
    behavior: { enabled: false },
  });
  await sw.evaluate(() => chrome.storage.local.remove('fpQueueDay'));
  const page = await context.newPage();
  await page.goto('http://localhost:4173/linkedin-list.html');
  await sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'http://localhost:4173/linkedin-list.html*' });
    await chrome.tabs.sendMessage(tab.id!, { type: 'command', name: 'apply-queue', via: 'toolbar' }, { frameId: 0 });
  });
  type W = { __dlgRoot: ShadowRoot | HTMLElement; __opened: string[]; __sent: string[]; __untrustedSubmit: boolean };
  const atSubmit = (company: string) =>
    page.evaluate((c) => {
      const r = (window as unknown as W).__dlgRoot;
      const send = r?.querySelector('#send') as HTMLElement | null;
      return !!send && (r.querySelector('h2')?.textContent ?? '').includes(c) && /3px/.test(send.style.outline);
    }, company);
  // The user presses Submit: a real (trusted) mouse click on the highlighted button.
  const pressSubmit = async () => {
    const box = await page.evaluate(() => {
      const r = (window as unknown as W).__dlgRoot.querySelector('#send')!.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await page.mouse.click(box.x, box.y);
  };
  await expect.poll(() => atSubmit('Acme'), { timeout: 60_000 }).toBe(true);
  await pressSubmit();
  await expect.poll(() => atSubmit('Beta'), { timeout: 60_000 }).toBe(true);
  await pressSubmit();
  await expect.poll(() => page.evaluate(() => (window as unknown as W).__sent), { timeout: 10_000 }).toEqual(['Mobile Engineer', 'SDE 2 - React Native']);
  // Skipped: already applied, no Easy Apply, and the skipped title. Never pressed Submit itself.
  expect(await page.evaluate(() => (window as unknown as W).__opened)).toEqual(['Mobile Engineer', 'SDE 2 - React Native']);
  expect(await page.evaluate(() => (window as unknown as W).__untrustedSubmit)).toBe(false);
  await expect(page.locator('formpilot-ui')).toHaveAttribute('data-toast', 'success', { timeout: 10_000 });
  await expect.poll(() => sw.evaluate(async () => ((await chrome.storage.local.get("fpQueueDay")).fpQueueDay as { n?: number } | undefined)?.n), { timeout: 10_000 }).toBe(2);
});

test('fits each answer to the field: units, numbers-only, ranges, date formats, phone', async ({ context, sw }) => {
  await configure(sw);
  const page = await context.newPage();
  await page.goto('http://localhost:4173/shapes.html');
  await page.click('#notice');
  await page.keyboard.press('Escape');
  await sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'http://localhost:4173/*' });
    await chrome.tabs.sendMessage(tab.id!, { type: 'command', name: 'fill-form' });
  });
  await expect(page.locator('#notice')).toHaveValue('30', { timeout: 15_000 }); // "30 days" in a days-only box
  await expect(page.locator('#ctc')).toHaveValue('10.75'); // "10,75,000" asked in lacs
  await expect(page.locator('#exp')).toHaveValue('c'); // "3+ years" → 3-5 years
  await expect(page.locator('#np2')).toHaveValue('1 Month'); // "30 days" → 1 Month
  await expect(page.locator('#lwd')).toHaveValue('151226'); // "15 Dec 2026" as DDMMYY
  await expect(page.locator('#mob')).toHaveValue('6264579927'); // 10-digit box
});
