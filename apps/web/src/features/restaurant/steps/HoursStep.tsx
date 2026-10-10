/** Step 3: weekly opening hours (Asia/Kolkata). Saved with PUT /hours. */
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { HoursEditor } from '../HoursEditor';
import { restaurantApi } from '../api';
import { slotsFromWeek, validateWeek, weekFromSlots, type WeekState } from '../hours';
import { StepFrame, type StepProps } from './StepFrame';

export function HoursStep({ restaurant, onSaved, next, back }: StepProps) {
  const [week, setWeek] = useState<WeekState>(() => weekFromSlots(restaurant?.hours ?? []));
  const [show, setShow] = useState(false);
  const check = validateWeek(week);
  const save = useMutation({
    mutationFn: () => restaurantApi.setHours(restaurant!.id, slotsFromWeek(week)),
    onSuccess: (r) => {
      onSaved(r);
      next();
    },
  });
  return (
    <StepFrame
      title="Opening hours"
      description="All times are India Standard Time. A closing time earlier than the opening time means you close after midnight."
      submitting={save.isPending}
      error={save.error}
      onBack={back}
      onSubmit={() => {
        if (!check.valid) {
          setShow(true);
          return;
        }
        save.mutate();
      }}
    >
      <HoursEditor value={week} onChange={setWeek} errors={show ? check.errors : {}} />
    </StepFrame>
  );
}
