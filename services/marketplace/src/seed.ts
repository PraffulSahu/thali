/**
 * Marketplace demo seed (APP_MODE=demo only; idempotent; writes only thali_marketplace + demo files in S3).
 *
 *   container:  docker compose exec marketplace node dist/seed.js
 *   local:      npm run seed -w @thali/marketplace
 *
 * Content (all restaurants/banners flagged isDemo):
 *  - service area `service-area:blr-koramangala` (Koramangala / HSR, Bengaluru) + cuisines
 *  - restaurants (`restaurant:<slug>`):
 *      spice-route   APPROVED, non-veg, owner user:owner1   (menu with customization groups, add-ons and
 *                                                             a tracked-stock item: Mutton Rogan Josh, stock 3)
 *      green-leaf    APPROVED, pure veg, owner user:owner2
 *      tandoor-tales APPROVAL_PENDING (email verified, KYC uploaded), owner user:owner1
 *      coastal-curry VERIFICATION_PENDING (business email not verified yet), owner user:owner2
 *  - coupons WELCOME50 (50% up to ₹100) and FLAT100 (₹100 off, total limit 1); membership plan "Thali Plus"
 * Menu ids: `category:<rest>:<slug>`, `item:<rest>:<slug>`, `group:<rest>:<item>:<slug>`, `option:<rest>:<item>:<group>:<slug>`.
 */
import type { Connection } from 'mongoose';
import { seedId } from '@thali/contracts/seed';
import { encryptField } from '@thali/service-kit';
import { demoPdf, ensureDocs, isMainModule, runSeedCli, uploadSeedObjects, type SeedObject, type SeedReport } from '@thali/service-kit/seed';
import { loadMarketplaceConfig, type MarketplaceConfig } from './config.js';
import { ensureMarketplaceIndexes, getModels } from './models/index.js';

export type MarketplaceSeedConfig = Pick<
  MarketplaceConfig,
  'FIELD_ENCRYPTION_KEY' | 'S3_ENDPOINT' | 'S3_REGION' | 'S3_ACCESS_KEY_ID' | 'S3_SECRET_ACCESS_KEY' | 'S3_PUBLIC_BUCKET' | 'S3_PRIVATE_BUCKET'
>;

const SEEDED_AT = new Date('2026-09-01T04:30:00.000Z');
const ALL_DAY = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, open: '00:00', close: '00:00' })); // 24 h, every day
const pt = (lat: number, lng: number) => ({ type: 'Point', coordinates: [lng, lat] });

// ------------------------------------------------------------------------------------------- menu --
interface OptionSpec { slug: string; name: string; pricePaise: number; isVeg: boolean; available?: boolean }
interface GroupSpec { slug: string; name: string; minSelect: number; maxSelect: number; options: OptionSpec[] }
interface ItemSpec {
  slug: string;
  name: string;
  description: string;
  pricePaise: number;
  isVeg: boolean;
  category: string;
  groups?: GroupSpec[];
  trackStock?: boolean;
  stockQty?: number;
  available?: boolean;
  tags?: string[];
}

const veg = (slug: string, name: string, pricePaise: number): OptionSpec => ({ slug, name, pricePaise, isVeg: true });
const nonVeg = (slug: string, name: string, pricePaise: number): OptionSpec => ({ slug, name, pricePaise, isVeg: false });
const spiceLevel: GroupSpec = {
  slug: 'spice',
  name: 'Spice level',
  minSelect: 1,
  maxSelect: 1,
  options: [veg('mild', 'Mild', 0), veg('medium', 'Medium', 0), veg('hot', 'Hot', 0)],
};

