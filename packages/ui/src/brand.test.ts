import { applyBrandColor, clearBrandColor, isValidBrandColor } from './brand';

describe('brand color', () => {
  it('accepts 3- and 6-digit hex colors', () => {
    expect(isValidBrandColor('#0e7c6b')).toBe(true);
    expect(isValidBrandColor('#ABC')).toBe(true);
  });

  it('rejects anything else, including CSS injection attempts', () => {
    expect(isValidBrandColor('red')).toBe(false);
    expect(isValidBrandColor('#12345')).toBe(false);
    expect(isValidBrandColor('#fff; background: url(x)')).toBe(false);
  });

  it('sets the brand variables only for valid colors, and clears them', () => {
    const el = document.createElement('div');
    expect(applyBrandColor('#c0392b', el, '#f0a99f')).toBe(true);
    expect(el.style.getPropertyValue('--hb-brand-custom')).toBe('#c0392b');
    expect(el.style.getPropertyValue('--hb-brand-custom-dark')).toBe('#f0a99f');
    expect(applyBrandColor('not-a-color', el)).toBe(false);
    expect(el.style.getPropertyValue('--hb-brand-custom')).toBe('#c0392b');
    clearBrandColor(el);
    expect(el.style.getPropertyValue('--hb-brand-custom')).toBe('');
    expect(el.style.getPropertyValue('--hb-brand-custom-dark')).toBe('');
  });
});
