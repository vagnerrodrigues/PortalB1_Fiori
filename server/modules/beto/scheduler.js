'use strict';
/**
 * Agenda do Beto (no mesmo processo do portal — decisão D6 do documento de arquitetura).
 * Por empresa: config "schedule" = { enabled, time: "HH:MM" } no repositório do Beto. Padrão: desligado.
 * Verifica a cada minuto; roda no máximo uma vez por dia por empresa.
 */
const repoOf = require('./repo').forTenant;
const runner = require('./runner');

const DEFAULT = { enabled: false, time: '06:00' };
let timer = null;

function scheduleOf(tenantId) { return { ...DEFAULT, ...(repoOf(tenantId).getConfig('schedule', DEFAULT) || {}) }; }

function due(sched, lastDay, d = new Date()) {
  if (!sched.enabled) return false;
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const day = d.toISOString().slice(0, 10);
  return hhmm >= sched.time && lastDay !== day;
}

function start({ tenants, isEnabled, mock }) {
  if (timer || process.env.BETO_SCHEDULER === '0') return;
  timer = setInterval(() => {
    tenants.filter(isEnabled).forEach((t) => {
      try {
        const repo = repoOf(t.id);
        const sched = scheduleOf(t.id);
        const lastDay = repo.getConfig('schedule.lastDay', null);
        if (!due(sched, lastDay) || runner.isRunning(t.id)) return;
        repo.setConfig('schedule.lastDay', new Date().toISOString().slice(0, 10), 'beto');
        runner.run(t, { trigger: 'agendado', mock }).catch((e) => console.error('[beto] execução agendada falhou:', t.id, e.message));
      } catch (e) { console.error('[beto] agenda:', t.id, e.message); }
    });
  }, 60000);
  timer.unref();
}

module.exports = { start, scheduleOf, due, DEFAULT };
