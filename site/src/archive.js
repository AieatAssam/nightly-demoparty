// Archive filters. Progressive enhancement: without this script the form stays hidden and every piece shows.
(() => {
  const form = document.getElementById("filters");
  const list = document.getElementById("archive-list");
  const none = document.getElementById("archive-none");
  if (!form || !list) return;
  const items = [...list.children];
  const apply = () => {
    const want = Object.fromEntries(new FormData(form));
    let shown = 0;
    for (const li of items) {
      const ok =
        (!want.compo || li.dataset.compo === want.compo) &&
        (!want.domain || li.dataset.domain === want.domain) &&
        (!want.mood || li.dataset.mood === want.mood) &&
        (!want.shelf || li.dataset.shelf === want.shelf) &&
        (!want.techniques || (li.dataset.techniques || "").split("|").includes(want.techniques));
      li.hidden = !ok;
      if (ok) shown++;
    }
    form.elements.count.value = `Showing ${shown} of ${items.length}`;
    if (none) none.hidden = shown > 0;
  };
  form.hidden = false;
  form.addEventListener("change", apply);
  form.addEventListener("submit", (e) => e.preventDefault());
})();
