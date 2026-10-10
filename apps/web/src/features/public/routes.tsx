/**
 * Public routes (Task 7): mounted at the root under <PublicShell> by src/routes.tsx.
 *   /welcome            landing (always; `/` shows it too until a delivery location is chosen)
 *   /terms /privacy /refunds /help /partner-with-us /ride-with-thali
 */
import type { RouteObject } from 'react-router';

const page = (name: 'TermsPage' | 'PrivacyPage' | 'RefundsPage' | 'HelpPage' | 'PartnerWithUsPage' | 'RideWithThaliPage') => () =>
  import('./StaticPages').then((m) => ({ Component: m[name] }));

export const publicRoutes: RouteObject[] = [
  { path: 'welcome', lazy: () => import('./LandingPage').then((m) => ({ Component: m.default })) },
  { path: 'terms', lazy: page('TermsPage') },
  { path: 'privacy', lazy: page('PrivacyPage') },
  { path: 'refunds', lazy: page('RefundsPage') },
  { path: 'help', lazy: page('HelpPage') },
  { path: 'partner-with-us', lazy: page('PartnerWithUsPage') },
  { path: 'ride-with-thali', lazy: page('RideWithThaliPage') },
];
