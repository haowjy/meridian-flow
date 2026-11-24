(() => {
  const { createElement, Fragment } = globalThis.React;
  const jsx = (type, props, key) =>
    createElement(type, key === undefined ? props : { ...props, key });
  globalThis.jsxRuntime = { jsx, jsxs: jsx, Fragment };
})();