const SPICE_ROUTE_CATEGORIES = [
  ['starters', 'Starters'],
  ['biryani', 'Biryani'],
  ['mains', 'Mains'],
  ['breads', 'Breads'],
  ['desserts', 'Desserts'],
] as const;
const SPICE_ROUTE_ITEMS: ItemSpec[] = [
  {
    slug: 'chicken-65', name: 'Chicken 65', category: 'starters', pricePaise: 24900, isVeg: false, tags: ['bestseller'],
    description: 'Crisp, curry-leaf tempered fried chicken.',
    groups: [{ slug: 'portion', name: 'Portion', minSelect: 1, maxSelect: 1, options: [nonVeg('half', 'Half', 0), nonVeg('full', 'Full', 12000)] }],
  },
  { slug: 'paneer-tikka', name: 'Paneer Tikka', category: 'starters', pricePaise: 22900, isVeg: true, description: 'Tandoor-charred cottage cheese, mint chutney.' },
  {
    slug: 'chicken-biryani', name: 'Hyderabadi Chicken Biryani', category: 'biryani', pricePaise: 32900, isVeg: false, tags: ['bestseller'],
    description: 'Dum-cooked basmati, saffron, slow-cooked chicken.',
    groups: [
      { slug: 'portion', name: 'Portion', minSelect: 1, maxSelect: 1, options: [nonVeg('regular', 'Regular', 0), nonVeg('family', 'Family pack (serves 3)', 30000)] },
      {
        slug: 'addons', name: 'Add-ons', minSelect: 0, maxSelect: 3,
        options: [veg('raita', 'Raita', 3000), veg('salan', 'Mirchi ka salan', 4000), nonVeg('egg', 'Boiled egg', 2500), nonVeg('extra-chicken', 'Extra chicken', 9000)],
      },
    ],
  },
  {
    slug: 'veg-biryani', name: 'Veg Dum Biryani', category: 'biryani', pricePaise: 27900, isVeg: true,
    description: 'Seasonal vegetables, whole spices, fried onions.',
    groups: [{ slug: 'addons', name: 'Add-ons', minSelect: 0, maxSelect: 2, options: [veg('raita', 'Raita', 3000), veg('salan', 'Mirchi ka salan', 4000)] }],
  },
  {
    slug: 'mutton-rogan-josh', name: "Chef's Special Mutton Rogan Josh", category: 'mains', pricePaise: 42900, isVeg: false,
    description: 'Kashmiri chilli, slow-braised mutton. Limited portions every day.', trackStock: true, stockQty: 3, tags: ['limited'],
  },
  { slug: 'butter-chicken', name: 'Butter Chicken', category: 'mains', pricePaise: 34900, isVeg: false, description: 'Smoky tandoori chicken in tomato-butter gravy.', groups: [spiceLevel] },
  { slug: 'butter-naan', name: 'Butter Naan', category: 'breads', pricePaise: 6000, isVeg: true, description: 'Tandoor-baked, brushed with butter.' },
  { slug: 'garlic-naan', name: 'Garlic Naan', category: 'breads', pricePaise: 7000, isVeg: true, description: 'Garlic and coriander.' },
  {
    slug: 'gulab-jamun', name: 'Gulab Jamun (2 pcs)', category: 'desserts', pricePaise: 9900, isVeg: true, description: 'Warm, cardamom syrup.',
    groups: [{ slug: 'addons', name: 'Make it special', minSelect: 0, maxSelect: 1, options: [veg('ice-cream', 'Vanilla ice cream', 5000)] }],
  },
];

