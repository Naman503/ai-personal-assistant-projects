/**
 * Which frame answers a command (Fill this form, open suggestions). Commands go to every frame.
 * The keyboard shortcut leaves focus in the page, so only the focused frame acts. The toolbar
 * popup and the right-click menu take focus away from the page: then the top frame acts, unless
 * the user was inside an iframe, in which case that iframe (whose field is still active) acts.
 */
export function frameShouldAct(o: { hasFocus: boolean; via?: string; isTop: boolean; activeTag?: string; activeIsField: boolean }): boolean {
  if (o.hasFocus) return true;
  if (o.via !== 'toolbar' && o.via !== 'context_menu') return false;
  const inIframe = o.activeTag === 'IFRAME' || o.activeTag === 'FRAME';
  return o.isTop ? !inIframe : o.activeIsField;
}
