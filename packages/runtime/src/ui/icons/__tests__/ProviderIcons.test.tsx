import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MaterialSymbol } from '../MaterialSymbol';
import { ProviderIcon, getProviderIcon, resolveProviderIcon } from '../ProviderIcons';

describe('ProviderIcons', () => {
  describe('resolveProviderIcon', () => {
    it('returns known alias for openai-codex-acp', () => {
      expect(resolveProviderIcon('openai-codex-acp')).toBe('openai-codex');
    });

    it('passes through unknown provider ids', () => {
      expect(resolveProviderIcon('synthetic')).toBe('synthetic');
      expect(resolveProviderIcon('lmstudio')).toBe('lmstudio');
    });
  });

  describe('MaterialSymbol', () => {
    it('renders custom icons for built-in providers', () => {
      const html = renderToStaticMarkup(<MaterialSymbol icon="synthetic" size={16} />);
      expect(html).toContain('<svg');
      expect(html).toContain('aria-label="Synthetic.new"');
      expect(html).not.toContain('material-symbols-outlined');
    });

    it('renders synthetic as an inline logo (not a fallback glyph)', () => {
      // Regression: before, synthetic was unknown to Material Symbols so the
      // icon rendered as the literal text "synthetic" instead of a glyph.
      const html = renderToStaticMarkup(<MaterialSymbol icon="synthetic" size={16} />);
      expect(html).toMatch(/<svg[^>]+aria-label="Synthetic\.new"/);
      expect(html).toContain('M27.8517 26.3314');
      expect(html).not.toMatch(/>\s*synthetic\s*</);
    });

    it('falls back to a material-symbols-outlined span for unknown icons', () => {
      const html = renderToStaticMarkup(<MaterialSymbol icon="definitely-not-a-real-icon" size={16} />);
      expect(html).toContain('material-symbols-outlined');
      expect(html).toContain('definitely-not-a-real-icon');
    });
  });

  describe('getProviderIcon', () => {
    it('renders the Synthetic inline SVG logo', () => {
      const html = renderToStaticMarkup(<>{getProviderIcon('synthetic', { size: 16 })}</>);
      expect(html).toContain('<svg');
      expect(html).toContain('Synthetic.new');
    });

    it('renders a custom SVG for lmstudio', () => {
      const html = renderToStaticMarkup(<>{getProviderIcon('lmstudio', { size: 16 })}</>);
      expect(html).toContain('<svg');
    });
  });

  describe('ProviderIcon', () => {
    it('renders the Synthetic inline SVG logo', () => {
      const html = renderToStaticMarkup(<ProviderIcon provider="synthetic" size={16} />);
      expect(html).toContain('<svg');
      expect(html).toContain('Synthetic.new');
    });
  });
});