const GREEN_LEAF_CATEGORIES = [
  ['south-indian', 'South Indian'],
  ['north-indian', 'North Indian'],
  ['bowls', 'Bowls & Salads'],
  ['beverages', 'Beverages'],
] as const;
const GREEN_LEAF_ITEMS: ItemSpec[] = [
  {
    slug: 'masala-dosa', name: 'Masala Dosa', category: 'south-indian', pricePaise: 14900, isVeg: true, tags: ['bestseller'],
    description: 'Crisp rice crepe, potato masala, sambar and chutneys.',
    groups: [{ slug: 'addons', name: 'Add-ons', minSelect: 0, maxSelect: 2, options: [veg('chutney', 'Extra chutney', 1500), veg('ghee-roast', 'Make it ghee roast', 3000)] }],
  },
  { slug: 'idli-vada', name: 'Idli Vada Combo', category: 'south-indian', pricePaise: 11900, isVeg: true, description: '2 idli, 1 medu vada, sambar.' },
  {
    slug: 'paneer-butter-masala', name: 'Paneer Butter Masala', category: 'north-indian', pricePaise: 26900, isVeg: true,
    description: 'Cottage cheese in a rich tomato-cashew gravy.',
    groups: [
      spiceLevel,
      { slug: 'breads', name: 'Add breads', minSelect: 0, maxSelect: 3, options: [veg('butter-naan', 'Butter naan', 6000), veg('roti', 'Tandoori roti', 3500), veg('lachha', 'Lachha paratha', 7000)] },
    ],
  },
  { slug: 'dal-makhani', name: 'Dal Makhani', category: 'north-indian', pricePaise: 21900, isVeg: true, description: 'Black lentils simmered overnight.' },
  {
    slug: 'buddha-bowl', name: 'Quinoa Buddha Bowl', category: 'bowls', pricePaise: 29900, isVeg: true,
    description: 'Quinoa, roasted veggies, hummus, greens.',
    groups: [
      { slug: 'protein', name: 'Protein', minSelect: 1, maxSelect: 1, options: [veg('paneer', 'Grilled paneer', 0), veg('tofu', 'Tofu', 0), veg('chickpea', 'Spiced chickpea', 0)] },
      { slug: 'extras', name: 'Extras', minSelect: 0, maxSelect: 2, options: [veg('avocado', 'Avocado', 6000), veg('feta', 'Feta', 4000), { ...veg('halloumi', 'Halloumi', 7000), available: false }] },
    ],
  },
  {
    slug: 'filter-coffee', name: 'Filter Coffee', category: 'beverages', pricePaise: 6900, isVeg: true, description: 'Chicory blend, frothed with milk.',
    groups: [{ slug: 'size', name: 'Size', minSelect: 1, maxSelect: 1, options: [veg('regular', 'Regular', 0), veg('large', 'Large', 3000)] }],
  },
  { slug: 'tender-coconut', name: 'Tender Coconut Water', category: 'beverages', pricePaise: 8900, isVeg: true, description: 'Fresh, seasonal.', available: false },
];

const TANDOOR_TALES_CATEGORIES = [['tandoor', 'From the tandoor']] as const;
const TANDOOR_TALES_ITEMS: ItemSpec[] = [
  { slug: 'tandoori-chicken', name: 'Tandoori Chicken (half)', category: 'tandoor', pricePaise: 29900, isVeg: false, description: 'Yoghurt-marinated, clay-oven roasted.' },
  { slug: 'malai-broccoli', name: 'Malai Broccoli', category: 'tandoor', pricePaise: 23900, isVeg: true, description: 'Cream cheese marinade.' },
];

function menuDocs(rest: string, categories: readonly (readonly [string, string])[], items: ItemSpec[]) {
  const restaurantId = seedId(`restaurant:${rest}`);
  const cats = categories.map(([slug, name], i) => ({ _id: seedId(`category:${rest}:${slug}`), restaurantId, name, sortOrder: i, active: true }));
  const docs = items.map((it) => ({
    _id: seedId(`item:${rest}:${it.slug}`),
    restaurantId,
    categoryId: seedId(`category:${rest}:${it.category}`),
    name: it.name,
    description: it.description,
    pricePaise: it.pricePaise,
    isVeg: it.isVeg,
    available: it.available ?? true,
    trackStock: it.trackStock ?? false,
    stockQty: it.stockQty ?? 0,
    reservedQty: 0,
    tags: it.tags ?? [],
    customizationGroups: (it.groups ?? []).map((g) => ({
      _id: seedId(`group:${rest}:${it.slug}:${g.slug}`),
      name: g.name,
      minSelect: g.minSelect,
      maxSelect: g.maxSelect,
      options: g.options.map((o) => ({
        _id: seedId(`option:${rest}:${it.slug}:${g.slug}:${o.slug}`),
        name: o.name,
        pricePaise: o.pricePaise,
        isVeg: o.isVeg,
        available: o.available ?? true,
      })),
    })),
  }));
  return { cats, items: docs };
}

// ------------------------------------------------------------------------------------ restaurants --
const DOC_TYPES = ['FSSAI', 'GST', 'PAN'] as const;
const docKey = (rest: string, type: string) => `documents/demo/${rest}/${type.toLowerCase()}.pdf`;
const imageKey = (rest: string, kind: 'cover' | 'logo') => `images/demo/${rest}/${kind}.svg`;

