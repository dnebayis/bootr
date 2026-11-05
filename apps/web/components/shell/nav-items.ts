export const NAV_ITEMS = [
  { href: '/', label: 'Tokens' },
  { href: '/leaderboards', label: 'Leaderboards' },
  { href: '/launch', label: 'Launch' },
  { href: '/analytics', label: 'Analytics' },
  { href: '/docs', label: 'Docs' },
  { href: '/skill', label: 'Skill' },
  { href: '/profile', label: 'Profile' },
] as const;

export function isActive(pathname: string, href: string) {
  if (href === '/') return pathname === '/' || pathname.startsWith('/token/');
  return pathname === href || pathname.startsWith(`${href}/`);
}
