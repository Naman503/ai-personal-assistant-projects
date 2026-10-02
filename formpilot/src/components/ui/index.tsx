/**
 * Small design system for extension pages: shadcn-style primitives on Radix + Tailwind v4.
 */
import * as React from 'react';
import * as SwitchPrimitive from '@radix-ui/react-switch';
import * as SliderPrimitive from '@radix-ui/react-slider';
import * as SelectPrimitive from '@radix-ui/react-select';
import { Check, ChevronDown, Eye, EyeOff, Loader2 } from 'lucide-react';
import { cn } from './cn';

// ---------- Button ----------
type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger' | 'subtle';
type ButtonSize = 'sm' | 'md' | 'icon' | 'icon-sm';

const BTN_BASE =
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg font-medium transition-[background,color,box-shadow,border-color] duration-150 outline-none focus-visible:ring-2 focus-visible:ring-brand/40 disabled:pointer-events-none disabled:opacity-50 select-none';
const BTN_VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-brand text-white shadow-sm shadow-brand/20 hover:bg-brand/90 active:bg-brand/85',
  secondary: 'bg-zinc-900 text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white',
  outline:
    'border border-zinc-200 bg-white text-zinc-800 shadow-xs hover:bg-zinc-50 hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800/70',
  ghost: 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800/70 dark:hover:text-zinc-100',
  subtle: 'bg-brand/10 text-brand hover:bg-brand/15',
  danger: 'bg-red-600 text-white hover:bg-red-500',
};
const BTN_SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-[13px]',
  md: 'h-9 px-4 text-sm',
  icon: 'size-9',
  'icon-sm': 'size-7',
};

export const Button = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize; loading?: boolean }
>(({ className, variant = 'outline', size = 'sm', loading, children, disabled, ...p }, ref) => (
  <button ref={ref} className={cn(BTN_BASE, BTN_VARIANTS[variant], BTN_SIZES[size], className)} disabled={disabled || loading} {...p}>
    {loading && <Loader2 className="size-3.5 animate-spin" />}
    {children}
  </button>
));
Button.displayName = 'Button';

// ---------- Inputs ----------
const FIELD =
  'w-full rounded-lg border border-zinc-200 bg-white px-3 text-sm text-zinc-900 shadow-xs outline-none transition placeholder:text-zinc-400 focus:border-brand/60 focus:ring-3 focus:ring-brand/15 disabled:opacity-60 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100 dark:placeholder:text-zinc-500';

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(({ className, ...p }, ref) => (
  <input ref={ref} className={cn(FIELD, 'h-9', className)} {...p} />
));
Input.displayName = 'Input';

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...p }, ref) => (
  <textarea ref={ref} className={cn(FIELD, 'min-h-24 py-2 leading-relaxed', className)} {...p} />
));
Textarea.displayName = 'Textarea';

