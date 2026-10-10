/**
 * Shared test setup for the web project. Import it FIRST in every web test file:
 *   import './setup';            (or '../setup' from a sub-folder)
 * The root vitest config has no per-project setupFiles, so this is explicit.
 * - registers @testing-library/jest-dom matchers (toBeInTheDocument, ...)
 * - unmounts rendered trees after each test (RTL auto-cleanup needs vitest globals, which are off)
 * - clears localStorage between tests
 */
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
  localStorage.clear();
});
