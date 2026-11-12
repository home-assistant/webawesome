import { html, type PropertyValues } from 'lit';
import { customElement, property, query, state } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { WaAfterHideEvent } from '../../events/after-hide.js';
import { WaAfterShowEvent } from '../../events/after-show.js';
import { WaHideEvent } from '../../events/hide.js';
import { WaShowEvent } from '../../events/show.js';
import { animateWithClass } from '../../internal/animate.js';
import { isTopDismissible, registerDismissible, unregisterDismissible } from '../../internal/dismissible-stack.js';
import { waitForEvent } from '../../internal/event.js';
import { uniqueId } from '../../internal/math.js';
import { watch } from '../../internal/watch.js';
import WebAwesomeElement from '../../internal/webawesome-element.js';
import WaPopup from '../popup/popup.js';
import styles from './tooltip.styles.js';

/**
 * Checks containment in the composed tree, including nodes assigned through one or more slots.
 */
function containsComposedNode(ancestor: Node, node: Node | null) {
  while (node) {
    if (node === ancestor) {
      return true;
    }

    if (node instanceof Element && node.assignedSlot) {
      node = node.assignedSlot;
    } else if (node.parentNode) {
      node = node.parentNode;
    } else if (node instanceof ShadowRoot) {
      node = node.host;
    } else {
      node = null;
    }
  }

  return false;
}

/**
 * @summary Tooltips display brief contextual information when the user hovers, focuses, or taps a target element.
 * @documentation https://webawesome.com/docs/components/tooltip
 * @status stable
 * @since 2.0
 *
 * @dependency wa-popup
 *
 * @slot - The tooltip's default slot where any content should live. Interactive content should be avoided.
 *
 * @event wa-show - Emitted when the tooltip begins to show.
 * @event wa-after-show - Emitted after the tooltip has shown and all animations are complete.
 * @event wa-hide - Emitted when the tooltip begins to hide.
 * @event wa-after-hide - Emitted after the tooltip has hidden and all animations are complete.
 *
 * @csspart base - Deprecated. Use the `tooltip` part instead.
 * @csspart tooltip - The component's outer wrapper.
 * @csspart base__popup - The popup's exported `popup` part. Use this to target the tooltip's popup container.
 * @csspart base__arrow - The popup's exported `arrow` part. Use this to target the tooltip's arrow.
 * @csspart body - The tooltip's body where its content is rendered.
 *
 * @cssproperty --max-width - The maximum width of the tooltip before its content will wrap.
 */
@customElement('wa-tooltip')
export default class WaTooltip extends WebAwesomeElement {
  static css = styles;
  static dependencies = { 'wa-popup': WaPopup };

  private hoverTimeout: number;
  private anchorAssociation: 'label' | 'description' = 'label';

  // Set when the anchor is pressed to light dismiss the tooltip. While true, hover and focus won't reopen it. Cleared
  // when the pointer fully leaves the anchor and tooltip or when the anchor blurs.
  private dismissedByPress = false;

  @query('slot:not([name])') defaultSlot: HTMLSlotElement;
  @query('.body') body: HTMLElement;
  @query('wa-popup') popup: WaPopup;

  /**
   * The preferred placement of the tooltip. Note that the actual placement may vary as needed to keep the tooltip
   * inside of the viewport.
   */
  @property() placement:
    | 'top'
    | 'top-start'
    | 'top-end'
    | 'right'
    | 'right-start'
    | 'right-end'
    | 'bottom'
    | 'bottom-start'
    | 'bottom-end'
    | 'left'
    | 'left-start'
    | 'left-end' = 'top';

  /** Disables the tooltip so it won't show when triggered. */
  @property({ type: Boolean, reflect: true }) disabled = false;

  /** The distance in pixels from which to offset the tooltip away from its target. */
  @property({ type: Number }) distance = 8;

  /** Indicates whether or not the tooltip is open. You can use this in lieu of the show/hide methods. */
  @property({ type: Boolean, reflect: true }) open = false;

  /** The distance in pixels from which to offset the tooltip along its target. */
  @property({ type: Number }) skidding = 0;

