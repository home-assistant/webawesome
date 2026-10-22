import { expect } from '@open-wc/testing';
import { emulateMedia } from '@web/test-runner-commands';
import { html } from 'lit';
import { fixtures } from '../../internal/test/fixture.js';
import type WaSpinner from './spinner.js';

describe('<wa-spinner>', () => {
  for (const fixture of fixtures) {
    describe(`with "${fixture.type}" rendering`, () => {
      describe('accessibility', () => {
        it('should pass accessibility tests', async () => {
          const el = await fixture<WaSpinner>(html`<wa-spinner></wa-spinner>`);
          await expect(el).to.be.accessible();
        });

        it('should have role="progressbar" on the base part', async () => {
          const el = await fixture<WaSpinner>(html`<wa-spinner></wa-spinner>`);
          const base = el.shadowRoot!.querySelector('[part~="base"]')!;
          expect(base).to.have.attribute('role', 'progressbar');
        });

        it('should have an aria-label for loading', async () => {
          const el = await fixture<WaSpinner>(html`<wa-spinner></wa-spinner>`);
          const base = el.shadowRoot!.querySelector('[part~="base"]')!;
          expect(base).to.have.attribute('aria-label');
        });
      });

      describe('CSS parts', () => {
        it('should have a base part', async () => {
          const el = await fixture<WaSpinner>(html`<wa-spinner></wa-spinner>`);
          expect(el.shadowRoot!.querySelector('[part~="base"]')).to.exist;
        });
      });

      describe('reduced motion', () => {
        afterEach(async () => {
          await emulateMedia({ reducedMotion: 'no-preference' });
        });

        it('should hold the spinner and its arc still', async () => {
          const el = await fixture<WaSpinner>(html`<wa-spinner></wa-spinner>`);
          const svg = el.shadowRoot!.querySelector('svg')!;
          const indicator = el.shadowRoot!.querySelector('.indicator')!;

          expect(getComputedStyle(svg).animationName).to.equal('spin');
          expect(getComputedStyle(indicator).animationName).to.equal('dash');

          await emulateMedia({ reducedMotion: 'reduce' });
          expect(getComputedStyle(svg).animationName).to.equal('none');
          expect(getComputedStyle(indicator).animationName).to.equal('none');
        });
      });

      describe('rendering', () => {
        it('should have flex:none to prevent flex re-sizing', async () => {
          const el = await fixture<WaSpinner>(html`<wa-spinner></wa-spinner>`);
          // 0 0 auto is the computed value for `none`
          expect(getComputedStyle(el).flex).to.equal('0 0 auto');
        });
      });
    });
  }
});
