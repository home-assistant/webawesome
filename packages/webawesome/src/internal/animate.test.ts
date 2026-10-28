import { expect, fixture } from '@open-wc/testing';
import { emulateMedia } from '@web/test-runner-commands';
import { html } from 'lit';
import sinon from 'sinon';
import { animate } from './animate.js';

describe('animate()', () => {
  afterEach(async () => {
    await emulateMedia({ reducedMotion: 'no-preference' });
  });

  it('should animate for the given duration', async () => {
    const el = await fixture<HTMLDivElement>(html`<div></div>`);
    const spy = sinon.spy(el, 'animate');

    animate(el, [{ opacity: 0 }, { opacity: 1 }], { duration: 10000 });

    expect(spy.firstCall.args[1]).to.deep.equal({ duration: 10000 });
    spy.firstCall.returnValue.cancel();
  });

  it('should finish at once when the user prefers reduced motion', async () => {
    const el = await fixture<HTMLDivElement>(html`<div></div>`);
    const spy = sinon.spy(el, 'animate');
    await emulateMedia({ reducedMotion: 'reduce' });

    // Would time out the test if it ran for the given duration
    await animate(el, [{ opacity: 0 }, { opacity: 1 }], { duration: 10000, delay: 1000, easing: 'ease' });

    expect(spy.firstCall.args[1]).to.deep.equal({ duration: 0, delay: 0, easing: 'ease' });
  });
});
