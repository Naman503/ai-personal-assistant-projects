# AI Personal Assistant Projects

A collection of AI-powered tools that take repetitive work off your hands. Each project lives in its own folder, with its own README, setup steps and tests.

## Projects

<table>
<tr>
<td width="120" align="center"><img src="formpilot/public/icon/128.png" width="72" alt="FormPilot" /></td>
<td>

### [FormPilot](formpilot/)
A Chrome and Brave extension that fills web forms with AI, grounded in your own documents. Suggestions appear right under the field, like a password manager.

- Works on ordinary forms, rich-text editors, modals and recruiter chat questionnaires (e.g. Naukri)
- Memory from your resume and notes, plus instant answers for questions it has seen before
- Free and local AI options: Gemini, Chrome built-in AI, OpenRouter, Groq, Ollama

**Stack:** TypeScript · React 19 · WXT (Manifest V3) · Tailwind CSS · Vitest · Playwright
→ [Read more](formpilot/README.md)

</td>
</tr>
<tr>
<td width="120" align="center"><img src="https://raw.githubusercontent.com/Naman503/typepilot/main/docs/images/icon.svg" width="72" alt="TypePilot" /></td>
<td>

### [TypePilot](https://github.com/Naman503/typepilot) <sub>(own repository)</sub>
AI that types with you in every app: instant answers from your own memory, AI suggestions as you type and one-tap rewrites, on Android (with any keyboard) and Mac.

- Several likely answers per field, each with a % for how sure it is, plus an AI answer for real questions
- Learns from what you type and from your documents; app-aware, private, with backup and restore
- Gemini, Groq, Ollama or 18 on-device models; a smart switch keeps payment apps working

**Stack:** Kotlin · Jetpack Compose · LiteRT-LM · Swift / AppKit
→ [Download the APK](https://github.com/Naman503/typepilot/releases/latest)

</td>
</tr>
</table>

## Repository layout

```
ai-personal-assistant-projects/
└─ formpilot/        # AI form-filling browser extension
```

## License

[MIT](LICENSE)
