/** Membership plan editor (API verified against services/marketplace admin-promotions). */
import { useEffect, useState } from 'react';
import { Checkbox } from '../../../components/ui/Checkbox';
import { Field } from '../../../components/ui/Field';
import { Input, Textarea } from '../../../components/ui/Input';
import { paiseToRupees, rupeesToPaise, type MembershipPlan } from '../api';
import { bpsToPercent, percentToBps } from './CouponEditor';
import { EditorDialog, useCatalogSave } from './EditorShell';

const wholeNumber = (s: string) => (/^\d{1,6}$/.test(s.trim()) ? Number(s.trim()) : null);

export default function PlanEditor({ open, item, onClose }: { open: boolean; item: MembershipPlan | null; onClose: () => void }) {
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [days, setDays] = useState('30');
  const [terms, setTerms] = useState('');
  const [freeMin, setFreeMin] = useState('0');
  const [freeCount, setFreeCount] = useState('0');
  const [discount, setDiscount] = useState('0');
  const [discountCap, setDiscountCap] = useState('0');
  const [active, setActive] = useState(true);
  const save = useCatalogSave<MembershipPlan>('plans', 'Plan', item);

  useEffect(() => {
    if (!open) return;
    setName(item?.name ?? '');
    setPrice(paiseToRupees(item?.pricePaise));
    setDays(String(item?.durationDays ?? 30));
    setTerms(item?.terms ?? '');
    setFreeMin(paiseToRupees(item?.benefits.freeDeliveryMinOrderPaise ?? 0) || '0');
    setFreeCount(String(item?.benefits.freeDeliveriesPerPeriod ?? 0));
    setDiscount(bpsToPercent(item?.benefits.extraDiscountBps ?? 0) || '0');
    setDiscountCap(paiseToRupees(item?.benefits.extraDiscountCapPaise ?? 0) || '0');
    setActive(item?.active ?? true);
  }, [open, item]);

  const pricePaise = rupeesToPaise(price);
  const durationDays = wholeNumber(days);
  const freeMinPaise = rupeesToPaise(freeMin);
  const freeDeliveries = wholeNumber(freeCount);
  const discountBps = percentToBps(discount);
  const capPaise = rupeesToPaise(discountCap);
  const valid = name.trim().length > 0 && terms.trim().length > 0 && pricePaise !== null && durationDays !== null && durationDays > 0 && durationDays <= 366 && freeMinPaise !== null && freeDeliveries !== null && discountBps !== null && capPaise !== null;

  return (
    <EditorDialog
      open={open}
      onClose={onClose}
      size="lg"
      title={item ? `Edit ${item.name}` : 'Add a membership plan'}
      submitLabel={item ? 'Save changes' : 'Add plan'}
      valid={valid}
      onSubmit={() =>
        save.mutateAsync({
          name: name.trim(),
          pricePaise,
          durationDays,
          terms: terms.trim(),
          benefits: { freeDeliveryMinOrderPaise: freeMinPaise, freeDeliveriesPerPeriod: freeDeliveries, extraDiscountBps: discountBps, extraDiscountCapPaise: capPaise },
          active,
        })
      }
    >
      {(errors) => (
        <>
          <Field label="Plan name" required error={errors.name}>
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
          </Field>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Price" required error={price !== '' && pricePaise === null ? 'Enter rupees, like 199.' : errors.pricePaise}>
              <Input inputMode="decimal" prefix="₹" value={price} onChange={(e) => setPrice(e.target.value)} />
            </Field>
            <Field label="Duration" required error={durationDays === null || durationDays === 0 || durationDays > 366 ? 'Enter 1 to 366 days.' : errors.durationDays}>
              <Input inputMode="numeric" suffix="days" value={days} onChange={(e) => setDays(e.target.value)} />
            </Field>
          </div>
          <fieldset className="grid grid-cols-1 gap-4 rounded-control border border-line p-3 sm:grid-cols-2">
            <legend className="px-1 text-sm font-semibold text-fg">Benefits</legend>
            <Field label="Free delivery above" hint="Minimum order value; 0 for any order" error={freeMinPaise === null ? 'Enter rupees.' : undefined}>
              <Input inputMode="decimal" prefix="₹" value={freeMin} onChange={(e) => setFreeMin(e.target.value)} />
            </Field>
            <Field label="Free deliveries per period" error={freeDeliveries === null ? 'Whole number.' : undefined}>
              <Input inputMode="numeric" value={freeCount} onChange={(e) => setFreeCount(e.target.value)} />
            </Field>
            <Field label="Extra discount" error={discountBps === null ? 'Percent from 0 to 100.' : undefined}>
              <Input inputMode="decimal" suffix="%" value={discount} onChange={(e) => setDiscount(e.target.value)} />
            </Field>
            <Field label="Extra discount cap" error={capPaise === null ? 'Enter rupees.' : undefined}>
              <Input inputMode="decimal" prefix="₹" value={discountCap} onChange={(e) => setDiscountCap(e.target.value)} />
            </Field>
          </fieldset>
          <Field label="Terms" required hint="Shown to customers before they buy (markdown)" error={errors.terms}>
            <Textarea value={terms} onChange={(e) => setTerms(e.target.value)} rows={4} maxLength={2000} />
          </Field>
          <Checkbox label="Active" description="Inactive plans cannot be bought; current members keep their benefits" checked={active} onChange={(e) => setActive(e.target.checked)} />
        </>
      )}
    </EditorDialog>
  );
}
