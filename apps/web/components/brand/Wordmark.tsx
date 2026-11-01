import { Mark } from './Mark';

type WordmarkProps = {
  className?: string;
  /** Hide the glyph and render only the lowercase "bootr" logotype. */
  textOnly?: boolean;
  size?: 'sm' | 'md' | 'nav' | 'lg';
};

const sizes = {
  sm: { mark: 16, text: 'text-[15px]', gap: 'gap-1.5' },
  md: { mark: 20, text: 'text-[18px]', gap: 'gap-2' },
  nav: { mark: 26, text: 'text-[24px]', gap: 'gap-2.5' },
  lg: { mark: 32, text: 'text-[30px]', gap: 'gap-3' },
} as const;

/** Lowercase Geist 600 logotype at -0.04em, paired with the square mark. */
export function Wordmark({ className = '', textOnly = false, size = 'md' }: WordmarkProps) {
  const s = sizes[size];
  return (
    <span className={`inline-flex items-center ${s.gap} text-ink ${className}`}>
      {textOnly ? null : <Mark size={s.mark} title="" />}
      <span className={`${s.text} font-semibold leading-none tracking-wordmark`}>bootr</span>
    </span>
  );
}
