/** Coupon editor (API verified against services/marketplace admin-promotions). The code is immutable after creation. */
import { useEffect, useState } from 'react';
import { Checkbox } from '../../../components/ui/Checkbox';
import { Field } from '../../../components/ui/Field';
import { Input } from '../../../components/ui/Input';
import { Select } from '../../../components/ui/Select';
import { isoToIstInput, istInputToIso, paiseToRupees, rupeesToPaise, type Coupon } from '../api';
import { EditorDialog, useCatalogSave } from './EditorShell';

/** Percent text ("12.5") to basis points with integer math; null if invalid. */
export function percentToBps(input: string): number | null {
  const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(input.trim());
  if (!m) return null;
  const bps = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || '0');
  return bps <= 10000 ? bps : null;
}
export const bpsToPercent = (bps: number | null | undefined) =>
  bps === null || bps === undefined ? '' : bps % 100 === 0 ? String(bps / 100) : (bps / 100).toFixed(2).replace(/0$/, '');

const optInt = (s: string) => (s.trim() === '' ? undefined : /^\d{1,9}$/.test(s.trim()) ? Number(s.trim()) : null);

export default function CouponEditor({ open, item, onClose }: { open: boolean; item: Coupon | null; onClose: () => void }) {
  const [code, setCode] = useState('');
  const [description, setDescription] = useState('');
  const [type, setType] = useState<'FLAT' | 'PERCENT'>('FLAT');
  const [value, setValue] = useState('');
  const [maxDiscount, setMaxDiscount] = useState('');
  const [minOrder, setMinOrder] = useState('0');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [totalLimit, setTotalLimit] = useState('');
  const [perUserLimit, setPerUserLimit] = useState('');
  const [firstOrderOnly, setFirstOrderOnly] = useState(false);
  const [active, setActive] = useState(true);
  const save = useCatalogSave<Coupon>('coupons', 'Coupon', item);

  useEffect(() => {
    if (!open) return;
    setCode(item?.code ?? '');
    setDescription(item?.description ?? '');
    setType(item?.type ?? 'FLAT');
    setValue(item ? (item.type === 'PERCENT' ? bpsToPercent(item.valueBps) : paiseToRupees(item.valuePaise)) : '');
    setMaxDiscount(paiseToRupees(item?.maxDiscountPaise));
    setMinOrder(paiseToRupees(item?.minOrderPaise ?? 0) || '0');
    setFrom(isoToIstInput(item?.validFrom));
    setTo(isoToIstInput(item?.validTo));
    setTotalLimit(item?.totalLimit ? String(item.totalLimit) : '');
    setPerUserLimit(item?.perUserLimit ? String(item.perUserLimit) : '');
    setFirstOrderOnly(item?.firstOrderOnly ?? false);
    setActive(item?.active ?? true);
  }, [open, item]);

  const valueNum = type === 'FLAT' ? rupeesToPaise(value) : percentToBps(value);
  const maxPaise = maxDiscount.trim() === '' ? undefined : rupeesToPaise(maxDiscount);
  const minPaise = rupeesToPaise(minOrder);
  const total = optInt(totalLimit);
  const perUser = optInt(perUserLimit);
  const fromIso = istInputToIso(from);
  const toIso = istInputToIso(to);
  const rangeError = fromIso && toIso && new Date(toIso) <= new Date(fromIso) ? 'The end must be after the start.' : undefined;
  const codeOk = /^[A-Z0-9_-]{3,30}$/.test(code);
  const valid = codeOk && valueNum !== null && valueNum > 0 && maxPaise !== null && minPaise !== null && total !== null && perUser !== null && !!fromIso && !!toIso && !rangeError;

  return (
    <EditorDialog
      open={open}
      onClose={onClose}
      size="lg"
      title={item ? `Edit ${item.code}` : 'Add a coupon'}
      submitLabel={item ? 'Save changes' : 'Add coupon'}
      valid={valid}
      onSubmit={() =>
        save.mutateAsync({
          // the code is immutable: the server rejects it in an update
          ...(item ? {} : { code }),
          description: description.trim(),
          type,
          ...(type === 'FLAT' ? { valuePaise: valueNum } : { valueBps: valueNum }),
          maxDiscountPaise: type === 'PERCENT' ? maxPaise ?? null : null,
          minOrderPaise: minPaise,
          validFrom: fromIso,
          validTo: toIso,
          totalLimit: total && total > 0 ? total : null,
          perUserLimit: perUser && perUser > 0 ? perUser : 1,
          firstOrderOnly,
          active,
        })
      }
    >
      {(errors) => (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Code" required hint="3 to 30 capital letters, digits, - or _. Cannot be changed later." error={code && !codeOk ? 'Use 3 to 30 capital letters, digits, - or _.' : errors.code}>
              <Input value={code} onChange={(e) => setCode(e.target.value.toUpperCase().replace(/\s/g, ''))} maxLength={30} className="font-mono" disabled={Boolean(item)} />
            </Field>
            <Field label="Discount type" required>
              <Select value={type} onChange={(e) => { setType(e.target.value as 'FLAT' | 'PERCENT'); setValue(''); }} options={[{ value: 'FLAT', label: 'Flat amount off' }, { value: 'PERCENT', label: 'Percent off' }]} />
            </Field>
          </div>
          <Field label="Description" optional error={errors.description}>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={200} />
          </Field>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label={type === 'FLAT' ? 'Discount amount' : 'Discount percent'} required error={value !== '' && valueNum === null ? (type === 'FLAT' ? 'Enter rupees, like 50 or 49.50.' : 'Enter a percent from 0.01 to 100.') : errors.valuePaise ?? errors.valueBps}>
              <Input inputMode="decimal" prefix={type === 'FLAT' ? '₹' : undefined} suffix={type === 'PERCENT' ? '%' : undefined} value={value} onChange={(e) => setValue(e.target.value)} />
            </Field>
            {type === 'PERCENT' ? (
              <Field label="Maximum discount" optional hint="Caps the percent discount" error={maxPaise === null ? 'Enter rupees.' : errors.maxDiscountPaise}>
                <Input inputMode="decimal" prefix="₹" value={maxDiscount} onChange={(e) => setMaxDiscount(e.target.value)} />
              </Field>
            ) : null}
            <Field label="Minimum order" required error={minPaise === null ? 'Enter rupees, 0 for none.' : errors.minOrderPaise}>
              <Input inputMode="decimal" prefix="₹" value={minOrder} onChange={(e) => setMinOrder(e.target.value)} />
            </Field>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Valid from (IST)" required error={errors.validFrom}>
              <Input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
            </Field>
            <Field label="Valid until (IST)" required error={rangeError ?? errors.validTo}>
              <Input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} />
            </Field>
            <Field label="Total uses" optional hint="Empty means unlimited" error={total === null ? 'Whole number.' : errors.totalLimit}>
              <Input inputMode="numeric" value={totalLimit} onChange={(e) => setTotalLimit(e.target.value)} />
            </Field>
            <Field label="Uses per customer" optional hint="Empty means once each" error={perUser === null ? 'Whole number.' : errors.perUserLimit}>
              <Input inputMode="numeric" value={perUserLimit} onChange={(e) => setPerUserLimit(e.target.value)} />
            </Field>
          </div>
          <Checkbox label="First order only" checked={firstOrderOnly} onChange={(e) => setFirstOrderOnly(e.target.checked)} />
          <Checkbox label="Active" description="Inactive coupons are rejected at checkout" checked={active} onChange={(e) => setActive(e.target.checked)} />
        </>
      )}
    </EditorDialog>
  );
}
