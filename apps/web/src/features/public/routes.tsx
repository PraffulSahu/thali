/**
 * Public routes (Task 7): mounted at the root under <PublicShell> by src/routes.tsx.
 *   /  and  /welcome    landing, always (`/welcome` is an alias). Discover is the consumer area's `/discover`.
 *   /terms /privacy /refunds /help /partner-with-us /ride-with-thali
 */
import type { RouteObject } from 'react-router';

const page = (name: 'TermsPage' | 'PrivacyPage' | 'RefundsPage' | 'HelpPage' | 'PartnerWithUsPage' | 'RideWithThaliPage') => () =>
  import('./StaticPages').then((m) => ({ Component: m[name] }));

const landing = () => import('./LandingPage').then((m) => ({ Component: m.default }));

export const publicRoutes: RouteObject[] = [
  { index: true, lazy: landing },
  { path: 'welcome', lazy: landing },
  { path: 'terms', lazy: page('TermsPage') },
  { path: 'privacy', lazy: page('PrivacyPage') },
  { path: 'refunds', lazy: page('RefundsPage') },
  { path: 'help', lazy: page('HelpPage') },
  { path: 'partner-with-us', lazy: page('PartnerWithUsPage') },
  { path: 'ride-with-thali', lazy: page('RideWithThaliPage') },
];
