'use strict';
/**
 * Controle de acesso por módulo usando dados NATIVOS do usuário B1 (OUSR):
 *   - Superusuário do B1 vê todos os módulos habilitados na empresa
 *   - Demais: filtrados por Departamento do usuário e/ou código de usuário
 *
 * tenants.json:
 *   "modules": ["compras", "parceiros", "relatorios"],      // módulos contratados (padrão: todos)
 *   "moduleAccess": {
 *     "compras":   { "departments": [1, 2] },               // códigos de OUDP
 *     "parceiros": { "departments": [3], "users": ["gerente"] }
 *   }                                                       // módulo sem regra = todos os usuários
 */
function enabledModules(tenant, registry) {
  const allowed = Array.isArray(tenant.modules) ? tenant.modules : registry.map((m) => m.id);
  return registry.filter((m) => m.adminOnly || allowed.includes(m.id)); // Configurações sempre disponível
}

function canAccess(tenant, user, moduleId, mod) {
  if (user.superuser) return true;
  const rule = (tenant.moduleAccess || {})[moduleId];
  // Módulos administrativos: só superusuário do B1 ou usuários listados explicitamente
  if (mod && mod.adminOnly) return !!(rule && (rule.users || []).includes(user.userCode));
  if (!rule) return true;
  const deps = rule.departments || [];
  const users = rule.users || [];
  if (!deps.length && !users.length) return true;
  return deps.includes(user.department) || users.includes(user.userCode);
}

function modulesForUser(tenant, user, registry) {
  return enabledModules(tenant, registry).filter((m) => canAccess(tenant, user, m.id, m));
}

module.exports = { enabledModules, canAccess, modulesForUser };
