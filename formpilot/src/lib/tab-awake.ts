/**
 * Keeps the autopilot's tab running at full speed while you use other apps.
 *
 * Brave hides a tab whose window is behind other windows (17 Nov: the autopilot tab was the front
 * tab of its window but reported `hidden` while you worked in other apps). A hidden page gets no
 * animation frames, and its timers are slowed to once a second and then once a minute. LinkedIn's
 * Easy Apply dialog and FormPilot's own step-by-step waits then crawl or stall: a 12-job batch took
 * 33 minutes, and Naukri jobs sat on one page until the watchdog moved on.
 *
 * Chromium's "emulate a focused page" setting (DevTools protocol) makes the page count as visible
 * and focused again. FormPilot turns it on for its own tab through chrome.debugger. It's only for
 * that tab, it survives moving between sites, and it's switched off when the autopilot stops.
 */
import { createLogger } from './logger';

const log = createLogger('tab-awake');

const noAttach = /not attached|no tab with given id|detached/i;

async function emulateFocus(tabId: number) {
  await chrome.debugger.sendCommand({ tabId }, 'Emulation.setFocusEmulationEnabled', { enabled: true });
}

/** Make the tab count as visible and focused. Returns false if the browser refused (e.g. DevTools is open on it). */
export async function keepTabAwake(tabId: number): Promise<boolean> {
  if (!chrome.debugger) return false;
  try {
    await emulateFocus(tabId);
    return true;
  } catch (e) {
    if (!noAttach.test(String((e as Error)?.message ?? e))) {
      log.warn('could not keep the autopilot tab awake', e);
      return false;
    }
  }
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    await emulateFocus(tabId);
    log.info('keeping the autopilot tab awake while its window is behind others');
    return true;
  } catch (e) {
    log.warn('could not keep the autopilot tab awake', e);
    return false;
  }
}

/** Hand the tab back to normal browser behaviour. */
export async function releaseTab(tabId: number | undefined) {
  if (tabId === undefined || !chrome.debugger) return;
  await chrome.debugger.detach({ tabId }).catch(() => {});
}
