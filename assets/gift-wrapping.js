if (!customElements.get('remove-gift-wrap')) {
  customElements.define(
    'remove-gift-wrap',
    class RemoveGiftWrap extends HTMLAnchorElement {
      constructor() {
        super();

        this.addEventListener('click', this.onClick.bind(this));
      }

      get cartItems() {
        return this.closest('cart-items');
      }

      onClick(event) {
        event.preventDefault();
        this.cartItems.enableLoading(this.getAttribute('data-index'));

        const giftWrapping = document.querySelector('gift-wrapping');
        giftWrapping.removeGiftWrap();
      }
    }, { extends: 'a' }
  );
}

if (!customElements.get('gift-wrapping')) {
  customElements.define(
    'gift-wrapping',
    class GiftWrapping extends HTMLElement {
      constructor() {
        super();

        this.giftWrapId = this.getAttribute('data-gift-wrap-id');
        this.giftWrapping = this.getAttribute('data-gift-wrapping');
        this.cartItemsSize = parseInt(this.getAttribute('cart-items-size'));
        this.giftWrapsInCart = parseInt(this.getAttribute('gift-wraps-in-cart'));
        this.itemsInCart = parseInt(this.getAttribute('items-in-cart'));
      }

      get selector() {
        return this.querySelector(`[name="attributes[${theme.cartStrings.giftWrapAttribute}]"]`);
      }

      connectedCallback() {
        if (this.selector === null) return;

        // When the gift-wrapping checkbox is checked or unchecked.
        this.selector.addEventListener('change', theme.utils.debounce((event) => {
          event.target.checked ? this.setGiftWrap() : this.removeGiftWrap();
        }, 300));

        // If we have nothing but gift-wrap items in the cart.
        if (this.cartItemsSize == 1 && this.giftWrapsInCart > 0) {
          return this.removeGiftWrap();
        }
        // If we don't have the right amount of gift-wrap items in the cart.
        if (this.giftWrapsInCart > 0 & this.giftWrapsInCart != this.itemsInCart) {
          return this.setGiftWrap();
        }
        // If we have a gift-wrap item in the cart but our gift-wrapping cart attribute has not been set.
        if (this.giftWrapsInCart > 0 && this.giftWrapping.length == 0) {
          return this.setGiftWrap();
        }
        // If we have no gift-wrap item in the cart but our gift-wrapping cart attribute has been set.
        if (this.giftWrapsInCart == 0 && this.giftWrapping.length > 0) {
          return this.setGiftWrap();
        }
      }

      setGiftWrap() {
        this.enableLoading();

        let sectionsToBundle = [];
        document.documentElement.dispatchEvent(new CustomEvent('cart:bundled-sections', { bubbles: true, detail: { sections: sectionsToBundle } }));

        const body = JSON.stringify({
          updates: {
            [this.giftWrapId]: this.itemsInCart
          },
          attributes: {
            [theme.cartStrings.giftWrapAttribute]: theme.cartStrings.giftWrapBooleanTrue
          },
          sections: sectionsToBundle
        });

        this.fetchGiftWrap(body);
      }

      removeGiftWrap() {
        this.enableLoading();

        let sectionsToBundle = [];
        document.documentElement.dispatchEvent(new CustomEvent('cart:bundled-sections', { bubbles: true, detail: { sections: sectionsToBundle } }));

        const body = JSON.stringify({
          updates: {
            [this.giftWrapId]: 0
          },
          attributes: {
            [theme.cartStrings.giftWrapAttribute]: '',
            [theme.cartStrings.giftNoteAttribute]: ''
          },
          sections: sectionsToBundle
        });

        this.fetchGiftWrap(body);
      }

      fetchGiftWrap(body) {
        fetch(theme.routes.cart_update_url, { ...theme.utils.fetchConfig(), ...{ body } })
          .then((response) => response.json())
          .then((parsedState) => {
            theme.pubsub.publish(theme.pubsub.PUB_SUB_EVENTS.cartUpdate, { source: 'gift-wrapping', cart: parsedState });
          })
          .catch((error) => {
            console.log(error);
          });
      }

      enableLoading() {
        const loader = this.querySelector('.loader');
        if (loader) loader.hidden = false;
      }
    }
  );
}

