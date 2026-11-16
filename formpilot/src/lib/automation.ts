/**
 * FormPilot moving the cursor itself (the walker focusing a field that needs you, a repair
 * rewriting a value) must not look like the user clicking in: that opens the suggestion
 * popup and spends an AI request nobody asked for. Callers mark a short quiet window first.
 */
let quietUntil = 0;

export function quietFocus(ms = 1500) {
  quietUntil = Math.max(quietUntil, Date.now() + ms);
}

export const focusIsOurs = () => Date.now() < quietUntil;
