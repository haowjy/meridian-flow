(() => {
  for (const group of document.querySelectorAll("[data-mockup-group]")) {
    const grid = group.querySelector(".mockup-grid");
    for (const button of group.querySelectorAll("[data-view-button]")) {
      button.addEventListener("click", () => {
        grid.dataset.view = button.dataset.viewButton;
        for (const control of group.querySelectorAll("[data-view-button]"))
          control.setAttribute("aria-pressed", String(control === button));
      });
    }
  }
})();
