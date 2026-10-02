import 'fake-indexeddb/auto';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { beforeEach } from 'vitest';
import { configureLogger } from '@/lib/logger';

// Our code uses the `chrome.*` namespace directly; point it at WXT's in-memory fake.
(globalThis as unknown as { chrome: unknown }).chrome = fakeBrowser;
configureLogger({ console: false });

beforeEach(() => {
  fakeBrowser.reset();
});
