import { Select } from './Select';

const hours = Array.from({ length: 24 }, (_, value) => String(value).padStart(2, '0'));
const minutes = Array.from({ length: 60 }, (_, value) => String(value).padStart(2, '0'));

/** A 24-hour time field using the same themed menus as other choice controls. */
export function TimeField({ value, onValueChange, label }: {
  value: string;
  onValueChange: (value: string) => void;
  label: string;
}) {
  const [hour, minute] = value.split(':');
  const field = 'min-w-0 flex-1 rounded-lg border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm text-zinc-100 tabular-nums';
  return <div role="group" aria-label={label} className="flex min-w-0 items-center gap-1">
    <Select aria-label={`${label} hour`} value={hour} onValueChange={next => onValueChange(`${next}:${minute}`)} className={field}>
      {hours.map(part => <option key={part} value={part}>{part}</option>)}
    </Select>
    <span aria-hidden="true" className="text-zinc-500">:</span>
    <Select aria-label={`${label} minute`} value={minute} onValueChange={next => onValueChange(`${hour}:${next}`)} className={field}>
      {minutes.map(part => <option key={part} value={part}>{part}</option>)}
    </Select>
  </div>;
}
