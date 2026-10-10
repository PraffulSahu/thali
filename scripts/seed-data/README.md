# Thali - Bangalore seed dataset (data files only)

Realistic, researched demo data so the app looks like a live Bengaluru marketplace (500-1,000 vendors and users).
Nothing here is executable; a seeder under `scripts/` is expected to read these JSON files, combine them
(restaurant name x locality x cuisine x dishes x images x people x avatars) and write to the services.
All JSON is UTF-8, pretty-printed. Money is **integer paise**.

Restaurant and person names are fictional. Generic names may coincide with tiny local eateries, but no well-known
brand or trademark is used. Photos are real CC-licensed photographs (see `CREDITS.md`) and are hot-linked.

## Files

### `localities.json` - array of 71 real Bengaluru localities
| field | type | notes |
|---|---|---|
| `name` | string | e.g. `"Koramangala 5th Block"` |
| `pincode` | string | 6-digit postal code (checked against OSM / Nominatim, hand-corrected where OSM was noisy) |
| `lat`, `lng` | number | centroid, 5 decimals, from OpenStreetMap Nominatim |
| `zone` | string | `central` / `north` / `south` / `east` / `west` relative to the Vidhana Soudha centre |
| `streets` | string[] | 5-8 real road / main / landmark names to build addresses (`"<n>, <street>, <name>, Bengaluru <pincode>"`) |

### `cuisines.json` - 18 cuisine categories
`slug`, `name`, `imageId` (-> `images.json`, kind `cuisine`), `weight` (rough % share of Bengaluru restaurants; sums to 100;
informed by Bengaluru listing mixes where Chinese, North Indian, South Indian and biryani lead, with darshini/tiffin
South Indian weighted up because listing counts under-represent them).

### `dishes.json` - array of dishes (>= 25 per cuisine)
| field | type | notes |
|---|---|---|
| `id` | string | stable slug |
| `cuisine` | string | a cuisine `slug` |
| `name`, `description` | string | description is one line |
| `isVeg` | boolean | egg dishes are `false` (Indian convention) |
| `basePricePaise` | int | typical 2025-26 Bengaluru delivery-app price for the base variant |
| `menuSection` | string | e.g. `"Biryani"`, `"Kebabs"`, `"Breads"`, `"Desserts"`, `"Beverages"` |
| `tags` | string[] | subset of `bestseller`, `spicy`, `chef-special` |
| `variants` | optional `{name, options:[{name, priceDeltaPaise, default?}]}` | one option has delta 0 and `default: true` (= base price); e.g. Half/Full, Regular/Medium/Large, 6/10 pcs |
| `addonGroups` | optional array of `{name, min, max, options:[{name, pricePaise}]}` | `min:1,max:1` = required single choice (e.g. spice level) |
| `imageIds` | string[] | 1-3 ids from `images.json` (kind `dish`); popular (`bestseller`) dishes get 2-3 |

### `restaurant-names.json` - fictional restaurant names grouped by primary cuisine
`{ "cuisines": { "<slug>": [ {name, type, veg, priceBand, description, secondaryCuisines[]} ] } }`
- `type`: `darshini | tiffin-room | military-hotel | cloud-kitchen | family-restaurant | quick-service | cafe`
- `veg`: `pure-veg | non-veg | veg-and-non-veg`; `priceBand`: `budget | mid | premium`
- `secondaryCuisines`: other cuisine slugs the restaurant also serves (the seeder can pull dishes from them).

### `people.json` - array of 1,800 unique Indian person names
`firstName`, `lastName`, `fullName`, `gender` (`male|female`, used to pick a matching avatar), `community`
(`kannada, tamil, telugu, malayali, marathi, bengali, north, christian, muslim` - mix weighted to Bengaluru).

### `avatars.json` - 200 profile photos (randomuser.me portraits, free to use)
`id`, `gender`, `url` (128 px portrait), `thumbUrl` (thumbnail), `license`, `sourceUrl`. 100 men + 100 women; match on `gender`.

### `images.json` - image manifest (CC-licensed photos)
| field | notes |
|---|---|
| `id` | slug (`dish-...`, `cover-NNN-...`, `cuisine-<slug>`, `hero-NN`) |
| `kind` | `dish` \| `cuisine` \| `restaurant-cover` \| `hero` |
| `subject` | dish / cuisine name; for covers a hint like `interior / cafe` |
| `title`, `creator`, `license`, `licenseUrl`, `sourceUrl`, `source` | attribution (`wikimedia-commons` or `flickr`) |
| `url` | ~640-960 px wide (Wikimedia `960px` thumbnail; Flickr `_z` 640) |
| `thumbUrl` | ~320-330 px (Wikimedia `330px`; Flickr `_n` 320) |
| `width`, `height` | original pixel size |
| `tags` | cover/dish hints (`interior`, `cafe`, `spread`, `bakery`, `street-food`, cuisine slug ...) for choosing a fitting cover per restaurant |

Verification: every thumbUrl was downloaded and decoded during curation; all Flickr urls, all avatar urls and a ~25% sample of the Wikimedia 960px urls were re-fetched (HTTP 200, image/*). See the build report.

### `CREDITS.md`
Attribution table for every image (subject, title, creator, licence, source link) as CC BY / CC BY-SA require.