export function SecretInput({ value, onChange, placeholder, className }: { value: string; onChange: (v: string) => void; placeholder?: string; className?: string }) {
  const [show, setShow] = React.useState(false);
  return (
    <div className={cn('relative', className)}>
      <Input
        type={show ? 'text' : 'password'}
        value={value}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        className="pr-10 font-mono text-[13px]"
        onChange={(e) => onChange(e.target.value)}
      />
      <button
        type="button"
        className="absolute inset-y-0 right-0 grid w-9 place-items-center text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
        onClick={() => setShow((s) => !s)}
        aria-label={show ? 'Hide key' : 'Show key'}
      >
        {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      </button>
    </div>
  );
}

// ---------- Switch ----------
export function Switch({ checked, onCheckedChange, disabled, id }: { checked: boolean; onCheckedChange: (v: boolean) => void; disabled?: boolean; id?: string }) {
  return (
    <SwitchPrimitive.Root
      id={id}
      checked={checked}
      disabled={disabled}
      onCheckedChange={onCheckedChange}
      className="peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent bg-zinc-200 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-brand/40 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-brand dark:bg-zinc-700"
    >
      <SwitchPrimitive.Thumb className="pointer-events-none block size-4 translate-x-0.5 rounded-full bg-white shadow-sm ring-0 transition-transform data-[state=checked]:translate-x-[17px]" />
    </SwitchPrimitive.Root>
  );
}

// ---------- Slider ----------
export function Slider({
  value,
  onChange,
  min,
  max,
  step = 1,
  format,
  className,
}: {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  format?: (v: number) => string;
  className?: string;
}) {
  return (
    <div className={cn('flex w-full items-center gap-3', className)}>
      <SliderPrimitive.Root
        className="relative flex h-5 w-full touch-none items-center select-none"
        value={[value]}
        min={min}
        max={max}
        step={step}
        onValueChange={([v]) => onChange(v)}
      >
        <SliderPrimitive.Track className="relative h-1.5 grow overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
          <SliderPrimitive.Range className="absolute h-full bg-brand" />
        </SliderPrimitive.Track>
        <SliderPrimitive.Thumb className="block size-4 rounded-full border-2 border-brand bg-white shadow transition-shadow outline-none hover:ring-4 hover:ring-brand/15 focus-visible:ring-4 focus-visible:ring-brand/25" />
      </SliderPrimitive.Root>
      <span className="min-w-14 rounded-md bg-zinc-100 px-2 py-0.5 text-center font-mono text-xs text-zinc-700 tabular-nums dark:bg-zinc-800 dark:text-zinc-300">
        {format ? format(value) : value}
      </span>
    </div>
  );
}

// ---------- Select ----------
export interface Option<T extends string = string> {
  value: T;
  label: React.ReactNode;
  hint?: string;
}

export function Select<T extends string>({ value, onChange, options, className, placeholder }: { value: T; onChange: (v: T) => void; options: Option<T>[]; className?: string; placeholder?: string }) {
  return (
    <SelectPrimitive.Root value={value} onValueChange={(v) => onChange(v as T)}>
      <SelectPrimitive.Trigger className={cn(FIELD, 'flex h-9 items-center justify-between gap-2 text-left', className)}>
        <SelectPrimitive.Value placeholder={placeholder} />
        <SelectPrimitive.Icon>
          <ChevronDown className="size-4 text-zinc-400" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          position="popper"
          sideOffset={6}
          className="z-50 max-h-80 min-w-(--radix-select-trigger-width) overflow-hidden rounded-xl border border-zinc-200 bg-white p-1 shadow-xl shadow-zinc-900/10 dark:border-zinc-800 dark:bg-zinc-900"
        >
          <SelectPrimitive.Viewport>
            {options.map((o) => (
              <SelectPrimitive.Item
                key={o.value}
                value={o.value}
                className="relative flex cursor-default items-center rounded-lg py-2 pr-8 pl-2.5 text-sm outline-none select-none data-highlighted:bg-zinc-100 dark:data-highlighted:bg-zinc-800"
              >
                <div>
                  <SelectPrimitive.ItemText>{o.label}</SelectPrimitive.ItemText>
                  {o.hint && <div className="text-xs text-zinc-500">{o.hint}</div>}
                </div>
                <SelectPrimitive.ItemIndicator className="absolute right-2.5">
                  <Check className="size-4 text-brand" />
                </SelectPrimitive.ItemIndicator>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}

// ---------- Segmented control ----------
export function Segmented<T extends string>({ value, onChange, options, className }: { value: T; onChange: (v: T) => void; options: Option<T>[]; className?: string }) {
  return (
    <div role="radiogroup" className={cn('inline-flex rounded-lg border border-zinc-200 bg-zinc-100/70 p-0.5 dark:border-zinc-800 dark:bg-zinc-900', className)}>
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={value === o.value}
          title={o.hint}
          onClick={() => onChange(o.value)}
          className={cn(
            'rounded-md px-3 py-1 text-[13px] font-medium whitespace-nowrap text-zinc-500 transition-all hover:text-zinc-900 dark:hover:text-zinc-100',
            value === o.value && 'bg-white text-zinc-900 shadow-sm ring-1 ring-zinc-900/5 dark:bg-zinc-800 dark:text-zinc-50 dark:ring-white/5',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ---------- Layout ----------
export function Card({ className, children, ...p }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('rounded-2xl border border-zinc-200/80 bg-white shadow-xs dark:border-zinc-800/80 dark:bg-zinc-900/60', className)} {...p}>
      {children}
    </div>
  );
}

export function CardHeader({ title, description, icon, actions }: { title: React.ReactNode; description?: React.ReactNode; icon?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 border-b border-zinc-100 px-5 py-4 dark:border-zinc-800/80">
      {icon && <div className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-brand/10 text-brand">{icon}</div>}
      <div className="min-w-0 flex-1">
        <h3 className="text-[15px] font-semibold tracking-tight">{title}</h3>
        {description && <p className="mt-0.5 text-[13px] text-zinc-500 dark:text-zinc-400">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

/** A labelled settings row: label + description on the left, the control on the right. */
export function Row({ label, description, children, stacked, htmlFor }: { label: React.ReactNode; description?: React.ReactNode; children: React.ReactNode; stacked?: boolean; htmlFor?: string }) {
  return (
    <div className={cn('flex gap-6 px-5 py-4 not-last:border-b not-last:border-zinc-100 dark:not-last:border-zinc-800/70', stacked ? 'flex-col gap-3' : 'items-center justify-between')}>
      <div className="min-w-0 flex-1">
        <label htmlFor={htmlFor} className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
          {label}
        </label>
        {description && <p className="mt-0.5 text-[13px] leading-relaxed text-zinc-500 dark:text-zinc-400">{description}</p>}
      </div>
      <div className={cn(stacked ? 'w-full' : 'flex shrink-0 items-center justify-end', !stacked && 'max-w-[55%]')}>{children}</div>
    </div>
  );
}

export function Badge({ children, tone = 'neutral', className }: { children: React.ReactNode; tone?: 'neutral' | 'brand' | 'green' | 'amber' | 'red' | 'blue'; className?: string }) {
  const tones = {
    neutral: 'bg-zinc-100 text-zinc-600 ring-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:ring-zinc-700',
    brand: 'bg-brand/10 text-brand ring-brand/20',
    green: 'bg-emerald-50 text-emerald-700 ring-emerald-600/15 dark:bg-emerald-500/10 dark:text-emerald-400 dark:ring-emerald-500/20',
    amber: 'bg-amber-50 text-amber-700 ring-amber-600/15 dark:bg-amber-500/10 dark:text-amber-400 dark:ring-amber-500/20',
    red: 'bg-red-50 text-red-700 ring-red-600/15 dark:bg-red-500/10 dark:text-red-400 dark:ring-red-500/20',
    blue: 'bg-sky-50 text-sky-700 ring-sky-600/15 dark:bg-sky-500/10 dark:text-sky-400 dark:ring-sky-500/20',
  };
  return <span className={cn('inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset', tones[tone], className)}>{children}</span>;
}

export function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded-md border border-zinc-200 bg-white px-1.5 font-mono text-[11px] font-medium text-zinc-600 shadow-[0_1px_0_rgba(0,0,0,0.06)] dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
      {children}
    </kbd>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 max-w-2xl text-sm text-zinc-500 dark:text-zinc-400">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Empty({ icon, title, description, children }: { icon?: React.ReactNode; title: string; description?: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
      {icon && <div className="mb-3 grid size-11 place-items-center rounded-xl bg-zinc-100 text-zinc-400 dark:bg-zinc-800">{icon}</div>}
      <p className="text-sm font-medium">{title}</p>
      {description && <p className="mt-1 max-w-sm text-[13px] text-zinc-500">{description}</p>}
      {children && <div className="mt-4">{children}</div>}
    </div>
  );
}
