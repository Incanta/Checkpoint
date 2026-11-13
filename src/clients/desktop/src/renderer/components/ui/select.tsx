import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faChevronDown } from "@fortawesome/free-solid-svg-icons";

export interface SelectOption<V extends string | number> {
  label: string;
  value: V;
  disabled?: boolean;
}

export interface SelectProps<V extends string | number> {
  value: V | null | undefined;
  options: SelectOption<V>[];
  onChange: (value: V) => void;
  /** Shown (and unselectable) while `value` matches no option. */
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  id?: string;
  "aria-label"?: string;
}

/**
 * A styled native select. Values keep their type: a numeric option hands
 * back a number.
 */
export function Select<V extends string | number>({
  value,
  options,
  onChange,
  placeholder,
  disabled,
  className = "",
  id,
  "aria-label": ariaLabel,
}: SelectProps<V>): React.ReactElement {
  const index = options.findIndex((o) => o.value === value);
  return (
    <div className={`relative inline-flex min-w-0 ${className}`}>
      <select
        id={id}
        aria-label={ariaLabel}
        disabled={disabled}
        value={index >= 0 ? String(index) : ""}
        onChange={(e) => {
          const option = options[Number(e.target.value)];
          if (option) onChange(option.value);
        }}
        className="box-border w-full min-w-0 cursor-pointer appearance-none truncate rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] py-1.5 pl-2.5 pr-7 text-sm text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none disabled:cursor-default disabled:opacity-60"
      >
        {index < 0 && (
          <option value="" disabled>
            {placeholder ?? ""}
          </option>
        )}
        {options.map((option, i) => (
          <option key={i} value={String(i)} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
      <FontAwesomeIcon
        icon={faChevronDown}
        className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[0.65em] text-[var(--color-text-muted)]"
      />
    </div>
  );
}
