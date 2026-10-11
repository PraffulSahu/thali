/** Step 5: KYC documents (private bucket). FSSAI, GST and PAN are required by default. */
import { useMutation } from '@tanstack/react-query';
import { Badge, Card, useToast } from '../../../components/ui';
import { formatDate } from '../../../lib/format';
import { FilePicker } from '../FilePicker';
import { DOCUMENT_TYPES, restaurantApi, uploadFile, type OwnerRestaurant } from '../api';
import { StepFrame, type StepProps } from './StepFrame';

export function DocumentsStep({ restaurant, onSaved, next, back }: StepProps) {
  const { toast } = useToast();
  const attach = useMutation({
    mutationFn: (v: { type: string; key: string }) => restaurantApi.attachDocument(restaurant!.id, v),
  });

  const upload = (type: string, label: string) => async (file: File) => {
    const key = await uploadFile(restaurant!.id, file, 'DOCUMENT');
    const doc = await attach.mutateAsync({ type, key });
    // reflect the attached document locally (replaces an earlier one of the same type)
    const documents: OwnerRestaurant['documents'] = [...(restaurant!.documents.filter((d) => d.type !== type)), doc];
    onSaved({ ...restaurant!, documents });
    toast({ title: `${label} uploaded`, tone: 'success' });
  };

  const missing = DOCUMENT_TYPES.filter((d) => d.required && !restaurant?.documents.some((x) => x.type === d.type));

  return (
    <StepFrame
      title="Business documents"
      description="Upload clear scans or photos. Our team verifies them during approval."
      submitLabel={missing.length ? 'Continue' : 'Save and continue'}
      onBack={back}
      onSubmit={next}
    >
      {missing.length > 0 ? (
        <p role="status" className="text-sm text-fg-3">
          Still needed before you can submit: {missing.map((m) => m.label).join(', ')}.
        </p>
      ) : null}
      <ul className="flex flex-col gap-3">
        {DOCUMENT_TYPES.map((d) => {
          const doc = restaurant?.documents.find((x) => x.type === d.type);
          return (
            <li key={d.type}>
              <Card padding="sm" className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="font-sans text-[15px] font-semibold tracking-normal text-fg">
                    {d.label} {d.required ? <span className="text-sm font-normal text-fg-3">(required)</span> : <span className="text-sm font-normal text-fg-3">(optional)</span>}
                  </h3>
                  {doc ? (
                    <Badge tone={doc.verified ? 'success' : 'info'} icon={doc.verified ? 'check' : 'clock'}>
                      {doc.verified ? 'Verified' : 'Uploaded, pending review'}
                    </Badge>
                  ) : (
                    <Badge tone={d.required ? 'warn' : 'neutral'}>Not uploaded</Badge>
                  )}
                </div>
                {doc?.uploadedAt ? <p className="text-sm text-fg-3">Uploaded {formatDate(doc.uploadedAt)}</p> : null}
                <FilePicker label={d.label} purpose="DOCUMENT" buttonLabel={doc ? `Replace ${d.label}` : `Upload ${d.label}`} onPick={upload(d.type, d.label)} />
              </Card>
            </li>
          );
        })}
      </ul>
    </StepFrame>
  );
}