if (!customElements.get('gift-note')) {
  customElements.define(
    'gift-note',
    class GiftNote extends HTMLElement {
      constructor() {
        super();

        this.addEventListener('change', theme.utils.debounce(this.onChange.bind(this), 300));
      }

      onChange(event) {
        const body = JSON.stringify({
          attributes: {
            [theme.cartStrings.giftNoteAttribute]: event.target.value
          }
        });
        fetch(theme.routes.cart_update_url, {...theme.utils.fetchConfig(), ...{ body }});
      }
    }
  );
}

if (!customElements.get('gift-wrap-selector')) {
  customElements.define(
    'gift-wrap-selector',
    class GiftWrapSelector extends HTMLElement {
      constructor() {
        super();

        this.giftWrapId = this.getAttribute('data-gift-wrap-id');
        this.lineItemIndex = parseInt(this.getAttribute('data-line-item-index'));
        this.giftItemIndex = parseInt(this.getAttribute('data-gift-item-index'));
      }

      get cartItems() {
        return this.closest('cart-items');
      }

      get lineItem() {
        const item = this.querySelector('script[type="application/json"][data-line-item]')?.textContent;
        return !!item ? JSON.parse(item) : {};
      }

      get giftItem() {
        const item = this.querySelector('script[type="application/json"][data-gift-item]')?.textContent;
        return !!item ? JSON.parse(item) : {};
      }

      connectedCallback() {
        this.addEventListener('change', this.onChange.bind(this));

        if (this.lineItem.properties[theme.cartStrings.giftWrapAttribute] === theme.cartStrings.giftWrapBooleanTrue && !this.giftItem.hasOwnProperty('key')) {
          this.unsetGiftWrap();
        }
      }

      onChange(event) {
        event.preventDefault();
        event.stopPropagation();
        const input = event.target;

        const isChecked = input.type == 'checkbox' ? input.checked : input.value == theme.cartStrings.giftWrapBooleanTrue;
        isChecked ? this.setGiftWrap() : this.unsetGiftWrap();
      }

      setGiftWrap() {
        this.cartItems.enableLoading(this.lineItem.key);

        // Remove target product
        let body = JSON.stringify({
          id: this.lineItem.key,
          quantity: 0
        });
        
        fetch(theme.routes.cart_change_url, { ...theme.utils.fetchConfig(), ...{ body } })
          .then((response) => response.json())
          .then((parsedState) => {
            if (parsedState.errors) {
              theme.pubsub.publish(theme.pubsub.PUB_SUB_EVENTS.cartUpdate, { source: 'gift-wrap', cart: parsedState });
              return;
            }

            // Re-add target product and gift wrapping to cart
            let sectionsToBundle = [];
            document.documentElement.dispatchEvent(new CustomEvent('cart:bundled-sections', { bubbles: true, detail: { sections: sectionsToBundle } }));
            
            const lineItemProps = {
              ...this.lineItem.properties,
              [theme.cartStrings.giftWrapAttribute]: theme.cartStrings.giftWrapBooleanTrue
            };
            let body = JSON.stringify({
              items: [
                {
                  id: this.lineItem.variant_id,
                  quantity: this.lineItem.quantity,
                  properties: lineItemProps
                },
                {
                  id: this.giftWrapId,
                  quantity: this.lineItem.quantity,
                  properties: {
                    [theme.cartStrings.targetProductAttribute]: this.lineItem.title
                  },
                  parent_id: this.lineItem.variant_id
                }
              ],
              sections: sectionsToBundle
            });

            fetch(theme.routes.cart_add_url, { ...theme.utils.fetchConfig('javascript'), body })
              .then((response) => response.json())
              .then(async (parsedState) => {
                const cartJson = await (await fetch(theme.routes.cart_url, { ...theme.utils.fetchConfig('json', 'GET')})).json();
                cartJson['sections'] = parsedState['sections'];
                theme.pubsub.publish(theme.pubsub.PUB_SUB_EVENTS.cartUpdate, { source: 'gift-wrap', cart: cartJson });
              });
          })
          .catch((error) => {
            console.error(error);
          });
      }

      unsetGiftWrap() {
        this.cartItems.enableLoading(this.lineItem.key);

        // Remove target product and gift wrapping
        let updates = {
          [this.lineItem.key]: 0
        };
        if (this.giftItem.hasOwnProperty('key')) {
          updates[this.giftItem.key] = 0;
        }

        let body = JSON.stringify({ updates });

        fetch(theme.routes.cart_update_url, { ...theme.utils.fetchConfig(), ...{ body } })
          .then((response) => response.json())
          .then((parsedState) => {
            if (parsedState.errors) {
              theme.pubsub.publish(theme.pubsub.PUB_SUB_EVENTS.cartUpdate, { source: 'gift-wrap', cart: parsedState });
              return;
            }
            
            // Re-add target product to cart
            let sectionsToBundle = [];
            document.documentElement.dispatchEvent(new CustomEvent('cart:bundled-sections', { bubbles: true, detail: { sections: sectionsToBundle } }));

            const lineItemProps = { ...this.lineItem.properties };
            delete lineItemProps[theme.cartStrings.giftWrapAttribute];

            let body = JSON.stringify({
              id: this.lineItem.variant_id,
              quantity: this.lineItem.quantity,
              properties: lineItemProps,
              sections: sectionsToBundle
            });

            fetch(theme.routes.cart_add_url, { ...theme.utils.fetchConfig('javascript'), body })
              .then((response) => response.json())
              .then(async (parsedState) => {
                const cartJson = await (await fetch(theme.routes.cart_url, { ...theme.utils.fetchConfig('json', 'GET')})).json();
                cartJson['sections'] = parsedState['sections'];
                theme.pubsub.publish(theme.pubsub.PUB_SUB_EVENTS.cartUpdate, { source: 'gift-wrap', cart: cartJson });
              });
          })
          .catch((error) => {
            console.error(error);
          });
      }
    }
  );
}

