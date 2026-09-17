import { Children, isValidElement, useEffect, useId, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';

type Props = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'value' | 'defaultValue' | 'onChange'> & {
  value?: string | number;
  defaultValue?: string | number;
  onValueChange: (value: string) => void;
  children: ReactNode;
};

/** Select-only combobox. Keep focus on the trigger, including inside modal dialogs. */
export function Select({ value, defaultValue, onValueChange, children, className = '', ...props }: Props) {
  const options = Children.toArray(children).flatMap((child) => {
    if (!isValidElement<{ value: string | number; children: ReactNode; disabled?: boolean }>(child)) return [];
    return [{ value: String(child.props.value), label: Children.toArray(child.props.children).join(''), disabled: !!child.props.disabled }];
  });
  const [internal, setInternal] = useState(String(defaultValue ?? options[0]?.value ?? ''));
  const selected = String(value ?? internal);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [position, setPosition] = useState({ left: 0, top: 0, width: 0, maxHeight: 280 });
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const search = useRef({ text: '', time: 0 });
  const listId = useId();
  const selectedIndex = options.findIndex((option) => option.value === selected);
  const enabled = options.flatMap((option, index) => option.disabled ? [] : [index]);

  function show() {
    if (!enabled.length) return;
    trigger.current?.focus();
    setActive(enabled.includes(selectedIndex) ? selectedIndex : enabled[0]);
    search.current.text = '';
    setOpen(true);
  }
  function choose(index: number) {
    const option = options[index];
    if (!option || option.disabled) return;
    setInternal(option.value);
    setOpen(false);
    trigger.current?.focus();
    if (option.value !== selected) onValueChange(option.value);
  }

  useLayoutEffect(() => {
    if (!open || !trigger.current) return;
    const rect = trigger.current.getBoundingClientRect();
    const below = window.innerHeight - rect.bottom - 12;
    const above = rect.top - 12;
    const height = Math.min(280, options.length * 36 + 12);
    const upward = below < height && above > below;
    const maxHeight = Math.max(36, Math.min(height, upward ? above : below));
    const width = Math.min(Math.max(rect.width, 200), window.innerWidth - 24);
    setPosition({ left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)), top: upward ? rect.top - maxHeight - 6 : rect.bottom + 6, width, maxHeight });
  }, [open, options.length]);

  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!trigger.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) setOpen(false);
    };
    const dismiss = (event: Event) => {
      if (!menu.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    window.addEventListener('resize', dismiss);
    document.addEventListener('scroll', dismiss, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      window.removeEventListener('resize', dismiss);
      document.removeEventListener('scroll', dismiss, true);
    };
  }, [open]);

  return <>
    <button
      {...props}
      id={props.id ?? `${listId}-trigger`}
      ref={trigger}
      type="button"
      role="combobox"
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-controls={open ? listId : undefined}
      aria-activedescendant={open ? `${listId}-${active}` : undefined}
      className={`galeon-select ${className}`}
      onClick={() => open ? setOpen(false) : show()}
      onBlur={() => setOpen(false)}
      onKeyDown={(event) => {
        if (event.key === 'Tab') { setOpen(false); return; }
        if (event.key === 'Escape' && open) {
          event.preventDefault(); event.stopPropagation(); setOpen(false); return;
        }
        if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(event.key)) {
          event.preventDefault(); event.stopPropagation();
          if (!open) { show(); return; }
          if (event.key === 'Enter' || event.key === ' ') { choose(active); return; }
          const cursor = enabled.indexOf(active);
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? enabled.length - 1
            : Math.max(0, Math.min(enabled.length - 1, cursor + (event.key === 'ArrowDown' ? 1 : -1)));
          if (enabled[next] !== undefined) setActive(enabled[next]);
        } else if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
          event.preventDefault(); event.stopPropagation();
          const now = Date.now();
          const text = (now - search.current.time < 700 ? search.current.text : '') + event.key.toLowerCase();
          search.current = { text, time: now };
          const prefix = [...text].every((char) => char === text[0]) ? text[0] : text;
          const start = open ? active : selectedIndex;
          const ordered = [...enabled.filter((i) => i > start), ...enabled.filter((i) => i <= start)];
          const match = ordered.find((i) => options[i].label.toLowerCase().startsWith(prefix));
          if (match !== undefined) { setActive(match); setOpen(true); }
        }
      }}
    >
      <span className="truncate">{options[selectedIndex]?.label ?? 'Select…'}</span>
      <ChevronDown size={14} aria-hidden="true" className="galeon-select-chevron" />
    </button>
    {open && createPortal(
      <div ref={menu} id={listId} role="listbox" aria-labelledby={props.id ?? `${listId}-trigger`}
        className="galeon-select-menu galeon-scrollbar" style={position}
        onMouseDown={(event) => event.preventDefault()}>
        {options.map((option, index) => <div
          key={option.value} id={`${listId}-${index}`} data-index={index}
          role="option" aria-selected={option.value === selected} aria-disabled={option.disabled || undefined}
          data-active={index === active} className="galeon-select-option"
          onPointerMove={() => !option.disabled && setActive(index)}
          onClick={() => choose(index)}>
          <span>{option.label}</span>
          {option.value === selected && <Check size={14} aria-hidden="true" />}
        </div>)}
      </div>, trigger.current?.closest('dialog') ?? document.body,
    )}
  </>;
}
