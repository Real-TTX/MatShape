/* MatShape – the AI assistant of the editor: a panel at the right of the view. The person writes what they need ("a plate 80 × 40 × 6 with four holes of 6 mm"), the server asks the AI
   of the installation (POST /live/studios/{id}/ai with the Part Studio as it is), checks the answer and sends back the new content. The editor applies it as ONE step that can be undone,
   builds it, and when features of the answer do not build it sends their errors back for a repair (as often as the administrator allows). Everything shown is text (textContent). */

import { el, icon, request, t, toast } from './util.js';

export class Assistant {
  /**
   * host: { studioId(), content(), apply(content) -> before, statusOf(ids) -> [{id, name, message}], undo(before) -> bool, fit(), busy(on) }
   */
  constructor(panel, host) {
    this.panel = panel;
    this.host = host;
    this.log = panel.querySelector('[data-ai-log]');
    this.input = panel.querySelector('[data-ai-input]');
    this.send = panel.querySelector('[data-ai-send]');
    this.running = false;
    this.send.addEventListener('click', () => this.submit());
    this.input.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); this.submit(); }
    });
    panel.querySelectorAll('[data-ai-example]').forEach(b => b.addEventListener('click', () => { this.input.value = b.textContent; this.input.focus(); }));
  }

  open(on = this.panel.hidden) {
    this.panel.hidden = !on;
    document.getElementById('ms-studio')?.classList.toggle('is-ai', on);
    if (on) setTimeout(() => this.input.focus(), 30);
  }

  line(kind, text, extra) {
    const item = el('li', { class: 'ms-ai__msg ms-ai__msg--' + kind }, el('p', null, text), extra || null);
    this.log.append(item);
    this.log.querySelector('[data-ai-hello]')?.remove();
    item.scrollIntoView({ block: 'end', behavior: 'smooth' });
    return item;
  }

  thinking(text) {
    const item = el('li', { class: 'ms-ai__msg ms-ai__msg--busy' }, el('span', { class: 'mat-spinner', 'aria-hidden': 'true' }), el('p', null, text));
    this.log.append(item);
    item.scrollIntoView({ block: 'end' });
    return item;
  }

  async submit() {
    const prompt = this.input.value.trim();
    if (!prompt || this.running) return;
    this.input.value = '';
    this.line('user', prompt);
    this.running = true;
    this.send.disabled = true;
    this.host.busy(true);
    try {
      await this.run(prompt);
    } finally {
      this.running = false;
      this.send.disabled = false;
      this.host.busy(false);
      this.input.focus();
    }
  }

  async run(prompt) {
    let before = null;
    let errors = null;
    let tokens = 0;
    let changed = [];
    for (let round = 0; ; round++) {
      const busy = this.thinking(t(round ? 'Ai.Repairing' : 'Ai.Thinking'));
      let answer;
      try {
        answer = await request('POST', `/live/studios/${this.host.studioId()}/ai`, {
          prompt, content: this.host.content(), errors, language: document.documentElement.lang,
        });
      } catch (error) {
        busy.remove();
        const body = error.body || {};
        const settings = body.settingsUrl ? el('a', { class: 'ms-ai__link', href: body.settingsUrl }, icon('settings'), el('span', null, t('Ai.Settings'))) : null;
        this.line('error', body.error || t(error.status ? 'Ai.Failed' : 'Ai.Offline'), settings);
        return;
      }

      busy.remove();
      tokens += answer.tokens || 0;
      const applied = this.host.apply(answer.content);
      if (before === null) before = applied;
      changed = [...new Set([...changed, ...(answer.changed || [])])];
      const broken = this.host.statusOf(answer.changed || []);
      if (broken.length && round < (answer.repairRounds ?? 0)) {
        if (answer.message) this.line('ai', answer.message);
        errors = broken;
        continue;
      }

      this.host.fit();
      const undo = changed.length
        ? el('button', { type: 'button', class: 'mat-btn mat-btn--ghost mat-btn--sm' }, icon('undo'), el('span', null, t('Ai.Undo')))
        : null;
      const meta = el('div', { class: 'ms-ai__meta' },
        el('span', { class: 'mat-pill mat-pill--plain' }, t('Ai.Changed', changed.length)),
        el('span', { class: 'ms-ai__tokens mat-mono' }, t('Ai.Tokens', tokens.toLocaleString(document.documentElement.lang))),
        undo);
      const item = this.line('ai', answer.message || t('Ai.Done'), meta);
      if (broken.length) item.append(el('p', { class: 'ms-ai__warn' }, icon('alert'), ' ', t('Ai.StillBroken', broken.map(b => b.name || b.id).join(', '))));
      undo?.addEventListener('click', () => {
        if (this.host.undo(before)) { undo.disabled = true; undo.querySelector('span').textContent = t('Ai.Undone'); }
        else toast(t('Ai.CannotUndo'), 'warning');
      });
      return;
    }
  }
}
