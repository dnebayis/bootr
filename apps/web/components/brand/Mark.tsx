import { useId } from 'react';

type MarkProps = {
  size?: number;
  className?: string;
  title?: string;
};

/**
 * The Bootr mark: a solid square with a squared power glyph knocked out of it.
 * The glyph is a vertical "on" stroke dropping into an open-topped square, read as
 * "power on" / "boot". Drawn on a 24-unit grid with 2.5-unit strokes so it survives
 * a 16px favicon. Uses currentColor, so it inverts with the theme.
 */
export function Mark({ size = 20, className, title = 'Bootr' }: MarkProps) {
  const id = useId();
  const maskId = `bootr-mark-${id}`;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      role="img"
      aria-label={title}
      className={className}
    >
      <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
        <rect width="24" height="24" fill="#fff" />
        <path d="M12 4.75V12" stroke="#000" strokeWidth="2.5" strokeLinecap="square" />
        <path
          d="M8.75 7.75H6.75V17.25H17.25V7.75H15.25"
          stroke="#000"
          strokeWidth="2.5"
          strokeLinecap="square"
        />
      </mask>
      <rect width="24" height="24" rx="5" fill="currentColor" mask={`url(#${maskId})`} />
    </svg>
  );
}