if (!customElements.get('gift-wrap-item')) {
  customElements.define(
    'gift-wrap-item',
    class GiftWrapItem extends HTMLElement {
      constructor() {
        super();
      }

      get sectionId() {
        return this.getAttribute('data-section-id');
      }

      get giftSection() {
        return this.closest('.cart__gift');
      }

      get lineItem() {
        const item = this.querySelector('script[type="application/json"][data-line-item]')?.textContent;
        return !!item ? JSON.parse(item) : {};
      }

      get giftItem() {
        const item = this.querySelector('script[type="application/json"][data-gift-item]')?.textContent;
        return !!item ? JSON.parse(item) : {};
      }

      connectedCallback() {
        const quantity = this.lineItem.quantity || 0;
        if (quantity !== this.giftItem.quantity) {
          this.updateGiftWrap(this.giftItem.key, quantity);
        }
      }

      updateGiftWrap(line, quantity) {
        this.enableLoading(line);

        let sectionsToBundle = [];
        document.documentElement.dispatchEvent(new CustomEvent('cart:bundled-sections', { bubbles: true, detail: { sections: sectionsToBundle } }));

        let body = JSON.stringify({
          id: line,
          quantity: quantity,
          sections: sectionsToBundle
        });

        fetch(theme.routes.cart_change_url, { ...theme.utils.fetchConfig(), ...{ body } })
          .then((response) => response.json())
          .then((parsedState) => {
            theme.pubsub.publish(theme.pubsub.PUB_SUB_EVENTS.cartUpdate, { source: 'gift-wrap', cart: parsedState });
          })
          .catch((error) => {
            console.error(error);
          });
      }

      enableLoading(line) {
        this.giftSection.classList.add('pointer-events-none');

        const loader = document.getElementById(`Loader-${this.sectionId}-${line}`);
        if (loader) loader.hidden = false;
      }
    }
  );
}

if (!customElements.get('unset-gift-wrap')) {
  customElements.define(
    'unset-gift-wrap',
    class UnsetGiftWrap extends HTMLAnchorElement {
      constructor() {
        super();

        this.addEventListener('click', this.onClick.bind(this));
      }

      get giftWrapItem() {
        return this.closest('gift-wrap-item');
      }

      onClick(event) {
        event.preventDefault();
        this.giftWrapItem.updateGiftWrap(this.getAttribute('data-index'), 0);
      }
    }, { extends: 'a' }
  );
}
