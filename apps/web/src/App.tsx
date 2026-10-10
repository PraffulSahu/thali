/**
 * Provider stack: Theme -> QueryClient -> Auth (boots the session) -> Toasts -> Router.
 */
import { QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { RouterProvider } from 'react-router/dom';
import { ToastProvider } from './components/ui/Toast';
import { AuthProvider } from './lib/auth';
import { ThemeProvider } from './lib/theme';
import { createQueryClient } from './lib/query';
import { createAppRouter } from './routes';

const router = createAppRouter();

export function App() {
  const [queryClient] = useState(createQueryClient);
  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <ToastProvider>
            <RouterProvider router={router} />
          </ToastProvider>
        </AuthProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