interface RestaurantSpec {
  slug: string;
  name: string;
  owner: string;
  status: 'APPROVED' | 'APPROVAL_PENDING' | 'VERIFICATION_PENDING';
  description: string;
  cuisines: string[];
  lat: number;
  lng: number;
  line1: string;
  phone: string;
  businessEmail: string;
  commissionBps: number;
  packagingFeePaise: number;
  avgPrepMinutes: number;
  rating?: [sum: number, count: number];
  colors: [string, string];
}

const RESTAURANTS: RestaurantSpec[] = [
  {
    slug: 'spice-route', name: 'Spice Route', owner: 'owner1', status: 'APPROVED',
    description: 'Hyderabadi biryanis, tandoor and North Indian curries.', cuisines: ['biryani', 'north-indian', 'mughlai'],
    lat: 12.9352, lng: 77.6245, line1: '88, 5th Block, Koramangala', phone: '+918041000001', businessEmail: 'hello@spiceroute.demo',
    commissionBps: 2000, packagingFeePaise: 1500, avgPrepMinutes: 25, rating: [221, 52], colors: ['#b91c1c', '#f59e0b'],
  },
  {
    slug: 'green-leaf', name: 'Green Leaf', owner: 'owner2', status: 'APPROVED',
    description: 'Pure vegetarian: South Indian tiffin, North Indian thalis and bowls.', cuisines: ['south-indian', 'north-indian', 'healthy'],
    lat: 12.9279, lng: 77.6271, line1: '12, 1st Block, Koramangala', phone: '+918041000002', businessEmail: 'namaste@greenleaf.demo',
    commissionBps: 1500, packagingFeePaise: 1000, avgPrepMinutes: 15, rating: [187, 41], colors: ['#15803d', '#a3e635'],
  },
  {
    slug: 'tandoor-tales', name: 'Tandoor Tales', owner: 'owner1', status: 'APPROVAL_PENDING',
    description: 'Clay-oven kebabs and breads.', cuisines: ['north-indian', 'mughlai'],
    lat: 12.9121, lng: 77.6446, line1: '3, 27th Main, HSR Layout Sector 1', phone: '+918041000003', businessEmail: 'kitchen@tandoortales.demo',
    commissionBps: 1800, packagingFeePaise: 1200, avgPrepMinutes: 20, colors: ['#9a3412', '#fdba74'],
  },
  {
    slug: 'coastal-curry', name: 'Coastal Curry House', owner: 'owner2', status: 'VERIFICATION_PENDING',
    description: 'Mangalorean and Malabar seafood curries.', cuisines: ['south-indian'],
    lat: 12.9409, lng: 77.6206, line1: '5, 7th Block, Koramangala', phone: '+918041000004', businessEmail: 'orders@coastalcurry.demo',
    commissionBps: 1800, packagingFeePaise: 1000, avgPrepMinutes: 25, colors: ['#0e7490', '#67e8f9'],
  },
];

