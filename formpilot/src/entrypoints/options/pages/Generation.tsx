import { Wand2, Gauge, FileSearch, UserRound } from 'lucide-react';
import { Card, CardHeader, Input, PageHeader, Row, Segmented, Select, Slider, Switch, Textarea } from '@/components/ui';
import type { PageProps } from '../App';

const LANGS = ['auto', 'English', 'Hindi', 'Spanish', 'French', 'German', 'Portuguese', 'Japanese', 'Chinese', 'Arabic'];

export function Generation({ settings, update }: PageProps) {
  const g = settings.generation;
  const set = <K extends keyof typeof g>(k: K, v: (typeof g)[K]) => update((d) => void (d.generation[k] = v));

  return (
    <>
      <PageHeader title="Generation" description="How FormPilot writes answers. By default the AI decides the length from the question and the field." />

      <Card className="mb-5">
        <CardHeader icon={<Wand2 className="size-4" />} title="Answer style" />
        <Row label="Suggestions per field" description="Distinct options to choose from. Factual fields (email, phone…) always get one.">
          <Slider className="w-64" value={g.numSuggestions} min={1} max={5} onChange={(v) => set('numSuggestions', v)} />
        </Row>
        <Row label="Length" description="Auto lets the model judge: a few words for a name, a paragraph for an essay question.">
          <Segmented
            value={g.length}
            onChange={(v) => set('length', v)}
            options={[
              { value: 'auto', label: 'Auto' },
              { value: 'short', label: 'Short' },
              { value: 'medium', label: 'Medium' },
              { value: 'long', label: 'Long' },
            ]}
          />
        </Row>
        <Row label="Tone">
          <Select
            className="w-52"
            value={g.tone}
            onChange={(v) => set('tone', v)}
            options={['auto', 'professional', 'friendly', 'formal', 'casual', 'confident', 'concise'].map((t) => ({ value: t as typeof g.tone, label: t[0].toUpperCase() + t.slice(1) }))}
          />
        </Row>
        <Row label="Language" description="Auto replies in the form's language.">
          <Select className="w-52" value={g.language} onChange={(v) => set('language', v)} options={LANGS.map((l) => ({ value: l, label: l === 'auto' ? 'Same as form' : l }))} />
        </Row>
        <Row
          label="Grounding"
          description={
            g.grounding === 'strict'
              ? 'Only uses what is in your memory. It says when something is missing instead of guessing.'
              : g.grounding === 'balanced'
                ? 'Facts come only from memory; open questions get natural prose built on it. Recommended.'
                : 'May make plausible inferences for open questions. Still never invents contact details or numbers.'
          }
        >
          <Segmented
            value={g.grounding}
            onChange={(v) => set('grounding', v)}
            options={[
              { value: 'strict', label: 'Strict' },
              { value: 'balanced', label: 'Balanced' },
              { value: 'creative', label: 'Creative' },
            ]}
          />
        </Row>
      </Card>

      <Card className="mb-5">
        <CardHeader icon={<UserRound className="size-4" />} title="Personalisation" description="Always included in the instructions." />
        <Row label="About you" description="A sentence or two the AI should always know, e.g. your role and goals." stacked>
          <Textarea rows={3} value={g.persona} placeholder="Senior frontend engineer with 6 years in React and TypeScript, applying for remote product roles." onChange={(e) => set('persona', e.target.value)} />
        </Row>
        <Row label="Custom instructions" description="Rules for every answer." stacked>
          <Textarea rows={3} value={g.customInstructions} placeholder="Use British spelling. Never use exclamation marks. Keep cover letters under 200 words." onChange={(e) => set('customInstructions', e.target.value)} />
        </Row>
      </Card>

      <Card className="mb-5">
        <CardHeader icon={<FileSearch className="size-4" />} title="Page context" description="What FormPilot reads from the website you're on." />
        <Row label="Read page content" description="Include the page's main text (e.g. the job description) so answers fit the context.">
          <Switch checked={g.includePageContext} onCheckedChange={(v) => set('includePageContext', v)} />
        </Row>
        {g.includePageContext && (
          <Row label="Page text budget" description="Characters of page text sent with each request.">
            <Slider className="w-64" value={g.pageContextChars} min={500} max={12000} step={500} onChange={(v) => set('pageContextChars', v)} format={(v) => `${(v / 1000).toFixed(1)}k`} />
          </Row>
        )}
        <Row label="Use other answers in the form" description="Send values you already filled in, so answers stay consistent.">
          <Switch checked={g.includeOtherFields} onCheckedChange={(v) => set('includeOtherFields', v)} />
        </Row>
      </Card>

      <Card>
        <CardHeader icon={<Gauge className="size-4" />} title="Model & performance" description="For power users." />
        <Row label="Temperature" description="Lower is more predictable. Gemini 3.x ignores this and uses its recommended default.">
          <Slider className="w-64" value={g.temperature} min={0} max={1.5} step={0.05} onChange={(v) => set('temperature', Math.round(v * 100) / 100)} format={(v) => v.toFixed(2)} />
        </Row>
        <Row label="Thinking" description="Gemini 3.x reasoning depth. Off is fastest and is plenty for forms.">
          <Segmented
            value={g.thinking}
            onChange={(v) => set('thinking', v)}
            options={[
              { value: 'off', label: 'Off' },
              { value: 'low', label: 'Low' },
              { value: 'medium', label: 'Medium' },
              { value: 'high', label: 'High' },
            ]}
          />
        </Row>
        <Row label="Max output tokens">
          <Slider className="w-64" value={g.maxOutputTokens} min={128} max={4096} step={128} onChange={(v) => set('maxOutputTokens', v)} />
        </Row>
        <Row label="Stream responses" description="Show text as it is generated. Turn off for providers with flaky streaming.">
          <Switch checked={g.streaming} onCheckedChange={(v) => set('streaming', v)} />
        </Row>
        <Row label="Timeout" description="Give up and show an error after this long.">
          <Slider className="w-64" value={g.timeoutMs} min={5000} max={120000} step={5000} onChange={(v) => set('timeoutMs', v)} format={(v) => `${v / 1000}s`} />
        </Row>
        <Row label="Retries per provider" description="For rate limits and temporary errors, with exponential backoff.">
          <Input type="number" min={0} max={5} className="w-20 text-center" value={g.maxRetries} onChange={(e) => set('maxRetries', Math.max(0, Math.min(5, Number(e.target.value) || 0)))} />
        </Row>
      </Card>
    </>
  );
}
