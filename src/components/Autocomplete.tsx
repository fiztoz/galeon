import { useId, useRef, useState, type InputHTMLAttributes } from 'react';
import { createPortal } from 'react-dom';
import { Check } from 'lucide-react';
import { useChoicePopup } from './useChoicePopup';

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'list'> & {
  value: string;
  options: readonly string[];
  onValueChange: (value: string) => void;
};

/** Suggestions are optional: typing always preserves the exact custom value. */
export function Autocomplete({ value, options, onValueChange, ...props }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState(false);
  const [active, setActive] = useState(-1);
  const matches = filter ? options.filter(option => option.toLowerCase().includes(value.toLowerCase())) : options;
  const visible = open && matches.length > 0;
  const { menu, position } = useChoicePopup(input, visible, matches.length, active, setOpen);
  function show() { setFilter(false); setActive(-1); setOpen(true); }
  function choose(option: string) {
    onValueChange(option);
    setOpen(false);
    setActive(-1);
  }
  return <>
    <input {...props} ref={input} id={props.id ?? `${listId}-input`} value={value}
      role="combobox" aria-autocomplete="list" aria-haspopup="listbox" aria-expanded={visible}
      aria-controls={visible ? listId : undefined}
      aria-activedescendant={visible && active >= 0 && active < matches.length ? `${listId}-${active}` : undefined}
      autoComplete="off"
      onFocus={show} onClick={() => { if (!open) show(); }} onBlur={() => setOpen(false)}
      onChange={(event) => { onValueChange(event.target.value); setFilter(true); setActive(-1); setOpen(true); }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === 'Tab') { setOpen(false); return; }
        if (event.key === 'Escape' && open) {
          event.preventDefault(); event.stopPropagation(); setOpen(false); return;
        }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault(); event.stopPropagation();
          if (!visible) { show(); return; }
          setActive(event.key === 'ArrowDown' ? Math.min(matches.length - 1, active + 1) : active < 0 ? matches.length - 1 : Math.max(0, active - 1));
        } else if (event.key === 'Enter' && visible && active >= 0 && matches[active]) {
          event.preventDefault(); event.stopPropagation(); choose(matches[active]);
        }
      }} />
    {visible && createPortal(
      <div ref={menu} id={listId} role="listbox" aria-label="Region suggestions"
        className="galeon-select-menu galeon-scrollbar" style={position}
        onMouseDown={(event) => event.preventDefault()}>
        {matches.map((option, index) => <div key={option} id={`${listId}-${index}`} data-index={index}
          role="option" aria-selected={option === value} data-active={index === active}
          className="galeon-select-option" onPointerMove={() => setActive(index)} onClick={() => choose(option)}>
          <span>{option}</span>{option === value && <Check size={14} aria-hidden="true" />}
        </div>)}
      </div>, input.current?.closest('dialog') ?? document.body,
    )}
  </>;
}