function restaurantDoc(r: RestaurantSpec, fieldKey: string) {
  const id = seedId(`restaurant:${r.slug}`);
  const ownerUserId = seedId(`user:${r.owner}`);
  const at = (h: number) => new Date(SEEDED_AT.getTime() + h * 3_600_000);
  const history: Record<string, unknown>[] = [{ from: 'DRAFT', to: 'VERIFICATION_PENDING', actorId: ownerUserId, at: at(0) }];
  if (r.status !== 'VERIFICATION_PENDING') history.push({ from: 'VERIFICATION_PENDING', to: 'APPROVAL_PENDING', actorId: ownerUserId, at: at(1) });
  if (r.status === 'APPROVED') history.push({ from: 'APPROVAL_PENDING', to: 'APPROVED', actorId: seedId('user:admin'), reason: 'Demo data', at: at(2) });
  const verified = r.status === 'APPROVED';
  const accountNumber = `5010${id.replace(/[^0-9]/g, '').padEnd(10, '7').slice(0, 10)}`;
  return {
    _id: id,
    ownerUserId,
    businessName: `${r.name} Foods Pvt Ltd`,
    name: r.name,
    slug: r.slug,
    description: r.description,
    cuisines: r.cuisines,
    phone: r.phone,
    businessEmail: r.businessEmail,
    ...(r.status === 'VERIFICATION_PENDING' ? {} : { emailVerifiedAt: at(1) }),
    address: { line1: r.line1, city: 'Bengaluru', pincode: r.line1.includes('HSR') ? '560102' : '560034' },
    location: pt(r.lat, r.lng),
    deliveryRadiusKm: 6,
    hours: ALL_DAY,
    timezone: 'Asia/Kolkata',
    status: r.status,
    statusHistory: history,
    images: { cover: imageKey(r.slug, 'cover'), logo: imageKey(r.slug, 'logo') },
    documents:
      r.status === 'VERIFICATION_PENDING'
        ? []
        : DOC_TYPES.map((type) => ({ _id: seedId(`restaurant-doc:${r.slug}:${type}`), type, key: docKey(r.slug, type), verified, uploadedAt: at(1) })),
    settlement: {
      accountHolder: `${r.name} Foods Pvt Ltd`,
      accountNumberEnc: encryptField(accountNumber, fieldKey),
      ifsc: 'HDFC0001234',
      last4: accountNumber.slice(-4),
      updatedAt: at(1),
    },
    packagingFeePaise: r.packagingFeePaise,
    avgPrepMinutes: r.avgPrepMinutes,
    commissionBps: r.commissionBps,
    ratingSum: r.rating?.[0] ?? 0,
    ratingCount: r.rating?.[1] ?? 0,
    isDemo: true,
    createdAt: SEEDED_AT,
    updatedAt: at(2),
  };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function coverSvg(r: RestaurantSpec): Buffer {
  const [a, b] = r.colors;
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="600" viewBox="0 0 1200 600">` +
      `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs>` +
      `<rect width="1200" height="600" fill="url(#g)"/>` +
      `<text x="60" y="520" font-family="Georgia,serif" font-size="96" fill="#fff" fill-opacity="0.95">${esc(r.name)}</text>` +
      `<text x="1140" y="80" text-anchor="end" font-family="sans-serif" font-size="28" fill="#fff" fill-opacity="0.8">DEMO</text></svg>`,
  );
}
function logoSvg(r: RestaurantSpec): Buffer {
  const [a] = r.colors;
  const initials = r.name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">` +
      `<circle cx="128" cy="128" r="128" fill="${a}"/>` +
      `<text x="128" y="152" text-anchor="middle" font-family="Georgia,serif" font-size="96" fill="#fff">${esc(initials)}</text></svg>`,
  );
}