  /** The amount of time to wait before showing the tooltip when the user mouses in. */
  @property({ attribute: 'show-delay', type: Number }) showDelay = 150;

  /** The amount of time to wait before hiding the tooltip when the user mouses out. */
  @property({ attribute: 'hide-delay', type: Number }) hideDelay = 0;

  /**
   * Controls how the tooltip is activated. Possible options include `click`, `hover`, `focus`, and `manual`. Multiple
   * options can be passed by separating them with a space. When manual is used, the tooltip must be activated
   * programmatically.
   */
  @property() trigger = 'hover focus';

  /** Removes the arrow from the tooltip. */
  @property({ attribute: 'without-arrow', type: Boolean, reflect: true }) withoutArrow = false;

  /**
   * How the tooltip is associated with its anchor. Use `description` for supplementary information, such as keyboard
   * shortcuts, to preserve the anchor's accessible name. The default `label` uses `aria-labelledby`.
   */
  @property() association: 'label' | 'description' = 'label';

  @property() for: string | null = null;

  @state() anchor: null | Element = null;

  private eventController = new AbortController();

  connectedCallback() {
    super.connectedCallback();

    const isClient = typeof document !== 'undefined';

    if (isClient) {
      // Recreate event controller if it was aborted
      if (this.eventController.signal.aborted) {
        this.eventController = new AbortController();
      }

      this.addEventListener('mouseout', this.handleMouseOut);

      // The events that re-arm the tooltip after a light dismiss can be missed while disconnected
      this.dismissedByPress = false;

      // TODO: This is a hack that I need to revisit [Konnor]
      if (this.open) {
        this.open = false;
        this.updateComplete.then(() => {
          this.open = true;
        });
      }

      // If the user doesn't give us an id, generate one.
      if (!this.id) {
        this.id = uniqueId('wa-tooltip-');
      }

      // Re-establish anchor connection after being disconnected
      if (this.for && this.anchor) {
        this.anchor = null; // force reattach
        this.handleForChange();
      } else if (this.for) {
        // Initial connection
        this.handleForChange();
      }
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();

    // Cleanup these events in case the tooltip is removed while open
    document.removeEventListener('keydown', this.handleDocumentKeyDown);
    document.removeEventListener('click', this.handleDocumentClick);
    unregisterDismissible(this);
    this.eventController.abort();

    if (this.anchor) {
      this.removeAriaAssociation(this.anchor);
    }
  }

  firstUpdated(changedProperties: PropertyValues<typeof this>) {
    this.body.hidden = !this.open;

    // If the tooltip is visible on init, update its position
    if (this.open) {
      this.popup.active = true;
      this.popup.reposition();
    }
    super.firstUpdated(changedProperties);
  }

  private handleBlur = () => {
    // Moving focus away re-arms the tooltip after a light dismiss. On touch devices no mouseout fires, so this is the
    // reset path.
    this.dismissedByPress = false;

    if (this.hasTrigger('focus')) {
      this.hide();
    }
  };

  private handleClick = () => {
    if (this.hasTrigger('click')) {
      if (this.open) {
        this.hide();
      } else {
        this.show();
      }
      return;
    }

    if (this.hasTrigger('manual')) {
      return;
    }

    // Light dismiss for activations that don't fire mousedown, like Enter or Space on a button.
    this.lightDismiss();
  };

  private handleFocus = () => {
    if (this.dismissedByPress) {
      return;
    }

    if (this.hasTrigger('focus')) {
      this.show();
    }
  };

  private handleMouseDown = () => {
    if (this.hasTrigger('click') || this.hasTrigger('manual')) {
      return;
    }

    // Light dismiss before focus fires so the tooltip doesn't flash visible during the click.
    this.lightDismiss();
  };

  /** Hides the tooltip, or cancels a pending show, and keeps it hidden until re-armed. */
  private lightDismiss() {
    clearTimeout(this.hoverTimeout);
    this.dismissedByPress = true;
    this.hide();
  }

  private handleDocumentKeyDown = (event: KeyboardEvent) => {
    if (this.hasTrigger('manual')) {
      return;
    }

    // Pressing escape when a tooltip is open should dismiss it
    if (event.key === 'Escape' && this.open && isTopDismissible(this)) {
      event.preventDefault();
      event.stopPropagation();
      this.hide();
    }
  };

  private handleDocumentClick = (event: MouseEvent) => {
    if (this.hasTrigger('manual')) {
      return;
    }

    // Clicks on the anchor are handled by the anchor's own listeners
    if (this.anchor && event.composedPath().includes(this.anchor)) {
      return;
    }

    // Light dismiss. Clicking anywhere else, including the tooltip itself, hides it.
    this.hide();
  };

  private handleMouseOver = () => {
    if (this.dismissedByPress) {
      return;
    }

    if (this.hasTrigger('hover')) {
      clearTimeout(this.hoverTimeout);

      this.hoverTimeout = window.setTimeout(() => this.show(), this.showDelay);
    }
  };

  private handleMouseOut = (event: MouseEvent) => {
    const relatedTarget = event.relatedTarget as Node | null;

    // Use the event's relatedTarget (the element the pointer moved to) to determine whether the pointer is still within
    // the anchor or the tooltip itself. Relying on `:hover` matching here is unreliable in Chrome when the pointer
    // moves onto a slotted child element of the tooltip, since the host's `:hover` state can briefly report false
    // during that transition.
    const movedIntoAnchor = Boolean(relatedTarget && this.anchor && containsComposedNode(this.anchor, relatedTarget));
    const movedIntoTooltip = Boolean(relatedTarget && containsComposedNode(this, relatedTarget));

    if (movedIntoAnchor || movedIntoTooltip) {
      return;
    }

    // The pointer has fully left, so hovering can show the tooltip again after a light dismiss
    this.dismissedByPress = false;

    if (this.hasTrigger('hover')) {
      clearTimeout(this.hoverTimeout);

      this.hoverTimeout = window.setTimeout(() => {
        this.hide();
      }, this.hideDelay);
    }
  };

  private hasTrigger(triggerType: string) {
    const triggers = this.trigger.split(' ');
    return triggers.includes(triggerType);
  }

  private associationAttribute(association: 'label' | 'description') {
    return association === 'description' ? 'aria-describedby' : 'aria-labelledby';
  }

  private addAriaAssociation(element: Element) {
    this.anchorAssociation = this.association;
    const attribute = this.associationAttribute(this.association);
    const ids = (element.getAttribute(attribute) || '').split(/\s+/).filter(Boolean);

    if (!ids.includes(this.id)) {
      ids.push(this.id);
      element.setAttribute(attribute, ids.join(' '));
    }
  }

  private removeAriaAssociation(element: Element) {
    const attribute = this.associationAttribute(this.anchorAssociation);
    const ids = (element.getAttribute(attribute) || '').split(/\s+/).filter(id => id && id !== this.id);

    if (ids.length > 0) {
      element.setAttribute(attribute, ids.join(' '));
    } else {
      element.removeAttribute(attribute);
    }
  }

  @watch('association')
  handleAssociationChange() {
    if (this.anchor) {
      this.removeAriaAssociation(this.anchor);
      this.addAriaAssociation(this.anchor);
    }
  }

  @watch('open', { waitUntilFirstUpdate: true })
  async handleOpenChange() {
    if (this.open) {
      if (this.disabled) {
        return;
      }

      // Show
      const waShowEvent = new WaShowEvent();
      this.dispatchEvent(waShowEvent);
      if (waShowEvent.defaultPrevented) {
        this.open = false;
        return;
      }

      // Manual tooltips never light dismiss, so they skip the document listeners and the dismissible
      // stack. Joining the stack without handling Escape would block dismissibles beneath them.
      if (!this.hasTrigger('manual')) {
        document.addEventListener('keydown', this.handleDocumentKeyDown, { signal: this.eventController.signal });
        document.addEventListener('click', this.handleDocumentClick, { signal: this.eventController.signal });
        registerDismissible(this);
      }

      this.body.hidden = false;
      this.popup.active = true;
      await animateWithClass(this.popup.popup, 'show-with-scale');
      this.popup.reposition();

      this.dispatchEvent(new WaAfterShowEvent());
    } else {
      // Hide
      const waHideEvent = new WaHideEvent();
      this.dispatchEvent(waHideEvent);
      if (waHideEvent.defaultPrevented) {
        this.open = true;
        return;
      }

      document.removeEventListener('keydown', this.handleDocumentKeyDown);
      document.removeEventListener('click', this.handleDocumentClick);
      unregisterDismissible(this);

      await animateWithClass(this.popup.popup, 'hide-with-scale');
      this.popup.active = false;
      this.body.hidden = true;

      this.dispatchEvent(new WaAfterHideEvent());
    }
  }

  @watch('for')
  handleForChange() {
    const rootNode = this.getRootNode?.() as Document | ShadowRoot | null;

    if (!rootNode) {
      return;
    }

    const newAnchor = this.for ? rootNode.getElementById?.(this.for) : null;
    const oldAnchor = this.anchor;

    if (newAnchor === oldAnchor) {
      return;
    }

    // A new anchor must not inherit press dismissal state from the old one
    this.dismissedByPress = false;

    const { signal } = this.eventController;

    if (oldAnchor) {
      this.removeAriaAssociation(oldAnchor);
      oldAnchor.removeEventListener('blur', this.handleBlur, { capture: true });
      oldAnchor.removeEventListener('focus', this.handleFocus, { capture: true });
      oldAnchor.removeEventListener('click', this.handleClick);
      oldAnchor.removeEventListener('mousedown', this.handleMouseDown);
      oldAnchor.removeEventListener('mouseover', this.handleMouseOver);
      oldAnchor.removeEventListener('mouseout', this.handleMouseOut);
    }

    if (newAnchor) {
      /**
       * By default, we use `aria-labelledby` because it seems to have the most consistent screen reader experience.
       * Particularly for our "special" focusable elements like `<wa-button>`, `<wa-input>` etc.
       * aria-describedby usually in some screen readers is required to be on the actually focusable element,
       * whereas with `aria-labelledby` it'll still read on first focus. The APG does and WAI-ARIA does recommend aria-describedby
       * so perhaps once we have cross-root aria, we can revisit this decision.
       */
      this.addAriaAssociation(newAnchor);

      newAnchor.addEventListener('blur', this.handleBlur, { capture: true, signal });
      newAnchor.addEventListener('focus', this.handleFocus, { capture: true, signal });
      newAnchor.addEventListener('click', this.handleClick, { signal });
      newAnchor.addEventListener('mousedown', this.handleMouseDown, { signal });
      newAnchor.addEventListener('mouseover', this.handleMouseOver, { signal });
      newAnchor.addEventListener('mouseout', this.handleMouseOut, { signal });
    }

    this.anchor = newAnchor;
  }

  @watch(['distance', 'placement', 'skidding'])
  async handleOptionsChange() {
    if (this.hasUpdated) {
      await this.updateComplete;
      this.popup.reposition();
    }
  }

  @watch('disabled')
  handleDisabledChange() {
    if (this.disabled && this.open) {
      this.hide();
    }
  }

  /** Shows the tooltip. */
  async show() {
    if (this.open) {
      return undefined;
    }

    this.open = true;
    return waitForEvent(this, 'wa-after-show');
  }

  /** Hides the tooltip */
  async hide() {
    if (!this.open) {
      return undefined;
    }

    this.open = false;
    return waitForEvent(this, 'wa-after-hide');
  }

  render() {
    return html`
      <wa-popup
        part="base tooltip"
        exportparts="
          popup:base__popup,
          arrow:base__arrow
        "
        class=${classMap({
          tooltip: true,
          'tooltip-open': this.open,
        })}
        placement=${this.placement}
        distance=${this.distance}
        skidding=${this.skidding}
        flip
        shift
        ?arrow=${!this.withoutArrow}
        hover-bridge
        .anchor=${this.anchor}
      >
        <div part="body" class="body">
          <slot></slot>
        </div>
      </wa-popup>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'wa-tooltip': WaTooltip;
  }
}
