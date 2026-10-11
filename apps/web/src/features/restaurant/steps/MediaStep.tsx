/** Step 4: cover and logo images (presign -> PUT -> attach with PATCH images). Optional but recommended. */
import { useMutation } from '@tanstack/react-query';
import { Card, useToast } from '../../../components/ui';
import { FilePicker } from '../FilePicker';
import { restaurantApi, uploadFile } from '../api';
import { StepFrame, type StepProps } from './StepFrame';

export function MediaStep({ restaurant, onSaved, next, back }: StepProps) {
  const { toast } = useToast();
  const attach = useMutation({
    mutationFn: ({ slot, key }: { slot: 'cover' | 'logo'; key: string }) => restaurantApi.patch(restaurant!.id, { images: { [slot]: key } }),
    onSuccess: (r) => onSaved(r),
  });

  const upload = (slot: 'cover' | 'logo') => async (file: File) => {
    const key = await uploadFile(restaurant!.id, file, 'IMAGE');
    await attach.mutateAsync({ slot, key });
    toast({ title: slot === 'cover' ? 'Cover image saved' : 'Logo saved', tone: 'success' });
  };

  return (
    <StepFrame
      title="Photos"
      description="Good photos help customers choose you. You can skip this and add photos later."
      submitLabel={restaurant?.images.cover || restaurant?.images.logo ? 'Continue' : 'Skip for now'}
      onBack={back}
      onSubmit={next}
    >
      <Card padding="sm" className="flex flex-col gap-3">
        <h3 className="font-sans text-[15px] font-semibold tracking-normal text-fg">Cover image</h3>
        {restaurant?.images.coverUrl ? (
          <img src={restaurant.images.coverUrl} alt="Current cover" className="h-40 w-full rounded-control object-cover" />
        ) : (
          <p className="text-sm text-fg-3">No cover image yet.</p>
        )}
        <FilePicker label="Cover image" purpose="IMAGE" buttonLabel={restaurant?.images.coverUrl ? 'Replace cover image' : 'Upload cover image'} onPick={upload('cover')} />
      </Card>
      <Card padding="sm" className="flex flex-col gap-3">
        <h3 className="font-sans text-[15px] font-semibold tracking-normal text-fg">Logo</h3>
        {restaurant?.images.logoUrl ? (
          <img src={restaurant.images.logoUrl} alt="Current logo" className="size-24 rounded-control object-cover" />
        ) : (
          <p className="text-sm text-fg-3">No logo yet.</p>
        )}
        <FilePicker label="Logo" purpose="IMAGE" buttonLabel={restaurant?.images.logoUrl ? 'Replace logo' : 'Upload logo'} onPick={upload('logo')} />
      </Card>
    </StepFrame>
  );
}
