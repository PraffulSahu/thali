/**
 * Demo payment page (design-spec §7.2; mock provider only — payments mounts `/demo-pay/*` only when
 * PAYMENT_PROVIDER=mock and production refuses mock). "Simulate success" / "Simulate failure" make the payments
 * service emit signed mock webhooks into the normal pipeline; we then go to the status page, which waits for the
 * server — this page never marks anything paid.
 */
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { Badge, Button, ButtonLink, EmptyState, ErrorState, InlineError, Price, Skeleton } from '../../components/ui';
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

  if (q.isError) {
    return isNotFound(q.error) ? (
      <EmptyState
        icon="alert"
        title="Demo payment not available"
        description="This payment doesn't exist or demo payments are turned off in this environment."
        action={<ButtonLink to="/orders">Go to my orders</ButtonLink>}
      />
    ) : (
      <ErrorState error={q.error} title="Couldn't load this payment" onRetry={() => void q.refetch()} />
    );
  }

  return (
    <div className="pt-6">
      {q.isPending ? (
        <Skeleton className="mx-auto h-80 w-full max-w-[560px] rounded-card-lg" />
      ) : (
        (() => {
          const d = q.data;
          const done = d.status === 'CAPTURED' || d.status === 'REFUNDED' || d.status === 'PARTIALLY_REFUNDED';
          return (
            <div className="mx-auto flex w-full max-w-[560px] flex-col items-center gap-5 rounded-card-lg border border-line bg-card p-7 text-center shadow-card max-sm:p-5">
              <h1 className="sr-only">Demo payment</h1>
              <p role="note" className="rounded-pill bg-warn-bg px-3.5 py-1.5 font-mono text-[13px] font-medium uppercase tracking-wide text-warn">
                DEMO PAYMENT — no real money
              </p>
              <div className="flex flex-col items-center gap-1.5">
                <Price paise={d.amountPaise} size="total" />
                <p className="text-sm text-fg-3">
                  {d.purpose === 'CHECKOUT' ? 'Food order' : 'Thali Plus membership'} · ref <span className="font-mono">{d.providerOrderId}</span>
                </p>
              </div>
              <p className="max-w-[420px] text-sm text-fg-2">
                Choose an outcome to simulate the payment provider. Your order is confirmed only after the server processes the (simulated) provider notification.
              </p>
              {done ? (
                <div className="flex w-full flex-col items-center gap-3">
                  <Badge tone="ok">Already paid</Badge>
                  <ButtonLink to={returnPathFor(d, params.get('return'))} fullWidth>
                    Continue
                  </ButtonLink>
                </div>
              ) : (
                <div className="grid w-full gap-3 sm:grid-cols-2">
                  <Button size="lg" icon="check" onClick={() => complete.mutate('success')} loading={complete.isPending && complete.variables === 'success'} disabled={complete.isPending}>
                    Simulate success
                  </Button>
                  <Button size="lg" variant="danger-outline" icon="x" onClick={() => complete.mutate('failure')} loading={complete.isPending && complete.variables === 'failure'} disabled={complete.isPending}>
                    Simulate failure
                  </Button>
                </div>
              )}
              <InlineError error={complete.error} className="justify-center" />
              <p className="text-xs text-fg-3">Leaving this page is safe — you can come back from your order&rsquo;s status page.</p>
            </div>
          );
        })()
      )}
    </div>
  );
}
