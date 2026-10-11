/**
 * Cart line + per-restaurant slot rendering shared by the dock tray, the cart drawer and the cart page
 * (design-spec §3.22 tray slot pattern). Quantity changes are optimistic (cartState.useLineQuantity).
 */
import { Link } from 'react-router';
import { CartSlot, hueFor, QtyStepper, VegMark } from '../../components/ui';
import { formatINR } from '../../lib/format';
import type { CartGroup, CartLine } from './api';
import { MAX_LINE_QTY, useLineQuantity } from './cartState';

export function lineOptions(l: Pick<CartLine, 'addOns' | 'note'>): string {
  return [l.addOns.map((a) => a.name).join(', '), l.note ? `“${l.note}”` : ''].filter(Boolean).join(' · ');
}

export function CartLineRow({ line }: { line: CartLine }) {
  const { setQuantity, pendingLineId } = useLineQuantity();
  const opts = lineOptions(line);
  return (
    <div className="flex items-center gap-2.5">
      <VegMark veg={line.isVeg} size={13} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[13.5px] text-fg">{line.name}</span>
        <span className="truncate text-xs text-fg-3">{[opts, formatINR(line.lineTotalPaise)].filter(Boolean).join(' · ')}</span>
      </span>
      <QtyStepper
        value={line.quantity}
        max={MAX_LINE_QTY}
        itemName={line.name}
        disabled={pendingLineId === line.lineId}
        onChange={(q) => setQuantity(line, q)}
      />
    </div>
  );
}

export function CartGroupSlot({ group, deliveryLabel, action, linkName }: { group: CartGroup; deliveryLabel?: string; action?: React.ReactNode; linkName?: boolean }) {
  return (
    <CartSlot
      name={group.restaurantName}
      hue={hueFor(group.restaurantId)}
      deliveryLabel={deliveryLabel}
      subtotalPaise={group.subtotalPaise}
      action={action}
    >
      {group.lines.map((l) => (
        <CartLineRow key={l.lineId} line={l} />
      ))}
      {linkName ? (
        <Link to={`/restaurants/${group.restaurantId}`} className="self-start text-[12.5px] text-fg-3 underline underline-offset-2 hover:text-fg">
          Add more from {group.restaurantName}
        </Link>
      ) : null}
    </CartSlot>
  );
}
