// @vitest-environment happy-dom
import { describe, expect, it, beforeEach } from 'vitest';
import { profileState, readHiringTeam } from '@/entrypoints/content/linkedin-outreach';

const hiring = `
<main>
  <h1>React Native Developer</h1>
  <div class="job-details-people-who-can-help__section--two-pane">
    <h2>Meet the hiring team</h2>
    <div class="display-flex">
      <a href="https://www.linkedin.com/in/Priya-Sharma-12ab/?trk=x">
        <strong>Priya Sharma</strong>
      </a>
      <span>
        · 2nd
      </span>
      <div>
        Senior Technical Recruiter at Acme
      </div>
      <span>
        Job poster
      </span>
      <button>Message</button>
    </div>
  </div>
  <a href="https://www.linkedin.com/in/someone-else/">Someone in the feed</a>
</main>`;

const profile = (actions: string, degree = '2nd') => `
<main><section>
  <h1>Priya Sharma</h1>
  <span class="dist-value">${degree}</span>
  <div>${actions}</div>
</section></main>`;

describe('LinkedIn outreach: hiring team', () => {
  beforeEach(() => (document.body.innerHTML = ''));
  it('reads name, title and profile from Meet the hiring team', () => {
    document.body.innerHTML = hiring;
    const team = readHiringTeam(document);
    expect(team).toHaveLength(1);
    expect(team[0]).toEqual({ name: 'Priya Sharma', title: 'Senior Technical Recruiter at Acme', profile: 'https://www.linkedin.com/in/priya-sharma-12ab/' });
  });
  it('ignores profile links outside the hiring team block', () => {
    document.body.innerHTML = `<main><h1>Job</h1><a href="https://www.linkedin.com/in/x/">X</a></main>`;
    expect(readHiringTeam(document)).toEqual([]);
  });
});

describe('LinkedIn outreach: profile state', () => {
  it('can connect from the card', () => {
    document.body.innerHTML = profile(`<button aria-label="Invite Priya Sharma to connect">Connect</button><button aria-label="More actions">More</button>`);
    const s = profileState(document);
    expect(s.state).toBe('can-connect');
    expect(s.connect?.textContent).toBe('Connect');
  });
  it('can connect through More when Connect is hidden', () => {
    document.body.innerHTML = profile(`<button>Follow</button><button aria-label="More actions">More</button>`);
    expect(profileState(document)).toMatchObject({ state: 'can-connect', connect: undefined });
  });
  it('sees a pending invite', () => {
    document.body.innerHTML = profile(`<button aria-label="Pending, click to withdraw invitation sent to Priya Sharma">Pending</button>`);
    expect(profileState(document).state).toBe('pending');
  });
  it('sees a 1st-degree connection and its Message button', () => {
    document.body.innerHTML = profile(`<button aria-label="Message Priya Sharma">Message</button><button aria-label="More actions">More</button>`, '1st');
    const s = profileState(document);
    expect(s.state).toBe('connected');
    expect(s.message).toBeTruthy();
  });
});
