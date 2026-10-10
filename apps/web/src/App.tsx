/**
 * Provider stack: QueryClient -> Auth (boots the session) -> Toasts -> Router.
 */
import { QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { createBrowserRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { ToastProvider } from './components/ui/Toast';
import { AuthProvider } from './lib/auth';
import { createQueryClient } from './lib/query';
import { appRoutes } from './routes';

const router = createBrowserRouter(appRoutes);

export function App() {
  const [queryClient] = useState(createQueryClient);
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <ToastProvider>
          <RouterProvider router={router} />
        </ToastProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}
