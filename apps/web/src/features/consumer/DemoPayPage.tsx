/**
 * Demo payment page (mock provider only; payments mounts `/demo-pay/*` only when PAYMENT_PROVIDER=mock and
 * production refuses mock). "Success" / "Failure" make the payments service emit signed mock webhooks into the
 * normal pipeline; we then go to the status page, which waits for the server — this page never marks paid.
 */
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { Badge, Button, ButtonLink, Card, EmptyState, InlineError, PageHeader, Price, QueryState, Skeleton } from '../../components/ui';
import { isNotFound } from '../../lib/errors';
import { completeDemoPay, fetchDemoPay, type DemoPayView } from './api';

const safeReturn = (v: string | null) => (v && v.startsWith('/') && !v.startsWith('//') ? v : null);

export function returnPathFor(d: Pick<DemoPayView, 'purpose' | 'referenceId' | 'paymentIntentId'>, requested: string | null): string {
  return safeReturn(requested) ?? (d.purpose === 'CHECKOUT' ? `/checkout/status/${d.referenceId}` : `/membership?payment=${d.paymentIntentId}`);
}

export default function DemoPayPage() {
  const { intentId = '' } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ['demo-pay', intentId], queryFn: () => fetchDemoPay(intentId), retry: false });
  const complete = useMutation({
    mutationFn: (outcome: 'success' | 'failure') => completeDemoPay(intentId, outcome),
    onSuccess: () => q.data && navigate(returnPathFor(q.data, params.get('return')), { replace: true }),
  });

  if (q.isError && isNotFound(q.error)) {
    return (
      <EmptyState
        icon="alert"
        title="Demo payment not available"
        description="This payment doesn't exist or demo payments are turned off in this environment."
        action={<ButtonLink to="/orders">Go to my orders</ButtonLink>}
      />
    );
  }

  return (
    <>
      <PageHeader title="Demo payment" />
      <QueryState query={q} loading={<Skeleton className="h-64 w-full max-w-lg" />}>
        {(d) => {
          const done = d.status === 'CAPTURED' || d.status === 'REFUNDED' || d.status === 'PARTIALLY_REFUNDED';
          return (
            <Card className="mx-auto max-w-lg text-center" padding="lg">
              <p
                className="mb-4 rounded-control border-2 border-dashed border-info-600 bg-info-50 px-3 py-3 text-lg font-extrabold uppercase tracking-wide text-info-800"
                role="note"
              >
                DEMO PAYMENT — no real money
              </p>
              <p className="text-sm text-slate-600">{d.purpose === 'CHECKOUT' ? 'Food order' : 'Membership'} · reference {d.providerOrderId}</p>
              <div className="my-4">
                <Price paise={d.amountPaise} size="xl" />
              </div>
              <p className="mb-5 text-sm text-slate-600">
                Choose an outcome to simulate the payment provider. Your order is confirmed only after the server processes the (simulated) provider
                notification.
              </p>
              {done ? (
                <div className="space-y-3">
                  <Badge tone="success">Already paid</Badge>
                  <ButtonLink to={returnPathFor(d, params.get('return'))} fullWidth>
                    Continue
                  </ButtonLink>
                </div>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2">
                  <Button size="lg" icon="check" onClick={() => complete.mutate('success')} loading={complete.isPending && complete.variables === 'success'} disabled={complete.isPending}>
                    Simulate success
                  </Button>
                  <Button size="lg" variant="danger" icon="x" onClick={() => complete.mutate('failure')} loading={complete.isPending && complete.variables === 'failure'} disabled={complete.isPending}>
                    Simulate failure
                  </Button>
                </div>
              )}
              <InlineError error={complete.error} className="mt-3 justify-center" />
              <p className="mt-4 text-xs text-slate-500">Leaving this page is safe — you can come back from your order&rsquo;s status page.</p>
            </Card>
          );
        }}
      </QueryState>
    </>
  );
}
