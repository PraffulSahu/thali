/** Consumer tests run beside four other areas' suites; give async queries more headroom under parallel load. */
import { configure } from '@testing-library/react';

configure({ asyncUtilTimeout: 4000 });
