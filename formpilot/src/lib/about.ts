/** Project credits, shown on the About page, in the settings sidebar and in the toolbar popup. */
export const AUTHOR = {
  name: 'Naman Pathak',
  initials: 'NP',
  role: 'Creator & developer',
  email: 'namanpathak503@gmail.com',
  repo: 'https://github.com/Naman503/ai-personal-assistant-projects/tree/main/formpilot',
  issues: 'https://github.com/Naman503/ai-personal-assistant-projects/issues/new',
} as const;

/** mailto: link with a prefilled subject and the version/browser (helps with bug reports). */
export function feedbackMailto(kind: 'feedback' | 'bug' = 'feedback'): string {
  const v = typeof chrome !== 'undefined' && chrome.runtime?.getManifest ? chrome.runtime.getManifest().version : '';
  const subject = kind === 'bug' ? `FormPilot bug report (v${v})` : `FormPilot feedback (v${v})`;
  const body = `\n\n---\nFormPilot v${v}\n${navigator.userAgent}`;
  return `mailto:${AUTHOR.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
