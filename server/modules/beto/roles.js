'use strict';
/**
 * Perfis do Beto (tenants.json -> moduleAccess.beto):
 *   "beto": { "departments": [...], "users": [...],          // quem vê o módulo (regra padrão do portal)
 *             "deciders": { "departments": [], "users": [] }, // quem aceita/rejeita/adia recomendações
 *             "admins":   { "departments": [], "users": [] } } // quem configura skills e executa manualmente
 * Superusuário do B1 = admin. Sem "deciders" configurado, só superusuário e admins decidem.
 */
const access = require('../../core/access');

const match = (rule, user) => !!rule && ((rule.departments || []).includes(user.department) || (rule.users || []).includes(user.userCode));

function rolesOf(tenant, user) {
  const acc = (tenant.moduleAccess || {}).beto || {};
  const admin = !!user.superuser || match(acc.admins, user);
  const decider = admin || match(acc.deciders, user);
  return {
    viewer: true, decider, admin,
    buyer: access.canTile(tenant, user, 'compras', { buyer: true }),
    receiver: access.canTile(tenant, user, 'compras', { receiver: true })
  };
}

/** Quem vê cada recomendação, pelo público dela. */
function canSee(roles, audience) {
  if (roles.admin || audience === 'todos') return true;
  if (audience === 'comprador') return roles.buyer;
  if (audience === 'recebedor') return roles.receiver;
  if (audience === 'gestor') return roles.decider;
  return false;
}

module.exports = { rolesOf, canSee };
