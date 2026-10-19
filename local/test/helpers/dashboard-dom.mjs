// A small DOM host for Preact rendering tests. Native disclosure/keyboard behavior is verified in the browser.
// No component, hook, or event handler is mocked.
class Node {
  constructor(localName, data) {
    this.localName = localName;
    this.nodeType = localName ? 1 : 3;
    this.data = data;
    this.childNodes = [];
    this.parentNode = null;
    this.attrs = {};
    this.listeners = {};
    this.style = { setProperty() {} };
  }
  get firstChild() { return this.childNodes[0] ?? null; }
  get nextSibling() {
    const siblings = this.parentNode?.childNodes ?? [];
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }
  get textContent() { return this.nodeType === 3 ? this.data : this.childNodes.map((node) => node.textContent).join(""); }
  get attributes() { return Object.entries(this.attrs).map(([name, value]) => ({ name, value })); }
  appendChild(node) { return this.insertBefore(node, null); }
  insertBefore(node, before) {
    node.parentNode?.removeChild(node);
    const index = before === null ? -1 : this.childNodes.indexOf(before);
    this.childNodes.splice(index < 0 ? this.childNodes.length : index, 0, node);
    node.parentNode = this;
    return node;
  }
  removeChild(node) {
    this.childNodes.splice(this.childNodes.indexOf(node), 1);
    node.parentNode = null;
    return node;
  }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  removeAttribute(name) { delete this.attrs[name]; }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  removeEventListener(name) { delete this.listeners[name]; }
  focus() { this.focused = true; }
  querySelector(name) { return descendants(this).find((node) => node.localName === name) ?? null; }
}

export function descendants(node) {
  return [node, ...node.childNodes.flatMap(descendants)];
}

export function installDom() {
  const roots = [];
  globalThis.document = {
    createElement: (name) => new Node(name),
    createElementNS: (_ns, name) => new Node(name),
    createTextNode: (data) => new Node(null, data),
    getElementById: (id) => roots.flatMap(descendants).find((node) => node.attrs.id === id) ?? null,
  };
  globalThis.HTMLDetailsElement = Node;
  return () => {
    const root = new Node("div");
    roots.push(root);
    return root;
  };
}
