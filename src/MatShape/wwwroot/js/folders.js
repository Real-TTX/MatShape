/* MatShape – filing models in folders by dragging (the list of models).
   A model (tile or row: data-drag-model) or a folder (data-drag-folder) is dragged onto a folder (data-drop-folder) or onto a folder of the path in the top bar
   (its links /Models and /Models?folder=<id>); the hidden form of the page (data-drop-form, handler Drop) is filled in and sent, the server files it and shows
   the list again. Without dragging (keyboard, phone) the action "Move to a folder" of a row does the same. */
(function () {
  'use strict';
  var form = document.querySelector('[data-drop-form]');
  if (!form) { return; }
  var TYPE = 'application/x-matshape-item';
  var dragged = null;

  /** The folder a drop target stands for: an id, '' for the top, or null when it is no target. */
  function targetOf(el) {
    var drop = el.closest('[data-drop-folder]');
    if (drop) { return drop.getAttribute('data-drop-folder') || ''; }
    var link = el.closest('.mat-crumbs a[href]');
    if (!link) { return null; }
    var url = new URL(link.getAttribute('href'), location.origin);
    if (url.pathname !== '/Models') { return null; }
    return url.searchParams.get('folder') || '';
  }

  function holderOf(el) { return el.closest('[data-drop-folder]') || el.closest('.mat-crumbs a[href]'); }

  document.addEventListener('dragstart', function (e) {
    var source = e.target.closest && e.target.closest('[data-drag-model], [data-drag-folder]');
    if (!source) { return; }
    dragged = source.hasAttribute('data-drag-folder')
      ? { kind: 'folder', id: source.getAttribute('data-drag-folder') }
      : { kind: 'model', id: source.getAttribute('data-drag-model') };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData(TYPE, JSON.stringify(dragged));
    document.body.classList.add('ms-dragging');
  });

  document.addEventListener('dragend', function () {
    dragged = null;
    document.body.classList.remove('ms-dragging');
    document.querySelectorAll('.ms-drop-over').forEach(function (el) { el.classList.remove('ms-drop-over'); });
  });

  document.addEventListener('dragover', function (e) {
    if (!dragged || !e.target.closest) { return; }
    var target = targetOf(e.target);
    if (target === null || (dragged.kind === 'folder' && target === dragged.id)) { return; }
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    var holder = holderOf(e.target);
    if (holder && !holder.classList.contains('ms-drop-over')) {
      document.querySelectorAll('.ms-drop-over').forEach(function (el) { el.classList.remove('ms-drop-over'); });
      holder.classList.add('ms-drop-over');
    }
  });

  document.addEventListener('dragleave', function (e) {
    var holder = e.target.closest && holderOf(e.target);
    if (holder && !holder.contains(e.relatedTarget)) { holder.classList.remove('ms-drop-over'); }
  });

  document.addEventListener('drop', function (e) {
    if (!dragged || !e.target.closest) { return; }
    var target = targetOf(e.target);
    if (target === null || (dragged.kind === 'folder' && target === dragged.id)) { return; }
    e.preventDefault();
    form.elements.kind.value = dragged.kind;
    form.elements.id.value = dragged.id;
    form.elements.target.value = target;
    form.submit();
  });
})();
