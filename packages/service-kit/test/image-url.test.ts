import { describe, expect, it } from 'vitest';
import { DEFAULT_EXTERNAL_IMAGE_HOSTS, parseExternalImageHosts, resolveImageUrl } from '@thali/service-kit';

const storage = { publicUrl: (key: string) => `http://localhost:9000/thali-public/${key}` };
const allow = ['live.staticflickr.com', '*.wikimedia.org'];

describe('resolveImageUrl (MKT-10)', () => {
  it('returns null for an empty ref', () => {
    expect(resolveImageUrl(storage, null, allow)).toBeNull();
    expect(resolveImageUrl(storage, undefined, allow)).toBeNull();
    expect(resolveImageUrl(storage, '', allow)).toBeNull();
    expect(resolveImageUrl(storage, '   ', allow)).toBeNull();
  });

  it('maps storage keys through storage.publicUrl', () => {
    expect(resolveImageUrl(storage, 'images/demo/spice/cover.svg', allow)).toBe('http://localhost:9000/thali-public/images/demo/spice/cover.svg');
  });

  it('passes an allowlisted https URL through unchanged (exact host or *.suffix)', () => {
    const flickr = 'https://live.staticflickr.com/65535/123_abc_b.jpg';
    expect(resolveImageUrl(storage, flickr, allow)).toBe(flickr);
    const wiki = 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Dosa.jpg';
    expect(resolveImageUrl(storage, wiki, allow)).toBe(wiki);
    expect(resolveImageUrl(storage, 'https://LIVE.staticflickr.com/x.jpg', allow)).toBe('https://LIVE.staticflickr.com/x.jpg');
  });

  it('never renders a non-allowlisted or non-https absolute URL', () => {
    expect(resolveImageUrl(storage, 'https://evil.example.com/x.jpg', allow)).toBeNull();
    expect(resolveImageUrl(storage, 'http://live.staticflickr.com/x.jpg', allow)).toBeNull();
    expect(resolveImageUrl(storage, 'https://wikimedia.org/x.jpg', allow)).toBeNull(); // *.suffix = subdomains only
    expect(resolveImageUrl(storage, 'https://notwikimedia.org/x.jpg', allow)).toBeNull();
    expect(resolveImageUrl(storage, 'https://live.staticflickr.com.evil.com/x.jpg', allow)).toBeNull();
    expect(resolveImageUrl(storage, 'https://user@live.staticflickr.com/x.jpg', allow)).toBeNull();
    expect(resolveImageUrl(storage, 'https://live.staticflickr.com:8443/x.jpg', allow)).toBeNull();
    expect(resolveImageUrl(storage, '//live.staticflickr.com/x.jpg', allow)).toBeNull();
    expect(resolveImageUrl(storage, 'javascript:alert(1)', allow)).toBeNull();
    expect(resolveImageUrl(storage, 'data:image/png;base64,AAAA', allow)).toBeNull();
    expect(resolveImageUrl(storage, 'https://live.staticflickr.com/x.jpg', [])).toBeNull();
  });
});

describe('parseExternalImageHosts', () => {
  it('defaults when unset or blank', () => {
    expect(DEFAULT_EXTERNAL_IMAGE_HOSTS).toEqual(['live.staticflickr.com', 'upload.wikimedia.org', 'randomuser.me']);
    expect(parseExternalImageHosts(undefined)).toEqual(DEFAULT_EXTERNAL_IMAGE_HOSTS);
    expect(parseExternalImageHosts('')).toEqual(DEFAULT_EXTERNAL_IMAGE_HOSTS);
    expect(parseExternalImageHosts('  ')).toEqual(DEFAULT_EXTERNAL_IMAGE_HOSTS);
  });

  it('splits, trims, lowercases and dedupes; accepts *.suffix entries', () => {
    expect(parseExternalImageHosts(' CDN.Example.com, *.cloudfront.net ,,cdn.example.com')).toEqual(['cdn.example.com', '*.cloudfront.net']);
  });

  it('"none" disables external images', () => {
    expect(parseExternalImageHosts('none')).toEqual([]);
  });

  it('rejects malformed entries', () => {
    expect(() => parseExternalImageHosts('https://cdn.example.com')).toThrow(/EXTERNAL_IMAGE_HOSTS/);
    expect(() => parseExternalImageHosts('*')).toThrow(/EXTERNAL_IMAGE_HOSTS/);
    expect(() => parseExternalImageHosts('cdn.example.com/path')).toThrow(/EXTERNAL_IMAGE_HOSTS/);
  });
});
