/* MatShape – the page of an AI profile: a template fills the address, "Load models" asks the provider (GET /models through the server; a key typed here goes as a header, never in the
   address), the list can be narrowed to the free models (OpenRouter says which are free) and by text, a click takes a model. While a ChatGPT sign-in waits for its code, the page asks now and then.
   Texts come from the catalog (Js.Ai.*); nothing is put in as HTML. */
(function () {
  'use strict';

  var doc = document;
  var $ = function (sel, scope) { return (scope || doc).querySelector(sel); };
  var texts = (function () { try { return JSON.parse(doc.getElementById('ms-texts').textContent); } catch (e) { return {}; } })();
  var t = function (key) { var s = texts['Js.' + key] || key; for (var i = 1; i < arguments.length; i++) { s = s.replace('{' + (i - 1) + '}', arguments[i]); } return s; };
  var toast = function (message, tone) { if (window.MatUi && window.MatUi.toast) { window.MatUi.toast(message, { tone: tone || 'danger' }); } };

  var form = $('[data-ai-profile]');
  if (form) {
    var preset = $('[data-ai-preset]', form);
    var url = doc.getElementById('BaseUrl');
    var model = $('[data-ai-model]', form);
    var key = doc.getElementById('ApiKey');
    var list = $('[data-ai-models-list]', form);
    var datalist = doc.getElementById('ai-models');
    var info = $('[data-ai-models-info]', form);
    var freeWrap = $('[data-ai-free-wrap]', form);
    var freeOnly = $('[data-ai-free-only]', form);
    var filter = $('[data-ai-models-filter]', form);
    var models = [];

    if (preset && url) {
      preset.addEventListener('change', function () {
        var option = preset.options[preset.selectedIndex];
        url.value = option.getAttribute('data-url') || '';
        if (model && option.getAttribute('data-model')) { model.value = option.getAttribute('data-model'); }
        if (option.value === 'custom') { url.focus(); }
      });
    }

    var provider = function () {
      var checked = form.querySelector('input[name="Provider"]:checked');
      return checked ? checked.value : 'OpenAiCompatible';
    };

    var render = function () {
      var free = models.filter(function (m) { return m.free; }).length;
      var text = (filter.value || '').trim().toLowerCase();
      var shown = models.filter(function (m) {
        if (freeOnly.checked && !m.free) { return false; }
        return !text || m.id.toLowerCase().indexOf(text) >= 0 || (m.name || '').toLowerCase().indexOf(text) >= 0;
      });
      list.textContent = '';
      shown.slice(0, 120).forEach(function (m) {
        var li = doc.createElement('li');
        var b = doc.createElement('button');
        b.type = 'button';
        b.className = 'ms-model' + (m.id === model.value ? ' is-current' : '');
        var name = doc.createElement('span');
        name.className = 'mat-mono';
        name.textContent = m.id;
        b.appendChild(name);
        if (m.free) {
          var pill = doc.createElement('span');
          pill.className = 'mat-pill mat-pill--ok';
          pill.textContent = t('Ai.Free');
          b.appendChild(pill);
        }
        b.addEventListener('click', function () { model.value = m.id; render(); });
        li.appendChild(b);
        list.appendChild(li);
      });
      info.textContent = t('Ai.ModelsFound', models.length, free) + (shown.length > 120 ? ' ' + t('Ai.ModelsMore', shown.length - 120) : '');
      freeWrap.hidden = free === 0;
      filter.hidden = models.length < 8;
    };

    var load = $('[data-ai-load-models]', form);
    if (load) {
      load.addEventListener('click', function () {
        var id = form.getAttribute('data-profile-id') || '';
        var query = '?provider=' + encodeURIComponent(provider()) + (id ? '&id=' + encodeURIComponent(id) : '') + (url && url.value && provider() === 'OpenAiCompatible' ? '&baseUrl=' + encodeURIComponent(url.value) : '');
        load.disabled = true;
        info.textContent = t('Ai.ModelsAsking');
        fetch('/live/ai/models' + query, { credentials: 'same-origin', cache: 'no-store', headers: key && key.value ? { 'X-Ai-Key': key.value } : {} })
          .then(function (r) { if (!r.ok) { throw new Error('HTTP ' + r.status); } return r.json(); })
          .then(function (data) {
            if (data.error) { info.textContent = data.error; toast(data.error); return; }
            models = data.models || [];
            datalist.textContent = '';
            models.forEach(function (m) { var o = doc.createElement('option'); o.value = m.id; if (m.name && m.name !== m.id) { o.label = m.name; } datalist.appendChild(o); });
            // OpenRouter: the free ones first in view when there are many
            if (models.some(function (m) { return m.free; }) && ((preset && preset.value === 'openrouter') || (url.value || '').indexOf('openrouter') >= 0)) { freeOnly.checked = true; }
            render();
          })
          .catch(function () { info.textContent = t('Ai.ModelsFailed'); toast(t('Ai.ModelsFailed')); })
          .then(function () { load.disabled = false; });
      });
      freeOnly.addEventListener('change', render);
      filter.addEventListener('input', render);
    }
  }

  // while a ChatGPT code waits: ask every few seconds (the server asks OpenAI at most once per interval)
  var poll = $('[data-chatgpt-poll]');
  if (poll) {
    var state = $('[data-chatgpt-state]', poll);
    var tries = 0;
    var timer = setInterval(function () {
      if (doc.hidden || !navigator.onLine) { return; }
      if (++tries > 200) { clearInterval(timer); return; }
      fetch(poll.getAttribute('data-chatgpt-poll'), { credentials: 'same-origin', cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (s) {
          if (!s) { return; }
          if (s.connected) { clearInterval(timer); location.reload(); return; }
          if (!s.pending) { clearInterval(timer); if (state) { state.textContent = s.loginError || state.getAttribute('data-done'); } setTimeout(function () { location.reload(); }, 1500); }
        })
        .catch(function () { });
    }, 3000);
  }
})();
