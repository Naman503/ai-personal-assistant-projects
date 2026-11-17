/**
 * Naukri, main world, before the page's own scripts: when Site Pilot presses "Apply on company
 * site" it sets `data-fp-capture-open` on <html>; while that is set, the link Naukri tries to open
 * in a new tab is recorded (data-fp-opened + sessionStorage) instead of opened. With the
 * attribute unset (your own clicks) nothing changes.
 */
export default defineContentScript({
  matches: ['*://*.naukri.com/*'],
  runAt: 'document_start',
  world: 'MAIN',
  main() {
    const html = () => document.documentElement;
    const capturing = () => html()?.getAttribute('data-fp-capture-open') === '1';
    const record = (u: unknown) => {
      let url = '';
      try {
        url = new URL(String(u), location.href).href;
      } catch {
        return false;
      }
      if (!/^https?:/i.test(url)) return false;
      try {
        sessionStorage.setItem('fpOpened', url);
      } catch {
        /* storage off */
      }
      html()?.setAttribute('data-fp-opened', url);
      return true;
    };
    const open = window.open;
    window.open = function (this: Window, url?: string | URL, ...rest: [string?, string?]) {
      if (capturing() && url && record(url)) return null;
      return open.call(this, url, ...rest);
    } as typeof window.open;
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      if (capturing() && this.target === '_blank' && this.href && record(this.href)) return;
      return click.call(this);
    };
    document.addEventListener(
      'click',
      (e) => {
        if (!capturing()) return;
        const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
        if (a && a.target === '_blank' && !/naukri\.com/i.test(a.href) && record(a.href)) e.preventDefault();
      },
      true,
    );
  },
});