// ---------------------------------------------------------------------------------------- seed -----
export async function seedMarketplace(conn: Connection, cfg: MarketplaceSeedConfig): Promise<SeedReport> {
  const m = getModels(conn);
  const report: SeedReport = {};

  await ensureDocs(
    m.Cuisine,
    [
      ['north-indian', 'North Indian'],
      ['south-indian', 'South Indian'],
      ['biryani', 'Biryani'],
      ['mughlai', 'Mughlai'],
      ['healthy', 'Healthy'],
      ['chinese', 'Chinese'],
      ['desserts', 'Desserts'],
      ['beverages', 'Beverages'],
    ].map(([slug, name], i) => ({ _id: seedId(`cuisine:${slug}`), slug, name, sortOrder: i, active: true })),
    report,
  );

  await ensureDocs(
    m.ServiceArea,
    [
      {
        _id: seedId('service-area:blr-koramangala'),
        name: 'Bengaluru — Koramangala & HSR (demo)',
        polygon: {
          type: 'Polygon',
          coordinates: [[[77.58, 12.9], [77.68, 12.9], [77.68, 12.99], [77.58, 12.99], [77.58, 12.9]]],
        },
        active: true,
        deliveryFee: { basePaise: 2500, baseKm: 2, perKmPaise: 800, maxPaise: 8000 },
        minOrderPaise: 9900,
        createdAt: SEEDED_AT,
        updatedAt: SEEDED_AT,
      },
    ],
    report,
  );

  await ensureDocs(m.Restaurant, RESTAURANTS.map((r) => restaurantDoc(r, cfg.FIELD_ENCRYPTION_KEY)), report);

  for (const [rest, cats, items] of [
    ['spice-route', SPICE_ROUTE_CATEGORIES, SPICE_ROUTE_ITEMS],
    ['green-leaf', GREEN_LEAF_CATEGORIES, GREEN_LEAF_ITEMS],
    ['tandoor-tales', TANDOOR_TALES_CATEGORIES, TANDOOR_TALES_ITEMS],
  ] as const) {
    const docs = menuDocs(rest, cats, items);
    await ensureDocs(m.MenuCategory, docs.cats, report);
    await ensureDocs(m.MenuItem, docs.items, report);
  }

  const validFrom = new Date('2026-01-01T00:00:00.000Z');
  const validTo = new Date('2027-12-31T18:29:59.000Z');
  await ensureDocs(
    m.Coupon,
    [
      {
        _id: seedId('coupon:WELCOME50'),
        code: 'WELCOME50',
        description: '50% off up to ₹100 on orders above ₹199 (demo)',
        type: 'PERCENT',
        valueBps: 5000,
        maxDiscountPaise: 10000,
        minOrderPaise: 19900,
        validFrom,
        validTo,
        totalLimit: null,
        perUserLimit: 1,
        active: true,
        firstOrderOnly: false,
      },
      {
        _id: seedId('coupon:FLAT100'),
        code: 'FLAT100',
        description: '₹100 off on orders above ₹399 — only one redemption platform-wide (demo)',
        type: 'FLAT',
        valuePaise: 10000,
        minOrderPaise: 39900,
        validFrom,
        validTo,
        totalLimit: 1,
        perUserLimit: 1,
        active: true,
        firstOrderOnly: false,
      },
    ],
    report,
  );

  await ensureDocs(
    m.MembershipPlan,
    [
      {
        _id: seedId('plan:thali-plus'),
        name: 'Thali Plus',
        pricePaise: 14900,
        durationDays: 30,
        benefits: { freeDeliveryMinOrderPaise: 19900, freeDeliveriesPerPeriod: 10, extraDiscountBps: 500, extraDiscountCapPaise: 5000 },
        terms:
          '**Thali Plus (demo plan)**\n\n- Free delivery on up to 10 orders above ₹199 for 30 days\n- Extra 5% off (up to ₹50) per order\n- Prepaid, non-refundable once a benefit has been used\n- Demo mode: payment is simulated',
        active: true,
      },
    ],
    report,
  );

  // Demo files: KYC placeholders (private bucket) and cover/logo images (public bucket).
  if (cfg.S3_ENDPOINT || cfg.S3_ACCESS_KEY_ID) {
    const objects: SeedObject[] = [];
    for (const r of RESTAURANTS) {
      objects.push({ bucket: cfg.S3_PUBLIC_BUCKET, key: imageKey(r.slug, 'cover'), contentType: 'image/svg+xml', body: coverSvg(r) });
      objects.push({ bucket: cfg.S3_PUBLIC_BUCKET, key: imageKey(r.slug, 'logo'), contentType: 'image/svg+xml', body: logoSvg(r) });
      if (r.status !== 'VERIFICATION_PENDING') {
        for (const type of DOC_TYPES) {
          objects.push({ bucket: cfg.S3_PRIVATE_BUCKET, key: docKey(r.slug, type), contentType: 'application/pdf', body: demoPdf(`${r.name} ${type} certificate`) });
        }
      }
    }
    await uploadSeedObjects(
      {
        ...(cfg.S3_ENDPOINT ? { endpoint: cfg.S3_ENDPOINT } : {}),
        region: cfg.S3_REGION,
        ...(cfg.S3_ACCESS_KEY_ID ? { accessKeyId: cfg.S3_ACCESS_KEY_ID } : {}),
        ...(cfg.S3_SECRET_ACCESS_KEY ? { secretAccessKey: cfg.S3_SECRET_ACCESS_KEY } : {}),
        publicBucket: cfg.S3_PUBLIC_BUCKET,
      },
      objects,
      report,
    );
  }
  return report;
}

if (isMainModule(import.meta.url)) {
  void runSeedCli({
    service: 'marketplace',
    dbName: process.env.MONGO_DB_NAME ?? 'thali_marketplace',
    init: ensureMarketplaceIndexes,
    run: (conn) => seedMarketplace(conn, loadMarketplaceConfig()),
  });
}
